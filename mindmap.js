// 思维导图渲染页：从 storage.session 读 markmap markdown（MINDMAP_READY/OPEN 时 background 写入），
// 内置轻量解析器转树 {content, children[]}（markmap-view 只接受树对象，不接受 markdown），
// 用 d3 + markmap-view 渲染到全屏 svg。
// 功能：分支色块样式、日/夜模式、节点行内编辑（contenteditable）、撤销重做、导出 PNG/SVG、
// 编辑结果 localStorage 缓存（按原始 markdown 的 hash 键控，可一键还原）。
// popup 模式（mindmap.html?popup=1，B 站面板入口开的小窗）：只读查看，编辑交互全禁用、
// 不写编辑缓存；保留导航/折叠/导出/日夜切换，工具栏提供「✏️ 去编辑」开完整页。
const TAG = '[bili-gemini:mindmap]';

const isPopup = new URLSearchParams(location.search).has('popup');

// ---- 调色板：B 站品牌色基底（粉/蓝）+ 柔和绿/橙/紫/青；夜间调亮调饱和保证白字可读 ----
const PALETTES = {
  light: { root: '#5B6B8C', branches: ['#F2708A', '#4FB3D9', '#66BB6A', '#FFA940', '#9C7FB8', '#4DB6AC'] },
  dark:  { root: '#7C93C4', branches: ['#FB7299', '#00A1D6', '#4CAF50', '#FF9800', '#B39DDB', '#26C6DA'] },
};

// ---- markdown → markmap 树（markmap-view walkTree 期望 {content, children[]}）----
// # 数量定层级；- 行作为当前最深标题的子叶；忽略空行。无标题结构返回 null。
function parseMarkdown(md) {
  const root = { content: '', children: [] };
  const stack = [{ depth: 0, node: root }];
  let hasHeading = false;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      hasHeading = true;
      const depth = h[1].length;
      const node = { content: h[2].trim(), children: [] };
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
      stack[stack.length - 1].node.children.push(node);
      stack.push({ depth, node });
      continue;
    }
    const li = line.match(/^[-*+]\s+(.+)$/);
    if (li && stack.length > 1) {
      stack[stack.length - 1].node.children.push({ content: li[1].trim(), children: [] });
    }
  }
  if (!hasHeading || !root.children.length) return null;
  return root.children.length === 1 ? root.children[0] : { content: '思维导图', children: root.children };
}

// markmap 的 state.path 形如 "1.3.5"（先序编号），前两段 = 根下的一级分支 = 分支锚点
function branchKeyOfPath(path) {
  const seg = String(path).split('.');
  return seg.slice(0, 2).join('.');
}
// 分支 → 调色板下标的稳定映射（按出现顺序分配），每次 setData 前重置
const branchIndex = new Map();
let branchSeq = 0;
function colorOfPath(path) {
  const pal = PALETTES[theme];
  if (!String(path).includes('.')) return pal.root; // 根节点
  const key = branchKeyOfPath(path);
  if (!branchIndex.has(key)) branchIndex.set(key, branchSeq++);
  return pal.branches[branchIndex.get(key) % pal.branches.length];
}

// 与 markmap _initializeData 相同的先序编号，重建 path ↔ 节点 映射（编辑/导航操作用）
// 注意：markmap setData(data) 的 _initializeData 会把每个节点的 children 原地替换成
// 浅拷贝数组（item.children = item.children.map(c => ({...c})))，渲染后旧节点对象即
// 失效（孤儿引用）。pathMap 总在 setData 后重建所以内部引用一致；但 addChild/addSibling
// 手里持有的新建节点在 rerender 后同样被克隆顶掉，引用比对必然落空，故新增节点带 uid，
// 定位时优先按 uid 匹配（浅拷贝 {...c} 会带上 uid）。
let pathMap = new Map(); // path -> node
function rebuildPathMap(tree) {
  pathMap = new Map();
  let id = 0;
  (function walk(node, parentPath) {
    id += 1;
    const path = parentPath ? `${parentPath}.${id}` : `${id}`;
    pathMap.set(path, node);
    (node.children || []).forEach(c => walk(c, path));
  })(tree, '');
}
function nextUid() {
  return (crypto.randomUUID && crypto.randomUUID()) || `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
function pathOfNode(node) {
  for (const [p, n] of pathMap) {
    if (n === node || (node.uid && n.uid === node.uid)) return p;
  }
  return null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function decodeHtml(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

// ================= 页面状态 =================
let theme = 'light';
let tree = null;
let mm = null;
let selectedPath = null;
let videoTitle = '';
let originalMarkdown = '';
let editCacheKey = ''; // localStorage key：原始 markdown 的 hash

const svg = document.getElementById('mm');

function applyTheme() {
  document.body.classList.toggle('dark', theme === 'dark');
  document.getElementById('theme').textContent = theme === 'dark' ? '☀️' : '🌙';
}
function setTheme(t) {
  theme = t;
  try { localStorage.setItem('biliGeminiMindmapTheme', t); } catch (e) { /* 无痕模式等 */ }
  applyTheme();
  // 触发重渲染，连线/节点按新调色板重着色（styleNodes 由 observer 补）。
  // setData 的 _initializeData 会同步把 children 浅拷贝顶掉（见 rebuildPathMap 注释），
  // 必须同步重建 pathMap，否则之后编辑/增删拿到的是孤儿节点，改动会丢。
  if (mm && tree) { mm.setData(tree); rebuildPathMap(tree); }
}

// 给每个节点 g 元素按 data-path 挂 --branch-color（CSS 负责色块填充）；
// 顺带按 selectedPath 补挂选中属性——节点 g 被 markmap 重建（增删节点导致 exit/enter）
// 后自定义属性会丢，这里兜住。markmap 重渲染只重置 class/几何属性，不碰 data-mm-selected。
// 选中属性只挂 nodeG 返回的活节点：退出过渡中的旧 g 可能同 data-path 短暂共存（见 nodeG 注释）。
function styleNodes() {
  const selG = nodeG(selectedPath);
  for (const g of svg.querySelectorAll('g.markmap-node')) {
    g.style.setProperty('--branch-color', colorOfPath(g.getAttribute('data-path') || ''));
    g.toggleAttribute('data-mm-selected', g === selG);
  }
}
// markmap 折叠/展开/重渲染会重建 DOM，observer 兜底补挂颜色；行内编辑中整体跳过，不碰编辑节点
let styleTimer = null;
new MutationObserver(() => {
  if (styleTimer || editingEl) return;
  styleTimer = setTimeout(() => { styleTimer = null; styleNodes(); }, 50);
}).observe(svg, { childList: true, subtree: true });

// ================= 编辑缓存（localStorage，按原始 markdown hash 键控） =================
function hashStr(s) { // djb2，足够做缓存 key
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function hasEditCache() {
  try { return localStorage.getItem(editCacheKey) !== null; } catch (e) { return false; }
}
function updateRestoreBtn() {
  document.getElementById('restore').style.display = hasEditCache() ? '' : 'none';
}
// 每次内容变更后落一份整树快照；折叠状态也顺带记住。还原原始内容时清掉。
// popup 只读模式不写缓存（避免和完整页缓存互相覆盖）。
function persistEdit() {
  if (isPopup) return;
  try { localStorage.setItem(editCacheKey, JSON.stringify(tree)); } catch (e) { /* 存储满/无痕模式 */ }
  updateRestoreBtn();
}
function loadEditCache() {
  try {
    const raw = localStorage.getItem(editCacheKey);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (t && typeof t.content === 'string' && Array.isArray(t.children)) return t;
  } catch (e) { /* 坏缓存当没有 */ }
  return null;
}

// ================= 撤销/重做（树快照栈） =================
const undoStack = [], redoStack = [];
const UNDO_CAP = 50;
function pushUndo() { // 内容变更前调用；折叠等视图操作不进撤销栈
  undoStack.push(structuredClone(tree));
  if (undoStack.length > UNDO_CAP) undoStack.shift();
  redoStack.length = 0;
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(structuredClone(tree));
  tree = undoStack.pop();
  selectPath(null);
  persistEdit();
  rerender();
  console.log(TAG, '撤销，剩余可撤销', undoStack.length);
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(structuredClone(tree));
  tree = redoStack.pop();
  selectPath(null);
  persistEdit();
  rerender();
  console.log(TAG, '重做，剩余可重做', redoStack.length);
}

// ================= 选择与编辑 =================
// 取 path 对应的节点 g。注意 markmap 的 exit 移除是 d3 计时器异步调度的（duration=0 也要等下一帧），
// 增删节点导致后续节点 path 位移时，旧 path 的退出 g 与新 g 会短暂同 data-path 共存；
// enter 的 g 总是 append 在容器末尾，故同 path 重复时取最后一个（最新 enter 的活节点），
// 取第一个会命中显示旧兄弟内容的退出 g——编辑框/选中框会打错节点（实测：新节点提交进下面兄弟的文字）。
function nodeG(path) {
  if (!path) return null;
  const all = svg.querySelectorAll(`g.markmap-node[data-path="${path}"]`);
  return all.length ? all[all.length - 1] : null;
}
function selectPath(path) {
  for (const old of svg.querySelectorAll('g.markmap-node[data-mm-selected]')) old.removeAttribute('data-mm-selected');
  selectedPath = path && pathMap.has(path) ? path : null;
  const g = nodeG(selectedPath);
  if (g) g.setAttribute('data-mm-selected', '');
  const has = !!selectedPath;
  document.getElementById('edit').disabled = !has;
  document.getElementById('addsib').disabled = !has;
  document.getElementById('add').disabled = !has;
  document.getElementById('del').disabled = !has || !selectedPath.includes('.'); // 根不可删
}
function rerender(after) {
  branchIndex.clear();
  branchSeq = 0;
  // 编辑重渲染关掉过渡动画：markmap 按 state.key（先序编号 path）做节点 identity，
  // 增删节点会让后续节点 path 位移、被当成 exit/enter 重放动画（用户看到的「一片闪动」）。
  // 动画对编辑场景没有价值，关掉后只有受影响节点变化；setData 完成后恢复 duration，fit 仍平滑。
  const d = mm.options.duration;
  mm.options.duration = 0;
  Promise.resolve(mm.setData(tree)).then(() => {
    mm.options.duration = d;
    rebuildPathMap(tree);
    mm.fit();
    if (after) after();
  });
}

// 新增节点进编辑的时序保障：setData 的 promise 不代表过渡动画结束/节点 DOM 稳定
// （enter 节点从 opacity 0 起步，动画途中 focus 可能失败），短轮询等节点真实出现再开编辑。
function openEditorWhenReady(node, tries = 20) {
  const attempt = () => {
    const path = pathOfNode(node);
    const g = path && nodeG(path);
    if (g && g.querySelector('.markmap-foreign > div > div')) {
      selectPath(path);
      openEditor();
    } else if (tries-- > 0) setTimeout(attempt, 50);
  };
  attempt();
}

svg.addEventListener('click', e => {
  const g = e.target && e.target.closest && e.target.closest('g.markmap-node');
  selectPath(g ? g.getAttribute('data-path') : null);
});
// 捕获阶段：markmap 对 foreignObject 的 dblclick 做了 stopPropagation，bubble 阶段收不到
svg.addEventListener('dblclick', e => {
  if (isPopup) return; // 只读小窗不提供编辑
  const g = e.target && e.target.closest && e.target.closest('g.markmap-node');
  if (!g) return;
  selectPath(g.getAttribute('data-path'));
  openEditor();
}, true);

// 行内编辑：直接在节点色块内 contenteditable 改字。Enter/blur 提交（更新树→rerender），
// Esc 取消（恢复原 innerHTML，不重渲染）。编辑期间绝不 rerender（markmap 重建 DOM 会杀掉编辑态），
// observer 的 styleNodes 在编辑中整体跳过（见上方 MutationObserver）。
// 空节点语义（Enter/Tab 新建的就是空节点）：提交时仍为空 → 删除该节点，不留空壳；
// 新建节点按 Esc 取消 → 同样删除（添加时的 pushUndo 已让撤销链完整，此处不再重复入栈）；
// 已有节点被清空后提交空 → 也按删除处理（先入撤销栈）。
let editingEl = null;
function openEditor() {
  if (isPopup) return;
  const node = pathMap.get(selectedPath);
  const g = nodeG(selectedPath);
  if (!node || !g || editingEl) return;
  const inner = g.querySelector('.markmap-foreign > div > div');
  if (!inner) return;
  editingEl = inner;
  const origHtml = inner.innerHTML;
  const origText = decodeHtml(node.content);
  inner.contentEditable = 'true';
  inner.focus();
  const range = document.createRange(); // 全选文本，直接覆盖输入
  range.selectNodeContents(inner);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  let done = false;
  const finish = ok => {
    if (done) return;
    done = true;
    const v = inner.textContent.trim();
    inner.removeAttribute('contenteditable');
    editingEl = null;
    sel.removeAllRanges();
    if (!ok) { // Esc 取消
      if (!origText) { removeNode(selectedPath); return; } // 新建空节点：取消即删除
      inner.innerHTML = origHtml; return; // 已有节点：原样恢复，不重渲染
    }
    if (!v) { // 提交为空：删除该节点，不留空壳
      if (origText) pushUndo(); // 已有节点被清空，入撤销栈；新建节点在添加时已入栈
      console.log(TAG, '空内容提交，删除节点:', selectedPath);
      removeNode(selectedPath);
      return;
    }
    if (v !== origText) {
      pushUndo();
      node.content = escapeHtml(v); // 转义防注入（markmap 用 innerHTML 注入 content）
      persistEdit();
      console.log(TAG, '节点已修改:', selectedPath, '=>', v);
      rerender(() => selectPath(selectedPath));
    }
  };
  inner.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation(); // 编辑中全局快捷键让位
  });
  inner.addEventListener('blur', () => finish(true));
}

function addChild() {
  if (isPopup) return; // 只读小窗
  const parent = pathMap.get(selectedPath);
  if (!parent) return;
  pushUndo();
  parent.children = parent.children || [];
  const child = { content: '', children: [], uid: nextUid() }; // 空节点，进编辑态直接输入
  parent.children.push(child);
  if (parent.payload) delete parent.payload.fold; // 父节点若折叠着，展开让新节点可见
  persistEdit();
  rerender(() => openEditorWhenReady(child));
}

// Enter：在当前节点之后插入同级；根节点没有同级，退化为加子级
function addSibling() {
  if (isPopup) return;
  const parentPath = selectedPath.split('.').slice(0, -1).join('.');
  const parent = pathMap.get(parentPath);
  const cur = pathMap.get(selectedPath);
  if (!parent || !cur) return addChild(); // 根节点
  pushUndo();
  const node = { content: '', children: [], uid: nextUid() }; // 空节点，进编辑态直接输入
  parent.children.splice(parent.children.indexOf(cur) + 1, 0, node);
  persistEdit();
  rerender(() => openEditorWhenReady(node));
}

// 无确认删除指定路径节点（工具栏/快捷键删除、空节点提交或取消的清理共用）。根节点不可删。
// 撤销栈由调用方按场景入栈：deleteSelected 自己 pushUndo；新建空节点清理依赖添加时的那次入栈。
function removeNode(path) {
  const node = path && pathMap.get(path);
  if (!node || !path.includes('.')) return;
  const parentPath = path.split('.').slice(0, -1).join('.');
  const parent = pathMap.get(parentPath);
  if (!parent) return;
  parent.children = (parent.children || []).filter(c => c !== node && (!node.uid || c.uid !== node.uid));
  persistEdit();
  rerender(() => selectPath(parentPath)); // 删除后选中父节点（焦点流）
}

function deleteSelected() {
  if (isPopup) return;
  if (!selectedPath || !selectedPath.includes('.')) return; // 根不可删
  pushUndo(); // 选中即删（有 Ctrl+Z 兜底，不再弹确认）
  console.log(TAG, '节点已删除:', selectedPath);
  removeNode(selectedPath);
}

// 选中节点按 - 折叠/展开（视图操作，不进撤销栈，但随编辑缓存持久化）
function toggleFold() {
  const node = pathMap.get(selectedPath);
  if (!node || !(node.children || []).length) return;
  node.payload = node.payload || {};
  node.payload.fold = node.payload.fold ? 0 : 1;
  persistEdit();
  rerender(() => selectPath(selectedPath));
}

// 方向键导航：← 父、→ 第一个子（折叠则先展开）、↑↓ 同级；出视口则 fit 兜底
function navigate(key) {
  const node = pathMap.get(selectedPath);
  if (!node) return;
  let target = null;
  if (key === 'ArrowLeft') {
    target = selectedPath.includes('.') ? selectedPath.split('.').slice(0, -1).join('.') : null;
  } else if (key === 'ArrowRight') {
    if (node.payload && node.payload.fold) { toggleFold(); return; }
    const kids = node.children || [];
    if (kids.length) target = pathOfNode(kids[0]);
  } else {
    const parent = pathMap.get(selectedPath.split('.').slice(0, -1).join('.'));
    if (!parent) return;
    const idx = parent.children.indexOf(node);
    const next = key === 'ArrowUp' ? idx - 1 : idx + 1;
    if (next < 0 || next >= parent.children.length) return;
    target = pathOfNode(parent.children[next]);
  }
  if (!target) return;
  selectPath(target);
  const g = nodeG(target);
  if (g) {
    const r = g.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) mm.fit();
  }
}

document.getElementById('edit').addEventListener('click', openEditor);
document.getElementById('addsib').addEventListener('click', addSibling);
document.getElementById('add').addEventListener('click', addChild);
document.getElementById('del').addEventListener('click', deleteSelected);
document.getElementById('refit').addEventListener('click', () => mm && mm.fit());
document.getElementById('theme').addEventListener('click', () => setTheme(theme === 'dark' ? 'light' : 'dark'));
document.getElementById('restore').addEventListener('click', () => {
  if (!confirm('放弃所有编辑，还原为 Gemini 生成的原始思维导图？')) return;
  try { localStorage.removeItem(editCacheKey); } catch (e) { /* 忽略 */ }
  tree = parseMarkdown(originalMarkdown);
  undoStack.length = 0;
  redoStack.length = 0;
  selectPath(null);
  rerender();
  updateRestoreBtn();
  console.log(TAG, '已还原原始内容');
});

// 快捷键（XMind 式）：Enter 加同级、Tab 加子级、F2/Space 编辑、Delete 删除、
// - 折叠、方向键导航、Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 撤销重做。
// 行内编辑激活时全局快捷键全让位（编辑格内 Enter=提交、Esc=取消，互不冲突）。
// popup 只读模式：编辑类快捷键不进，保留撤销重做无意义也一并关掉，只留导航/折叠。
document.addEventListener('keydown', e => {
  if (editingEl) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!isPopup) {
    if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
    if ((mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) || (mod && (e.key === 'y' || e.key === 'Y'))) {
      e.preventDefault(); redo(); return;
    }
  }
  if (!selectedPath) return;
  if (!isPopup && e.key === 'Enter') { e.preventDefault(); addSibling(); }
  else if (!isPopup && (e.key === 'F2' || e.key === ' ')) { e.preventDefault(); openEditor(); }
  else if (!isPopup && e.key === 'Tab') { e.preventDefault(); addChild(); }
  else if (!isPopup && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); deleteSelected(); }
  else if (e.key === '-') { e.preventDefault(); toggleFold(); }
  else if (e.key.startsWith('Arrow')) { e.preventDefault(); navigate(e.key); }
});

// popup 只读模式：隐藏编辑类按钮，显示「✏️ 去编辑」（完整页 tab）
if (isPopup) {
  for (const id of ['edit', 'addsib', 'add', 'del', 'restore']) {
    document.getElementById(id).style.display = 'none';
  }
  const fp = document.getElementById('fullpage');
  fp.style.display = '';
  fp.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('mindmap.html') }));
}

// 快捷键说明面板：左上角小字半透明，点击收起/展开
(function initHelp() {
  const FULL = ['方向键：导航', 'Enter：加同级', 'Tab：加子级', 'F2 / 双击 / Space：编辑',
    'Delete：删除', 'Ctrl+Z / Ctrl+Y：撤销重做', '-：折叠/展开'];
  const VIEW = ['方向键：导航', '-：折叠/展开', '拖动 / 滚轮：平移缩放'];
  const help = document.getElementById('help');
  help.querySelector('.help-list').innerHTML = (isPopup ? VIEW : FULL).map(escapeHtml).join('<br>');
  help.addEventListener('click', () => help.classList.toggle('collapsed'));
})();

// ================= 导出 PNG / SVG =================
// markmap 节点是 foreignObject（markmap 已给内层 div 加 xmlns:xhtml），无外链资源，
// 直接序列化整个 svg（含我们的样式表和背景色 rect），PNG 走 data URL → canvas 2x。
async function serializeSvg() {
  await mm.fit(); // 导出前先收拢到可视区，所见即所得
  const rect = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true);
  const style = document.createElement('style');
  style.textContent = document.getElementById('mindmap-style').textContent;
  clone.insertBefore(style, clone.firstChild);
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', getComputedStyle(document.body).getPropertyValue('--mm-bg').trim()
    || (theme === 'dark' ? '#18191c' : '#f5f6f7')); // 带背景色导出，避免透明底变黑
  clone.insertBefore(bg, style.nextSibling);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', Math.ceil(rect.width));
  clone.setAttribute('height', Math.ceil(rect.height));
  return { xml: new XMLSerializer().serializeToString(clone), rect };
}
function download(url, ext) {
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(videoTitle || '思维导图').replace(/[\\/:*?"<>|]/g, '_')}思维导图.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function exportPng() {
  if (!mm) return;
  const { xml, rect } = await serializeSvg();
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  await img.decode();
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(rect.width * scale);
  canvas.height = Math.ceil(rect.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height); // 背景已在 svg 里
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  if (!blob) { console.warn(TAG, '导出 PNG 失败: canvas.toBlob 返回 null'); return; }
  download(URL.createObjectURL(blob), 'png');
  console.log(TAG, '已导出 PNG, 尺寸 =', canvas.width, 'x', canvas.height);
}
async function exportSvg() {
  if (!mm) return;
  const { xml } = await serializeSvg();
  download(URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' })), 'svg');
  console.log(TAG, '已导出 SVG');
}
document.getElementById('export').addEventListener('click', () => {
  exportPng().catch(e => console.warn(TAG, '导出 PNG 失败:', e && e.message || e));
});
document.getElementById('exportSvg').addEventListener('click', () => {
  exportSvg().catch(e => console.warn(TAG, '导出 SVG 失败:', e && e.message || e));
});

// ================= 启动 =================
function showError(msg) {
  document.getElementById('title').textContent = `🧠 ${msg}`;
  svg.style.display = 'none';
  const div = document.createElement('div');
  div.style.cssText = 'color:#999;padding:48px 24px;text-align:center;font-size:15px;';
  div.textContent = msg;
  document.body.appendChild(div);
}

(async () => {
  theme = 'light';
  try {
    theme = localStorage.getItem('biliGeminiMindmapTheme')
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (e) { /* 无痕模式等，按默认 */ }
  applyTheme();

  try {
    const { mindmapData } = await chrome.storage.session.get('mindmapData');
    originalMarkdown = (mindmapData && mindmapData.markdown) || '';
    videoTitle = (mindmapData && mindmapData.title) || '';
  } catch (e) {
    console.warn(TAG, '读取 mindmapData 失败:', e && e.message || e);
  }
  if (videoTitle) {
    document.getElementById('title').textContent = `🧠 ${videoTitle}`;
    document.title = `思维导图 - ${videoTitle}`;
  }
  const parsed = originalMarkdown && parseMarkdown(originalMarkdown);
  if (!parsed) {
    console.warn(TAG, '思维导图解析失败, markdown 前 200 字符 =', originalMarkdown.slice(0, 200));
    showError('无法解析思维导图内容');
    return;
  }
  // 编辑缓存优先：同一 markdown 之前编辑过就从缓存恢复（刷新不丢）
  editCacheKey = 'biliGeminiMindmapEdit:' + hashStr(originalMarkdown);
  const cached = loadEditCache();
  tree = cached || parsed;
  if (cached) console.log(TAG, '命中编辑缓存，恢复上次编辑状态');
  updateRestoreBtn();
  mm = window.markmap.Markmap.create(svg, {
    color: node => colorOfPath((node.state && node.state.path) || ''),
    maxWidth: 260,
  }, tree);
  rebuildPathMap(tree);
  mm.fit();
  styleNodes();
  console.log(TAG, '渲染完成, markdown len =', originalMarkdown.length);
})();
