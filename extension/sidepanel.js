// Sidepanel-specific: runs inside Chrome side panel with content script data fetching

RESET_VIEW_SCALE = 0.35;
RESET_VIEW_X = 60;

async function loadData() {
  document.getElementById('loading').style.display = 'flex';
  document.getElementById('main').style.display = 'none';
  document.getElementById('error-text').style.display = 'none';
  document.getElementById('loading-text').textContent = 'Loading conversation...';

  try {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith('https://claude.ai/chat/')) {
      throw new Error('Claude.ai の会話ページを開いてください');
    }

    // Ensure content script is injected
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'get-url' });
    } catch (_) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise(function(r) { setTimeout(r, 300); });
    }

    document.getElementById('loading-text').textContent = 'Fetching tree data...';
    var resp = await chrome.tabs.sendMessage(tab.id, { type: 'fetch-conversation' });
    if (!resp || !resp.ok) throw new Error(resp?.error || 'データ取得に失敗');
    if (!resp.data.chat_messages) throw new Error('chat_messages が見つかりません');

    buildTree(resp.data, function() {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('main').style.display = 'flex';
    });
  } catch (err) {
    document.getElementById('loading-text').style.display = 'none';
    document.querySelector('.spinner').style.display = 'none';
    var errEl = document.getElementById('error-text');
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

// Event listeners
initCommonListeners();
document.getElementById('btn-reload').addEventListener('click', loadData);

loadData();
