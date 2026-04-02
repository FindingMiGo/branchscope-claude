// アイコンクリックで別タブに開く（会話IDを渡す）
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && tab.url.startsWith("https://claude.ai/chat/")) {
    const match = tab.url.match(/\/chat\/([0-9a-f-]+)/);
    const convId = match ? match[1] : "";
    chrome.tabs.create({
      url: chrome.runtime.getURL("viewer.html") + "?conv=" + convId
    });
  }
});

// viewer.htmlからのAPI取得リクエストを中継
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "api-fetch") {
    fetch(msg.url, { credentials: "include" })
      .then(r => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(text => sendResponse({ ok: true, text }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
