// content.js - claude.aiのページ上で動作

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "fetch-conversation") {
    const match = location.pathname.match(/\/chat\/([0-9a-f-]+)/);
    if (!match) {
      sendResponse({ ok: false, error: "会話IDが見つかりません" });
      return false;
    }
    const convId = match[1];

    fetch("/api/organizations", { credentials: "include" })
      .then(r => r.json())
      .then(orgs => {
        const orgId = orgs[0]?.uuid;
        if (!orgId) throw new Error("Organization ID が取得できません");
        return fetch(
          `/api/organizations/${orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages`,
          { credentials: "include" }
        );
      })
      .then(r => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "get-url") {
    sendResponse({ url: location.href, path: location.pathname });
    return false;
  }
});
