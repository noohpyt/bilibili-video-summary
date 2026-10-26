// Gemini 小窗复用；准备阶段可重试，发送动作只执行一次，避免重复提交。
const TAG = '[bili-gemini:bg]';
const GEMINI_URL = 'https://gemini.google.com/app';

// 最近一次 BILI_TO_GEMINI 的来源 B 站标签，GEN_DONE 要转发回这里。
// 只存内存：SW 重启丢了就只是按钮不变完成态，不影响功能。
let lastBiliTabId = null;
let sending = false;
let preparedRequest = null;
let creatingWindow = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'FETCH_DANMAKU') {
    if (!sender.tab || !/^https:\/\/www\.bilibili\.com\//.test(sender.tab.url || '') || !/^\d+$/.test(String(msg.cid))) {
      sendResponse({ ok: false, error: '弹幕请求参数无效' }); return;
    }
    const base = msg.fallback ? 'https://comment.bilibili.com/' + msg.cid + '.xml'
      : 'https://api.bilibili.com/x/v1/dm/list.so?oid=' + msg.cid;
    (async () => {
      const r = await fetch(base, { credentials: 'include', signal: AbortSignal.timeout(4500) });
      if (!r.ok) throw new Error('弹幕接口 HTTP ' + r.status);
      const text = await r.text();
      if (!/<i[\s>]/.test(text)) throw new Error('弹幕接口未返回 XML，可能是登录、限流或接口错误');
      sendResponse({ ok: true, text });
    })().catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'GEN_DONE' || msg.type === 'GEN_FAILED') {
    (async () => {
      const { generationRoute } = await chrome.storage.session.get('generationRoute');
      if (generationRoute && msg.requestId === generationRoute.requestId && sender.tab?.id === generationRoute.geminiTabId) {
        await chrome.tabs.sendMessage(generationRoute.biliTabId, { type: msg.type, requestId: msg.requestId, error: msg.error }).catch(() => {});
      }
      sendResponse({ ok: true });
    })().catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'BILI_SEEK') {
    handleBiliSeek(msg.bvid, msg.t).then(
      r => sendResponse(r),
      e => sendResponse({ ok: false, error: String(e && e.message || e) })
    );
    return true;
  }
  if (msg.type === 'MINDMAP_OPEN' || msg.type === 'MINDMAP_READY') {
    // MINDMAP_OPEN：Gemini 页点「查看思维导图」→ 存 session → 开完整 tab。
    // MINDMAP_READY：检测到代码块即上报 → 存 session 并转发来源 B 站标签（面板出入口）。
    (async () => {
      await chrome.storage.session.set({ mindmapData: { markdown: msg.markdown || '', title: msg.title || '' } });
      console.log(TAG, '思维导图数据已存 session, markdown len =', (msg.markdown || '').length, ', title =', msg.title || '');
      if (msg.type === 'MINDMAP_OPEN') {
        await chrome.tabs.create({ url: chrome.runtime.getURL('mindmap.html') });
      } else if (lastBiliTabId != null) {
        chrome.tabs.sendMessage(lastBiliTabId, { type: 'MINDMAP_READY' }, () => void chrome.runtime.lastError);
      }
      sendResponse({ ok: true });
    })().catch(e => {
      console.warn(TAG, msg.type, '失败:', e && e.message || e);
      sendResponse({ ok: false, error: String(e && e.message || e) });
    });
    return true;
  }
  if (msg.type === 'OPEN_MINDMAP_POPUP') {
    // B 站悬浮面板「🧠 思维导图」入口 → popup 小窗开只读查看页（数据已在 session）
    chrome.windows.create({ url: chrome.runtime.getURL('mindmap.html?popup=1'), type: 'popup', width: 960, height: 640 })
      .then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'PREWARM') {
    ensureGeminiReady(null).then(
      () => sendResponse({ ok: true }),
      e => sendResponse({ ok: false, error: String(e && e.message || e) })
    );
    return true;
  }
  if (msg.type === 'CANCEL_PREPARE') {
    if (!sending && preparedRequest?.id === msg.requestId && preparedRequest.source === sender.tab?.id) preparedRequest = null;
    sendResponse({ ok: true }); return;
  }
  if (msg.type === 'OPEN_GEMINI') {
    if (!msg.requestId) { sendResponse({ ok: false, error: 'B站页面脚本版本过旧，请刷新视频页面' }); return; }
    if (sending || (preparedRequest && Date.now() - preparedRequest.at < 60000)) {
      sendResponse({ ok: false, error: '另一条总结请求正在准备或发送，请等待完成后再试' }); return;
    }
    const job = { id: msg.requestId, source: sender.tab?.id, at: Date.now() };
    preparedRequest = job;
    // One preparation per request. The send phase must never navigate again.
    job.promise = bringGeminiToFront(sender.tab?.windowId);
    job.promise.then(() => sendResponse({ ok: true }), e => {
      if (preparedRequest === job) preparedRequest = null;
      sendResponse({ ok: false, error: readableError(e, '准备小窗') });
    });
    return true;
  }
  if (msg.type === 'BILI_TO_GEMINI') {
    const job = preparedRequest;
    if (sending || !job || job.id !== msg.requestId || job.source !== sender.tab?.id) {
      sendResponse({ ok: false, error: '本次小窗准备已失效，请刷新视频页面后重试' }); return;
    }
    sending = true;
    lastBiliTabId = sender.tab.id;
    (async () => {
      const { tab, fixedModel } = await job.promise;
      await ensureContentScript(tab.id);
      await chrome.storage.session.set({ generationRoute: { requestId: msg.requestId, biliTabId: sender.tab.id, geminiTabId: tab.id } });
      const response = await tabMessage(tab.id, { type: 'FILL_AND_SEND', requestId: msg.requestId,
        text: msg.prompt, fixedModel: fixedModel === true, warning: msg.warning || '', deadline: Date.now() + 18000 }, 20000);
      if (!response?.done) throw new Error(response?.error || '发送结果未确认，请查看 Gemini 小窗，避免重复提交');
      sendResponse({ ok: true });
    })().catch(e => sendResponse({ ok: false, error: readableError(e, '发送') }))
      .finally(() => { sending = false; if (preparedRequest === job) preparedRequest = null; });
    return true;
  }
});

function readableError(error, stage) {
  const text = error?.message || String(error);
  if (/context invalidated|message (channel|port) closed|asynchronous response|Receiving end/i.test(text)) {
    return stage + '时连接断开：扩展可能已重载或小窗发生跳转。请刷新B站页面和Gemini小窗；先确认是否已提交，避免重复发送。';
  }
  return stage + '失败：' + text;
}
function tabMessage(tabId, payload, ms = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(payload.type + ' 超时，请查看小窗的登录、网络或加载提示')), ms);
    chrome.tabs.sendMessage(tabId, payload).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

// BILI_SEEK：点击 Gemini 回答里的时间戳链接 → 在已打开的对应 B 站视频标签里 seek 播放
// 并带到前台；找不到对应标签则回退新开带 t 参数的链接。
async function handleBiliSeek(bvid, t) {
  if (!bvid || !isFinite(t)) return { ok: false, error: '参数无效' };
  const tabs = await chrome.tabs.query({ url: '*://www.bilibili.com/video/*' });
  const tab = tabs.find(x => (x.url || '').includes('/video/' + bvid));
  if (!tab) {
    console.log(TAG, '未找到 B 站标签, bvid =', bvid, '，回退新开页面');
    await chrome.tabs.create({ url: `https://www.bilibili.com/video/${bvid}?t=${t}` });
    return { ok: true, fallback: true };
  }
  console.log(TAG, '找到 B 站标签, tabId =', tab.id, ', seek 到', t, 's');
  const r = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [t],
    func: sec => {
      // 有多个 video 取第一个可见的（有尺寸且在文档里）
      const vids = [...document.querySelectorAll('video')];
      const v = vids.find(x => x.getBoundingClientRect().width > 0) || vids[0];
      if (!v) return 'no-video';
      v.currentTime = sec;
      v.play();
      return 'ok';
    },
  });
  const result = r && r[0] && r[0].result;
  console.log(TAG, 'seek 结果 =', result);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: result === 'ok', result };
}

// 绑定的小窗被用户手动关掉 → 清掉 geminiWinId（保留 geminiWinBounds，下次重建回到用户摆好的位置）
chrome.windows.onRemoved.addListener(winId => {
  (async () => {
    const { geminiWinId } = await chrome.storage.local.get('geminiWinId');
    if (geminiWinId == null || winId !== geminiWinId) return;
    console.log(TAG, '小窗已关闭，清除记录（保留记忆位置）');
    await chrome.storage.local.remove('geminiWinId');
  })();
});

// 记忆小窗位置：用户拖动/调整后 ~500ms 防抖落盘 geminiWinBounds，下次重建优先用。
// DPI 归一化：存之前找窗口中心点所在显示器，bounds 除以其缩放比（dpiX/96）并记 displayId，
// 避免跨屏（如 4K 200% ↔ 2K 100%）移动后重建时物理尺寸突变。还原在 getUsableSavedBounds。
// onBoundsChanged 较新（Chrome 86+），加存在性守卫防旧版本缺 API 直接炸 SW。
let boundsSaveTimer = null;
if (chrome.windows.onBoundsChanged) {
  chrome.windows.onBoundsChanged.addListener(win => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(async () => {
      try {
        const { geminiWinId } = await chrome.storage.local.get('geminiWinId');
        if (geminiWinId == null || win.id !== geminiWinId) return;
        const { left, top, width, height } = win;
        if (![left, top, width, height].every(v => typeof v === 'number')) return;
        let scale = 1, displayId = null;
        try {
          if (chrome.system && chrome.system.display) {
            const displays = await chrome.system.display.getInfo();
            const cx = left + width / 2, cy = top + height / 2;
            const inArea = (a, x, y) => x >= a.left && x < a.left + a.width && y >= a.top && y < a.top + a.height;
            const d = (displays || []).find(d => d.workArea && (inArea(d.workArea, left, top) || inArea(d.workArea, cx, cy)));
            if (d && d.dpiX) { scale = d.dpiX / 96; displayId = d.id; }
          }
        } catch (e) { /* 拿不到显示器信息就按缩放比 1 存 */ }
        const norm = {
          left: Math.round(left / scale), top: Math.round(top / scale),
          width: Math.round(width / scale), height: Math.round(height / scale),
          displayId,
        };
        if (scale !== 1) console.log(TAG, '小窗位置落盘（DPI 归一化, 缩放比 =', scale, ', displayId =', displayId, '）', JSON.stringify(norm));
        await chrome.storage.local.set({ geminiWinBounds: norm });
      } catch (e) { /* 存储失败不影响主流程 */ }
    }, 500);
  });
}

// OPEN_GEMINI 与 BILI_TO_GEMINI 共用：确保小窗就绪（复用/创建 + 必要时导航到 /app）、
// 提到前台、等输入框出现、确认内容脚本在场。
// frontChain 串行化多次调用：点击瞬间 OPEN_GEMINI 和抓取完后的 BILI_TO_GEMINI 几乎同时到达时，
// 避免两者同时进 ensureGeminiReady 各创建一个小窗；也让就绪等待只做一次。
// readyCache 就绪缓存：OPEN 阶段探测成功后 5s 内同一 tab 直接跳过重复轮询/PING。
// SW 被回收会丢缓存，只是退回正常探测，不影响正确性。
let frontChain = Promise.resolve();
let readyCache = { tabId: null, at: 0 };
function bringGeminiToFront(srcWinId) {
  const p = frontChain.then(() => doBringGeminiToFront(srcWinId));
  frontChain = p.catch(() => { /* 上一次失败不挡住下一次 */ });
  return p;
}
async function doBringGeminiToFront(srcWinId) {
  const { tab, winId, created } = await ensureGeminiReady(srcWinId);
  const { biliGeminiSettings = {} } = await chrome.storage.local.get('biliGeminiSettings');
  const newConversation = biliGeminiSettings.newConversation !== false;
  const fixedModel = biliGeminiSettings.fixedModel === true;
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(winId, { focused: true });
  await waitEditorReady(tab.id, 10000, created);
  await ensureContentScript(tab.id);
  if (newConversation && !created) {
    // Prefer Gemini's own SPA action. No document reload when the new-chat button works.
    let reset;
    try { reset = await tabMessage(tab.id, { type: 'START_NEW_CHAT' }, 4000); } catch (_) {}
    if (!reset?.ok) {
      // This fallback is only before submission; it can never repeat a sent prompt.
      await chrome.tabs.update(tab.id, { url: GEMINI_URL });
      readyCache = { tabId: null, at: 0 };
      await waitEditorReady(tab.id, 10000, true);
      await ensureContentScript(tab.id);
    }
  }
  readyCache = { tabId: tab.id, at: Date.now() };
  if (fixedModel) {
    const model = await tabMessage(tab.id, { type: 'PREPARE_MODEL' }, 16000);
    if (!model?.ok) throw new Error(model?.error || '固定模型失败，请检查Gemini小窗');
  }
  return { tab, winId, created, newConversation, fixedModel };
}

// 找到或创建专用小窗。新建优先用记忆位置（geminiWinBounds）；没有记忆位置且 srcWinId 非空时才开在 B 站窗口右侧。
// 复用已有小窗时不动它的位置（用户可能自己拖过）。
// 这里不等待加载：创建后窗口立即弹出，就绪等待统一交给 waitEditorReady。
function ensureGeminiReady(srcWinId) {
  if (!creatingWindow) creatingWindow = createOrReuseGemini(srcWinId).finally(() => { creatingWindow = null; });
  return creatingWindow;
}
async function createOrReuseGemini(srcWinId) {
  const { geminiWinId } = await chrome.storage.local.get('geminiWinId');
  let win = null, tab = null;
  if (geminiWinId != null) {
    try {
      win = await chrome.windows.get(geminiWinId, { populate: true });
      tab = win.type === 'popup' ? (win.tabs || []).find(t => (t.url || t.pendingUrl || '').startsWith('https://gemini.google.com/')) : null;
    } catch (e) { /* 窗口已被关掉，重建 */ }
  }
  let created = false;
  if (!win || !tab) {
    const saved = await getUsableSavedBounds();
    const opts = { url: GEMINI_URL, type: 'popup', width: 560, height: 720 };
    if (saved) {
      Object.assign(opts, saved);
      console.log(TAG, '没有可用小窗，创建新窗口（用记忆位置）', JSON.stringify(saved));
    } else {
      console.log(TAG, '没有可用小窗，创建新窗口（默认位置）');
      if (srcWinId != null) {
        // 默认开在 B 站窗口右侧：贴窗口右缘（窗口宽 - 600），顶部下挪 80，钳位 ≥0
        try {
          const srcWin = await chrome.windows.get(srcWinId);
          opts.left = Math.max(0, (srcWin.left || 0) + (srcWin.width || 1280) - 600);
          opts.top = Math.max(0, (srcWin.top || 0) + 80);
        } catch (e) { /* 拿不到源窗口就用系统默认位置 */ }
      }
    }
    if (srcWinId == null) opts.focused = false; // 预热：后台开好，不把用户从视频页拉走
    try { win = await chrome.windows.create(opts); }
    catch (e) {
      // 记忆尺寸无效时去掉所有位置参数，只重试创建一次。
      win = await chrome.windows.create({ url: GEMINI_URL, type: 'popup', width: 560, height: 720, focused: srcWinId != null });
    }
    await chrome.storage.local.set({ geminiWinId: win.id });
    tab = win.tabs[0];
    created = true;
  } else {
    console.log(TAG, '复用已有小窗, winId =', win.id, ', tabId =', tab.id);
  }
  return { tab, winId: win.id, created };
}

// 读记忆位置并校验是否仍可用：bounds 可能指向已拔掉的副屏。
// DPI 还原：存的是归一化值，找同 displayId 的显示器用其当前缩放比乘回去；
// 显示器不在/getInfo 失败回退现有默认逻辑。旧版本存的 bounds 没有 displayId，按缩放比 1 原样用。
// 窗口左上角或中心点落在任一显示器 workArea 内即算有效（对乘完的值校验）。
async function getUsableSavedBounds() {
  const { geminiWinBounds } = await chrome.storage.local.get('geminiWinBounds');
  if (!geminiWinBounds) return null;
  const { left, top, width, height, displayId } = geminiWinBounds;
  if (![left, top, width, height].every(v => typeof v === 'number')) return null;
  try {
    if (!chrome.system || !chrome.system.display) return { left, top, width, height };
    const displays = await chrome.system.display.getInfo();
    let scale = 1;
    if (displayId != null) {
      const src = (displays || []).find(d => d.id === displayId);
      if (!src) {
        console.log(TAG, '记忆位置所在显示器不在（displayId =', displayId, '），回退默认位置');
        return null;
      }
      if (src.dpiX) scale = src.dpiX / 96;
    }
    const b = {
      left: Math.round(left * scale), top: Math.round(top * scale),
      width: Math.round(width * scale), height: Math.round(height * scale),
    };
    if (scale !== 1) console.log(TAG, '记忆位置按缩放比还原, 缩放比 =', scale, ', displayId =', displayId, '→', JSON.stringify(b));
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    const inArea = (a, x, y) => x >= a.left && x < a.left + a.width && y >= a.top && y < a.top + a.height;
    const hit = (displays || []).some(d => d.workArea && (inArea(d.workArea, b.left, b.top) || inArea(d.workArea, cx, cy)));
    if (!hit) {
      console.log(TAG, '记忆位置不在任何显示器内（副屏可能已拔掉），回退默认位置:', JSON.stringify(b));
      return null;
    }
    return b;
  } catch (e) { /* 拿不到显示器信息就当校验通过，别阻塞创建 */ }
  return { left, top, width, height };
}

// 等 Gemini 输入框出现：SPA 的输入框远在 tab 'complete' 之前就渲染好了，
// 用 executeScript 在页面里直接轮询元素，一出现就返回（120ms 一轮，最多 10s；
// executeScript 有跨进程开销，不再往下压频率）。
// 页面还在导航/加载时 executeScript 会抛错，吞掉下一轮再试。
async function waitEditorReady(tabId, timeoutMs = 10000, requireNewChat = false) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        args: [requireNewChat],
        func: fresh => (!fresh || (/^\/app\/?$/.test(location.pathname) && !document.querySelector('user-query'))) && !!document.querySelector(
          '.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], [contenteditable="true"]'
        ),
      });
      if (r && r[0] && r[0].result) {
        console.log(TAG, '输入框已出现, 等了', Date.now() - t0, 'ms');
        return;
      }
    } catch (e) { /* 页面还在导航/加载，下一轮再试 */ }
    await new Promise(res => setTimeout(res, 120));
  }
  throw new Error('等待 Gemini 输入框超时');
}

// 扩展重载后已存在的标签页不会自动重新注入内容脚本，先探测、缺失则补注入。
async function ensureContentScript(tabId) {
  let response;
  try { response = await tabMessage(tabId, { type: 'PING' }, 1500); } catch (_) {}
  if (!response?.pong) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-gemini.js'] });
    response = await tabMessage(tabId, { type: 'PING' }, 1500);
  }
  if (response?.version !== '0.9.17') throw new Error('Gemini 页面仍在运行旧版脚本，请刷新小窗后重试');
}
