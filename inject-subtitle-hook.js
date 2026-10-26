// 主世界注入（manifest 里 world: "MAIN", document_start）：
// hook window.fetch 和 XMLHttpRequest，拦截 B 站播放器自己请求的 AI 字幕
// （URL 含 ai_subtitle），把响应 JSON 通过 postMessage 转给隔离世界的内容脚本。
// 内容脚本运行在隔离世界，碰不到页面自己的 window.fetch，必须在 MAIN world 里 hook。
// 所有拦截只读 clone 副本/监听 load，绝不影响原请求。
(() => {
  if (window.__biliGeminiHookLoaded) return;
  window.__biliGeminiHookLoaded = true;

  const isAiSubtitle = url => typeof url === 'string' && url.includes('ai_subtitle');
  const currentBvid = () => {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    return m ? m[1] : null;
  };
  const post = (url, data) => {
    window.postMessage({ source: 'bili-gemini-hook', type: 'AI_SUBTITLE', url, bvid: currentBvid(), data }, '*');
  };

  // ---- hook fetch ----
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const p = origFetch.apply(this, args);
    if (isAiSubtitle(url)) {
      // clone 出副本读 JSON，原响应照常交还给播放器；任何出错都放行
      p.then(resp => resp.clone().json())
        .then(data => post(url, data))
        .catch(() => { /* 解析失败也不影响原请求 */ });
    }
    return p;
  };

  // ---- hook XMLHttpRequest ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__biliGeminiUrl = url; // open 时记下 URL，send 时判断要不要拦截
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isAiSubtitle(this.__biliGeminiUrl)) {
      this.addEventListener('load', () => {
        try {
          post(this.__biliGeminiUrl, JSON.parse(this.responseText));
        } catch (e) { /* 非 JSON 响应，忽略 */ }
      });
    }
    return origSend.apply(this, args);
  };
})();
