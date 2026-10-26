// 动态页(t.bilibili.com)：视频卡片左侧默认显示 B 站官方 AI 总结。
// 数据源是官方 conclusion/get 接口（与播放页「AI视频总结」同源），需登录，请求带 WBI 签名。
// 卡片进入视口才懒加载（并发限 2），结果按 BV 内存缓存（含「已确认无总结」负面缓存），
// 尽量少烧 B 站的账号级总结配额。无总结的视频不渲染面板。
// 定位自适应：卡片左缘外侧空间够（≥330px）就悬浮在卡片左侧，不够则降级插入卡片内部。
// 深色模式跟随 B 站夜间模式（html.dark）/ 系统深色，走注入 <style> + 类名切换。
// 开关：扩展弹窗可整体关停本功能（biliGeminiSettings.feedSummary），实时生效。
// 配额检测：连续 EMPTY_STREAK_LIMIT 个视频都返回空总结 → 认为当日配额耗尽，
// 写 biliGeminiFeedQuota 供弹窗显示「（次数耗尽）」；任何一次拿到总结都会解除。
// （空总结也可能只是视频本身没有，所以是启发式判断，阈值取得偏保守。）
(() => {
  if (window.__biliGeminiFeedInjected) return;
  window.__biliGeminiFeedInjected = true;

  const TAG = '[bili-gemini-feed]';
  const PANEL_W = 300;      // 悬浮面板宽度
  const MIN_LEFT_SPACE = 330; // 卡片左缘外侧至少这么多空间才用悬浮模式
  const MAX_CONCURRENT = 2;   // 总结请求并发上限，防触发 -799 风控
  const EMPTY_STREAK_LIMIT = 6; // 连续空总结达到此数判定当日配额耗尽

  // chrome.storage 在 evaluate 注入调试时不存在，全部走这里兜底
  const hasStore = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  // ================= WBI 签名（与官方前端同款逻辑） =================
  const OE = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45,
              35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
              41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60,
              51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
              20, 34, 44, 52];
  let mixinKey = null, mixinTs = 0;

  async function getMixinKey() {
    if (mixinKey && Date.now() - mixinTs < 3600 * 1000) return mixinKey;
    const nav = await fetch('https://api.bilibili.com/x/web-interface/nav',
      { credentials: 'include' }).then(r => r.json());
    const img = nav.data.wbi_img.img_url.split('/').pop().split('.')[0];
    const sub = nav.data.wbi_img.sub_url.split('/').pop().split('.')[0];
    const val = img + sub;
    mixinKey = OE.reduce((s, v) => s + val[v], '').substring(0, 32);
    mixinTs = Date.now();
    return mixinKey;
  }

  async function wbiGet(url, params) {
    const key = await getMixinKey();
    params.wts = Math.floor(Date.now() / 1000);
    const qs = Object.keys(params).sort()
      .map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    const data = await fetch(`${url}?${qs}&w_rid=${md5(qs + key)}`,
      { credentials: 'include' }).then(r => r.json());
    if (data && data.code === -403) mixinKey = null; // 签名失效，下次重取
    return data;
  }

  // ================= 数据 =================
  // result: undefined=未请求, null=无总结或失败, {summary, outline}=有总结
  const cache = new Map();
  let emptyStreak = 0;   // 连续空总结计数（网络失败不计入）
  let quotaMarked = false;

  function setQuota(exhausted) {
    if (!hasStore || exhausted === quotaMarked) return;
    quotaMarked = exhausted;
    chrome.storage.local.set({
      biliGeminiFeedQuota: { date: new Date().toLocaleDateString('sv'), exhausted },
    });
    console.log(TAG, exhausted ? '连续空总结达到阈值，判定当日配额耗尽' : '拿到总结，配额标记解除');
  }

  async function getConclusion(bvid) {
    if (cache.has(bvid)) return cache.get(bvid);
    let result = null, apiOk = false;
    try {
      const view = await wbiGet('https://api.bilibili.com/x/web-interface/view', { bvid });
      if (view.code === 0) {
        const con = await wbiGet(
          'https://api.bilibili.com/x/web-interface/view/conclusion/get',
          { bvid, cid: view.data.cid, up_mid: view.data.owner.mid });
        const mr = con.code === 0 && con.data && con.data.model_result;
        apiOk = true;
        if (mr && mr.result_type === 2 && mr.summary) {
          result = { summary: mr.summary, outline: mr.outline || [] };
        }
      }
      console.log(TAG, bvid, result ? '有总结' : `无总结 (view=${view.code})`);
    } catch (e) {
      console.warn(TAG, bvid, '请求失败:', e);
    }
    // 只有接口正常返回但内容为空才计入连续空总结；网络失败不冤枉配额
    if (result) { emptyStreak = 0; setQuota(false); }
    else if (apiOk && ++emptyStreak >= EMPTY_STREAK_LIMIT) setQuota(true);
    cache.set(bvid, result);
    return result;
  }

  // 并发受限的请求队列
  let running = 0;
  const queue = [];
  function enqueue(task) {
    queue.push(task);
    pump();
  }
  async function pump() {
    while (running < MAX_CONCURRENT && queue.length) {
      running++;
      const task = queue.shift();
      try { await task(); } finally { running--; pump(); }
    }
  }

  function fmtTime(sec) {
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ================= 样式 =================
  const style = document.createElement('style');
  style.textContent = [
    `.bili-gemini-feed-panel{width:${PANEL_W}px;max-height:480px;overflow-y:auto;padding:12px 14px;background:#fff;border:1px solid #e3e5e7;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.08);font-size:13px;line-height:1.7;color:#18191c;box-sizing:border-box;}`,
    '.bili-gemini-feed-panel.bili-gemini-feed-float{position:absolute;right:calc(100% + 12px);top:0;z-index:10;}',
    '.bili-gemini-feed-panel.bili-gemini-feed-inline{width:auto;margin:0 0 12px;}',
    '.bili-gemini-feed-title{font-weight:600;margin-bottom:6px;}',
    '.bili-gemini-feed-summary{white-space:pre-wrap;word-break:break-word;}',
    '.bili-gemini-feed-outline{margin-top:8px;border-top:1px dashed #e3e5e7;padding-top:8px;}',
    '.bili-gemini-feed-sec{display:block;padding:2px 0;color:#18191c;text-decoration:none;cursor:pointer;}',
    '.bili-gemini-feed-sec:hover{color:#00a1d6;}',
    '.bili-gemini-feed-sec .bili-gemini-feed-ts{color:#00a1d6;margin-right:6px;font-variant-numeric:tabular-nums;}',
    '.bili-gemini-feed-tip{color:#9499a0;}',
    '.bili-gemini-feed-dark .bili-gemini-feed-panel{background:#1f1f1f;border-color:#444;color:#e7e7e7;}',
    '.bili-gemini-feed-dark .bili-gemini-feed-sec{color:#e7e7e7;}',
    '.bili-gemini-feed-dark .bili-gemini-feed-outline{border-top-color:#444;}',
  ].join('\n');
  document.head.appendChild(style);

  // 深色模式：B 站夜间模式在 html 上挂 dark 类；系统深色兜底，任一命中即深色
  const darkMedia = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme(el) {
    const dark = document.documentElement.classList.contains('dark')
      || (document.body && document.body.classList.contains('dark'))
      || darkMedia.matches;
    el.classList.toggle('bili-gemini-feed-dark', !!dark);
  }
  // 面板是逐卡片创建的，统一挂到一个随主题变化刷新的列表上
  const themedEls = new Set();
  function applyThemeAll() { themedEls.forEach(applyTheme); }
  new MutationObserver(applyThemeAll).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  darkMedia.addEventListener('change', applyThemeAll);

  // ================= 渲染 =================
  function buildPanel(bvid, data) {
    const panel = document.createElement('div');
    panel.className = 'bili-gemini-feed-panel';

    const title = document.createElement('div');
    title.className = 'bili-gemini-feed-title';
    title.textContent = 'AI 总结';
    panel.appendChild(title);

    const summary = document.createElement('div');
    summary.className = 'bili-gemini-feed-summary';
    summary.textContent = data.summary;
    panel.appendChild(summary);

    if (data.outline.length) {
      const outline = document.createElement('div');
      outline.className = 'bili-gemini-feed-outline';
      for (const sec of data.outline) {
        const a = document.createElement('a');
        a.className = 'bili-gemini-feed-sec';
        a.href = `https://www.bilibili.com/video/${bvid}?t=${sec.timestamp}`;
        a.target = '_blank';
        a.rel = 'noopener';
        const ts = document.createElement('span');
        ts.className = 'bili-gemini-feed-ts';
        ts.textContent = fmtTime(sec.timestamp);
        a.appendChild(ts);
        a.appendChild(document.createTextNode(sec.title || ''));
        outline.appendChild(a);
      }
      panel.appendChild(outline);
    }
    themedEls.add(panel);
    applyTheme(panel);
    return panel;
  }

  // 卡片左缘外侧空间够就悬浮在左侧，否则插入卡片内部（视频卡片上方）
  function mount(card, panel) {
    if (card.getBoundingClientRect().left >= MIN_LEFT_SPACE) {
      panel.classList.add('bili-gemini-feed-float');
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      card.appendChild(panel);
    } else {
      panel.classList.add('bili-gemini-feed-inline');
      const videoCard = card.querySelector('.bili-dyn-card-video');
      if (videoCard) videoCard.parentElement.insertBefore(panel, videoCard);
      else card.appendChild(panel);
    }
  }

  // ================= 卡片处理 =================
  const observers = new Set(); // 所有 IntersectionObserver，disable 时统一断开
  let mutationObserver = null;
  let active = false;

  function processCard(card) {
    if (card.dataset.biliGeminiFeed) return;
    const a = card.querySelector('a.bili-dyn-card-video[href*="/video/BV"]');
    if (!a) return;
    const m = (a.getAttribute('href') || '').match(/BV[0-9A-Za-z]+/);
    if (!m) return;
    card.dataset.biliGeminiFeed = '1';
    const bvid = m[0];

    const io = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      observers.delete(io);
      enqueue(async () => {
        if (!active || !document.contains(card)) return; // 排队期间被关闭或卡片被删
        const data = await getConclusion(bvid);
        if (!active || !document.contains(card)) return;
        if (data) mount(card, buildPanel(bvid, data));
        // 无总结不渲染面板（cache 已记负面结果，不会重复请求）
      });
    });
    observers.add(io);
    io.observe(card);
  }

  function scan(root) {
    for (const card of root.querySelectorAll('.bili-dyn-item')) processCard(card);
  }

  function enable() {
    if (active) return;
    active = true;
    scan(document);
    mutationObserver = new MutationObserver(muts => {
      for (const mut of muts) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches('.bili-dyn-item')) processCard(node);
          else if (node.querySelector) scan(node);
        }
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    console.log(TAG, '已开启');
  }

  function disable() {
    if (!active) return;
    active = false;
    if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
    observers.forEach(io => io.disconnect());
    observers.clear();
    queue.length = 0; // 排队的请求直接丢弃
    document.querySelectorAll('.bili-gemini-feed-panel').forEach(p => { themedEls.delete(p); p.remove(); });
    // 清掉处理标记，重新开启时能完整重扫
    document.querySelectorAll('[data-bili-gemini-feed]').forEach(c => delete c.dataset.biliGeminiFeed);
    console.log(TAG, '已关闭');
  }

  // ================= 开关：读设置 + 实时响应 =================
  if (hasStore) {
    chrome.storage.local.get('biliGeminiSettings', r => {
      const s = r.biliGeminiSettings || {};
      if (s.feedSummary !== false) enable(); // 默认开
    });
    chrome.storage.onChanged.addListener((chg, area) => {
      if (area !== 'local' || !chg.biliGeminiSettings) return;
      const s = chg.biliGeminiSettings.newValue || {};
      if (s.feedSummary === false) disable();
      else enable();
    });
  } else {
    enable(); // 调试注入（无 chrome.storage）时默认开启
  }
})();
