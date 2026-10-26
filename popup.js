// 扩展弹窗：设置读写 + AI 小窗选择。
// 设置存 chrome.storage.local 的 biliGeminiSettings；配额状态在 biliGeminiFeedQuota
// （由 content-feed.js 在动态页检测到连续空总结时写入，按天判断，跨天自动失效）。
(() => {
  const DEFAULTS = { feedSummary: true, quickSummary: true, newConversation: true, fixedModel: false, aiProvider: 'gemini' };
  const PROVIDERS = [
    { id: 'gemini', name: 'Gemini', ready: true },
    { id: 'chatgpt', name: 'ChatGPT' },
    { id: 'grok', name: 'Grok' },
    { id: 'claude', name: 'Claude' },
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'glm', name: 'GLM' },
    { id: 'kimi', name: 'Kimi' },
  ];

  const $ = id => document.getElementById(id);
  let settings = { ...DEFAULTS };
  let loaded = false; // storage.get 回调前拨开关会拿纯 DEFAULTS 整体回写，冲掉已存值——未加载完不响应

  function save() {
    chrome.storage.local.set({ biliGeminiSettings: settings });
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1500);
  }

  function renderProviders() {
    const box = $('providers');
    box.innerHTML = '';
    for (const p of PROVIDERS) {
      const row = document.createElement('div');
      row.className = 'provider' + (settings.aiProvider === p.id ? ' sel' : '');

      const dot = document.createElement('span');
      dot.className = 'dot';
      row.appendChild(dot);

      const name = document.createElement('span');
      name.textContent = p.name;
      row.appendChild(name);

      if (!p.ready) {
        const soon = document.createElement('span');
        soon.className = 'soon';
        soon.textContent = '敬请期待';
        row.appendChild(soon);
      }

      row.addEventListener('click', () => {
        if (!p.ready) { toast(`${p.name}：敬请期待`); return; }
        settings.aiProvider = p.id;
        save();
        renderProviders();
      });
      box.appendChild(row);
    }
  }

  chrome.storage.local.get(['biliGeminiSettings', 'biliGeminiFeedQuota'], r => {
    settings = Object.assign({}, DEFAULTS, r.biliGeminiSettings);
    loaded = true;
    $('feedSummary').checked = settings.feedSummary !== false;
    $('quickSummary').checked = settings.quickSummary !== false;
    $('newConversation').checked = settings.newConversation !== false;
    $('newConversation').disabled = false;
    $('fixedModel').checked = settings.fixedModel === true;
    $('fixedModel').disabled = false;
    renderProviders();

    // 配额标记按天有效：日期变了就认为已重置
    const q = r.biliGeminiFeedQuota;
    const today = new Date().toLocaleDateString('sv'); // YYYY-MM-DD
    if (q && q.exhausted && q.date === today) $('quotaNote').hidden = false;
  });

  $('feedSummary').addEventListener('change', e => {
    if (!loaded) return; // 竞态守卫：设置还没读回来时不写
    settings.feedSummary = e.target.checked;
    save();
  });
  $('fixedModel').addEventListener('change', e => {
    if (!loaded) return;
    settings.fixedModel = e.target.checked;
    save();
  });
  $('newConversation').addEventListener('change', e => {
    if (!loaded) return;
    settings.newConversation = e.target.checked;
    save();
  });
  $('quickSummary').addEventListener('change', e => {
    if (!loaded) return;
    settings.quickSummary = e.target.checked;
    save();
  });
})();
