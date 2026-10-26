(() => {
if (window.__biliGeminiScriptV11) return;
window.__biliGeminiScriptV11 = true;
let filling = false;
let generationWatchToken = 0;
// Gemini 网页：填入文本并发送。
// 0.6.0 起回答不再回传 B 站页，用户直接在本页（Gemini 小窗）里看，
// 本脚本负责填入、发送确认、发送后的生成完成检测（GEN_DONE → background → B 站按钮），
// 以及把 Gemini 渲染成 google 搜索跳转的 B 站时间戳链接改写回直链（左键点击拦截走 BILI_SEEK 同页 seek）。
// 本脚本不碰 chrome.storage —— 小窗上下文里 storage API 会抛
// "Access to storage is not allowed from this context"，纯属噪音。
// 本脚本可能被 background 用 executeScript 补注入，防重复注册。
// 点击后验证提交迹象；未确认不等同风控，不自动重复点击。
// 关键步骤都带 +Nms 耗时 log，方便定位填入延迟花在哪。
const TAG = '[bili-gemini]';

if (!window.__biliGeminiListener) {
  window.__biliGeminiListener = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'PING') { sendResponse({ pong: true, version: '0.9.17' }); return; }
    if (msg.type === 'PREPARE_MODEL') {
      ensurePreferredModel().then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'START_NEW_CHAT') {
      startNewChat().then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type !== 'FILL_AND_SEND') return;
    if (filling) { sendResponse({ done: false, error: 'Gemini 正在处理上一条发送请求' }); return; }
    filling = true;
    (async () => {
      console.log(TAG, '收到填入请求, len =', (msg.text || '').length);
      if (msg.fixedModel === true) await ensurePreferredModel();
      showGeminiNotice(msg.warning || '');
      const ok = await fillAndSend(msg.text, msg.requestId, msg.deadline);
      console.log(TAG, 'fillAndSend =>', ok);
      sendResponse({ done: ok });
    })().catch(e => {
      showGeminiNotice(e.message);
      console.warn(TAG, 'listener error', e.message);
      try { sendResponse({ done: false, error: e.message }); } catch (e2) { /* 上下文已失效 */ }
    }).finally(() => { filling = false; });
    return true;
  });
}

// 条件等待：100ms 一轮轮询（首轮立即同步检查），命中立即返回，不命中到 timeoutMs 返回 null
function waitFor(fn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { reject(e); return; }
      if (v) return resolve(v);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

// Model selection uses the visible menu label, never an undocumented model API/id.
let modelPreparation = null;
let modelVerified = false;
function usableModelControl(el) {
  return !!el && el.getClientRects().length > 0 && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
}
function modelPicker() {
  const candidates = [
    ...document.querySelectorAll('button[data-test-id="bard-mode-menu-button"]'),
    ...[...document.querySelectorAll('[data-test-id="logo-pill-label-container"]')].map(el => el.closest('button')),
    ...document.querySelectorAll('button[aria-label*="模式选择器"], button[aria-label*="model" i][aria-haspopup], button[aria-label*="mode picker" i]'),
  ];
  return candidates.find(usableModelControl) || null;
}
function visibleModelMenu() {
  const menu = document.querySelector('[data-test-id="gem-mode-menu"]');
  return menu && menu.getClientRects().length && menu.getAttribute('data-visible') !== 'false' ? menu : null;
}
function isLitePicker() { return /flash[\s-]*lite/i.test(modelPicker()?.textContent || ''); }
function ensurePreferredModel() {
  if (!modelPreparation) modelPreparation = selectPreferredModel().finally(() => { modelPreparation = null; });
  return modelPreparation;
}
async function selectPreferredModel() {
  if (modelVerified && isLitePicker()) return;
  const picker = await waitFor(modelPicker, 8000);
  if (!picker) throw new Error('等待 Gemini 模型入口超时（兼容页首和输入框旁入口）；请确认小窗已加载完成或登录后重试');
  let openedHere = false;
  try {
    if (!visibleModelMenu()) { picker.click(); openedHere = true; }
    const menu = await waitFor(visibleModelMenu, 2000);
    if (!menu) throw new Error('无法打开 Gemini 模型菜单，已暂停发送');
    const option = [...menu.querySelectorAll('[role="menuitem"]')].find(el =>
      /^3\.5\s+flash[\s-]*lite$/i.test((el.querySelector('.label')?.textContent || '').trim()));
    if (!option || option.getAttribute('aria-disabled') === 'true') {
      throw new Error('当前 Gemini 菜单没有可用的 3.5 Flash-Lite，已暂停发送，请检查账号可用模型');
    }
    if (!option.classList.contains('selected') && option.getAttribute('aria-checked') !== 'true') {
      option.click();
      if (!await waitFor(isLitePicker, 2500)) throw new Error('未确认切换到 3.5 Flash-Lite，已暂停发送');
    }
    modelVerified = true;
  } finally {
    if (openedHere && visibleModelMenu()) modelPicker()?.click();
  }
}
// End model selection.

async function startNewChat() {
  if (filling) throw new Error('正在发送，不能切换对话');
  if (/^\/app\/?$/.test(location.pathname) && !document.querySelector('user-query') && findEditor()) return;
  const button = [...document.querySelectorAll('button[aria-label], a[aria-label]')].find(el =>
    /^(发起新对话|新对话|开启新对话|Start new chat|New chat)$/i.test(el.getAttribute('aria-label') || '')
      && el.getClientRects().length > 0 && el.getAttribute('aria-disabled') !== 'true');
  if (!button) throw new Error('未找到新对话入口');
  generationWatchToken++;
  button.click();
  const ready = await waitFor(() => /^\/app\/?$/.test(location.pathname)
    && !document.querySelector('user-query') && findEditor(), 2500);
  if (!ready) throw new Error('新对话未就绪');
}

function findEditor() {
  return document.querySelector('.ql-editor[contenteditable="true"]')
      || document.querySelector('rich-textarea [contenteditable="true"]')
      || document.querySelector('[contenteditable="true"]');
}

function findSendButton() {
  const b = document.querySelector('button.send-button:not([disabled])')
    || document.querySelector('button[aria-label*="发送"]:not([disabled]), button[aria-label*="Send"]:not([disabled])')
    || [...document.querySelectorAll('button')].find(x => {
        const label = x.getAttribute('aria-label') || '';
        return /发送|send/i.test(label) && !x.disabled;
      });
  return b || null;
}

async function fillAndSend(text, requestId, deadline = Infinity) {
  const t0 = Date.now();
  const elapsed = () => '+' + (Date.now() - t0) + 'ms';
  // background 发 FILL_AND_SEND 前已确认输入框出现，这里通常第一轮就命中；
  // 保留 waitFor 兜底（补注入早于页面渲染完成等情况）。
  if (isGenerating()) throw new Error('当前对话仍在生成，请等待回答结束后再次总结');
  const editor = await waitFor(findEditor, 10000);
  if (!editor) { console.warn(TAG, '找不到输入框'); return false; }
  console.log(TAG, '输入框找到', elapsed());

  editor.focus();
  // 先全选再插入，清掉可能残留的草稿，避免重复内容。
  // execCommand 会触发 Gemini 前端（Quill/Angular）的 input 监听，比直接改 DOM 可靠。
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('insertText', false, text);
  console.log(TAG, '文字已填入', elapsed());

  // 点击发送并验证「真的发出去了」（风控可能吞掉发送请求，会话不建立、URL 不变）。
  // 发送按钮从禁用变可用是条件等待（填入后通常立即可用），没有固定 sleep。
  const countBefore = document.querySelectorAll('user-query').length;
  const responseCountBefore = document.querySelectorAll('model-response').length;
  const btn = await waitFor(findSendButton, 5000);
  if (!btn) throw new Error('Gemini 发送按钮不可用，请检查登录、网络或页面提示；文字已保留');
  if (Date.now() > deadline) throw new Error('发送等待已超时，未点击发送，请重试');
  btn.click();
  const sent = await waitFor(() => document.querySelectorAll('user-query').length > countBefore
    || !!document.querySelector('button[aria-label*="Stop" i], button[aria-label*="停止"], button.stop-button'), 7000);
  if (!sent) throw new Error('已点击发送但未确认成功，请查看小窗；为避免重复提问，已停止自动重发');
  void watchGenerationDone(requestId, responseCountBefore, ++generationWatchToken).catch(e => showGeminiNotice(e.message));
  return true;
}

let geminiNoticeTimer = null;
function showGeminiNotice(message) {
  clearTimeout(geminiNoticeTimer);
  geminiNoticeTimer = null;
  let note = document.getElementById('bili-gemini-notice');
  if (!note && message) {
    note = document.createElement('div');
    note.id = 'bili-gemini-notice'; note.setAttribute('role', 'status');
    note.style.cssText = 'position:fixed;left:12px;right:12px;bottom:100px;z-index:2147483647;padding:10px;border:1px solid #c98b25;border-radius:8px;background:#fff4d6;color:#603b00;font:13px/1.5 sans-serif;pointer-events:none;';
    document.body.appendChild(note);
  }
  if (note) {
    note.textContent = message;
    note.hidden = !message;
    if (message) geminiNoticeTimer = setTimeout(() => {
      note.hidden = true;
      geminiNoticeTimer = null;
    }, 5000);
  }
}
function isGenerating() {
  // Generic page spinners include uploads/model menus; only use generation controls.
  return [...document.querySelectorAll('button[aria-label*="Stop" i], button[aria-label*="停止"], button.stop-button')]
    .some(el => el.getClientRects().length > 0);
}
function generationState({ elapsed, generating, text, stableFor }) {
  if (!generating && text.trim() && stableFor >= 2000) return 'done';
  if (elapsed >= 180000) return 'timeout';
  return 'waiting';
}
async function watchGenerationDone(requestId, responseCountBefore, watchToken) {
  const start = Date.now();
  let url = location.href;
  let lastText = '', changedAt = start;
  while (true) {
    if (watchToken !== generationWatchToken) return;
    if (location.href !== url) {
      // Gemini assigns a conversation URL after the first submission.
      if (/\/app\/?$/.test(url) && /\/app\/[^/?#]+/.test(location.href)) url = location.href;
      else return;
    }
    const responses = document.querySelectorAll('model-response');
    const text = responses.length > responseCountBefore ? responses[responses.length - 1].textContent || '' : '';
    if (text !== lastText) { lastText = text; changedAt = Date.now(); }
    const state = generationState({ elapsed: Date.now() - start, generating: isGenerating(), text, stableFor: Date.now() - changedAt });
    if (state !== 'waiting') {
      const error = 'Gemini 超过3分钟仍未确认完成；请查看小窗的网络、登录或重试提示。插件未自动重发。';
      if (state === 'timeout') showGeminiNotice(error);
      try { await chrome.runtime.sendMessage({ type: state === 'done' ? 'GEN_DONE' : 'GEN_FAILED', requestId, error: state === 'timeout' ? error : undefined }); }
      catch (_) { showGeminiNotice('扩展连接已失效，请刷新B站页面和Gemini小窗；当前回答不会自动重发。'); }
      return;
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ---- B 站时间戳链接修复器 ----
// Gemini 不信任 bilibili.com 域名，把回答里的 B 站链接渲染成
// https://www.google.com/search?q=<URL编码的bilibili链接> 的搜索跳转。
// 这里把 q 参数解码回 B 站 URL 并改写 href，让「时间戳」节的链接可直接点击跳转。
// 只动解码后以 https://www.bilibili.com/video/BV 开头的链接，其他 google search
// 链接（如「信息验证」节的搜索结果引用）不碰。
if (!window.__biliGeminiLinkFixer) {
  window.__biliGeminiLinkFixer = true;
  const FIX_MARK = 'bili-gemini-link-fixed';
  const seenLinks = new WeakSet();
  const BILI_VIDEO_RE = /^https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]+/;

  function fixBiliLinks() {
    for (const a of document.querySelectorAll(`a[href*="google.com/search?q="]:not(.${FIX_MARK})`)) {
      if (seenLinks.has(a)) continue;
      let q;
      try {
        q = new URL(a.href).searchParams.get('q') || '';
        if (q.includes('%')) q = decodeURIComponent(q); // 兼容二次编码
      } catch (e) { continue; }
      if (!BILI_VIDEO_RE.test(q)) continue;
      seenLinks.add(a);
      a.href = q;
      a.target = '_blank';
      a.rel = 'noopener';
      a.classList.add(FIX_MARK);
      console.log(TAG, '改写 B 站链接:', (a.textContent || '').trim(), '=>', q);
    }
  }

  // ---- 思维导图检测：回答里出现 markmap 代码块 → 注入「🧠 查看思维导图」按钮 ----
  // 实测 Gemini 渲染的代码块没有 language-markmap 类，改双锚点：
  // 主锚点 = 「思维导图」分节标题（### 思维导图 ### 渲染出的 heading）在文档序之后的
  // 第一个 pre；兜底 = code 文本以 '# ' 开头且含 '\n#' 或 '\n- '（标题/列表层级都算
  // markmap 结构），且所在回答区有我们改写过的时间戳链接（不误伤无关代码块）。
  const MINDMAP_MARK = 'bili-gemini-mindmap-done';

  function injectMindmapButton(pre) {
    pre.classList.add(MINDMAP_MARK);
    const code = pre.querySelector('code');
    const markdown = (code && code.textContent) || '';
    const title = document.title.replace(/\s*[-–]\s*Google Gemini\s*$/i, '');
    // 检测到即上报：background 存 session 并转发 B 站标签，那边悬浮面板出现「🧠 思维导图」入口
    chrome.runtime.sendMessage({ type: 'MINDMAP_READY', markdown, title }, () => void chrome.runtime.lastError);
    const btn = document.createElement('button');
    btn.textContent = '🧠 查看思维导图';
    btn.style.cssText = 'display:inline-block;margin:6px 0;padding:6px 12px;border:none;border-radius:14px;'
      + 'background:#3a3a3a;color:#e7e7e7;font-size:13px;cursor:pointer;';
    btn.addEventListener('click', () => {
      console.log(TAG, '打开思维导图, markdown len =', markdown.length);
      chrome.runtime.sendMessage({ type: 'MINDMAP_OPEN', markdown, title }, () => void chrome.runtime.lastError);
    });
    pre.parentNode.insertBefore(btn, pre);
    console.log(TAG, '检测到 markmap 代码块，已注入思维导图按钮并上报 MINDMAP_READY');
  }

  function scanMindmapBlocks() {
    const pres = [...document.querySelectorAll(`pre:not(.${MINDMAP_MARK})`)];
    if (!pres.length) return;
    const done = new Set();
    // 主锚点：文本恰为「思维导图」的标题元素 → 文档序上其后的第一个 pre
    for (const h of document.querySelectorAll('model-response h1, model-response h2, model-response h3, model-response h4, model-response h5, model-response h6')) {
      if ((h.textContent || '').trim() !== '思维导图') continue;
      const pre = pres.find(p => h.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (pre && !done.has(pre)) { done.add(pre); injectMindmapButton(pre); }
    }
    // 兜底：无标题锚点时按 markmap 大纲结构认，仅限改写过链接的回答区
    for (const pre of pres) {
      if (done.has(pre)) continue;
      const code = pre.querySelector('code');
      const text = (code && code.textContent) || '';
      if (!text.startsWith('# ') || !(text.includes('\n#') || text.includes('\n- '))) continue;
      const region = pre.closest('model-response') || pre.parentElement;
      if (!(region && region.querySelector(`a.${FIX_MARK}`))) continue;
      done.add(pre);
      injectMindmapButton(pre);
    }
  }

  // Gemini 是 SPA，observer 页面生命周期内常驻；300ms 节流，流式渲染期间不狂扫
  let linkScanTimer = null;
  const scheduleScan = () => {
    if (linkScanTimer) return;
    linkScanTimer = setTimeout(() => { linkScanTimer = null; fixBiliLinks(); scanMindmapBlocks(); }, 300);
  };
  fixBiliLinks();
  scanMindmapBlocks();
  const startObserver = () => {
    if (!document.body) return;
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
  };
  startObserver();

  // 普通左键点击改写过的 B 站时间戳链接 → 拦截默认跳转，改发 BILI_SEEK 让
  // background 在已打开的对应 B 站标签里 seek 播放。中键/Ctrl+点击等修饰键
  // 不拦截，交给默认行为（target=_blank 开新页兜底）。
  document.addEventListener('click', e => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest && e.target.closest(`a.${FIX_MARK}`);
    if (!a) return;
    let bvid, t;
    try {
      const u = new URL(a.href);
      const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
      bvid = m && m[1];
      t = parseFloat(u.searchParams.get('t'));
    } catch (err) { return; }
    if (!bvid || !isFinite(t)) return;
    e.preventDefault();
    e.stopPropagation();
    console.log(TAG, '时间戳点击拦截:', bvid, 't =', t);
    chrome.runtime.sendMessage({ type: 'BILI_SEEK', bvid, t }, () => void chrome.runtime.lastError);
  }, true); // 捕获阶段：抢在 Gemini 自己的链接处理之前
}

})();
