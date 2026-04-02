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

  if (msg.type === "navigate-to-branch") {
    navigateToBranch(msg.uuids)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ── Branch navigation ──────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function navigateToBranch(targetUuids) {
  if (!targetUuids || !targetUuids.length) throw new Error("UUID list is empty");

  console.log('[BranchScope] navigateToBranch v2, uuids:', targetUuids.length);

  // 全ボタンの aria-label を収集
  const ariaMap = {};
  document.querySelectorAll('button').forEach(b => {
    const a = b.getAttribute('aria-label');
    if (a) ariaMap[a] = (ariaMap[a] || 0) + 1;
  });
  console.log('[BranchScope] All button aria-labels:', JSON.stringify(ariaMap));

  // 全 data-testid を収集
  const testidMap = {};
  document.querySelectorAll('[data-testid]').forEach(el => {
    const t = el.getAttribute('data-testid');
    testidMap[t] = (testidMap[t] || 0) + 1;
  });
  console.log('[BranchScope] All data-testid:', JSON.stringify(testidMap));

  // user-message の親構造を調査
  const firstMsg = document.querySelector('[data-testid="user-message"]');
  if (firstMsg) {
    let ancestry = [];
    let el = firstMsg;
    for (let d = 0; d < 10 && el; d++) {
      const info = el.tagName +
        (el.className ? '.' + String(el.className).replace(/\s+/g, '.').slice(0, 80) : '') +
        (el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : '');
      ancestry.push(info);
      el = el.parentElement;
    }
    console.log('[BranchScope] user-message ancestry:', ancestry);
  }

  // SVGを含むボタンの詳細（ブランチ切替はSVGアイコンだけのボタンの可能性）
  const svgButtons = [];
  document.querySelectorAll('button').forEach(b => {
    if (b.querySelector('svg') && b.textContent.trim().length === 0) {
      const rect = b.getBoundingClientRect();
      svgButtons.push({
        aria: b.getAttribute('aria-label'),
        testid: b.getAttribute('data-testid'),
        class: String(b.className).slice(0, 60),
        size: Math.round(rect.width) + 'x' + Math.round(rect.height),
        visible: rect.width > 0
      });
    }
  });
  console.log('[BranchScope] SVG-only buttons:', svgButtons.length, svgButtons.slice(0, 15));

  // React fiber をもっと広い範囲で探す
  const sampleEls = document.querySelectorAll('[data-testid="user-message"]');
  for (let i = 0; i < Math.min(sampleEls.length, 3); i++) {
    const el = sampleEls[i];
    const keys = Object.keys(el).filter(k => k.startsWith('__react'));
    console.log('[BranchScope] React keys on user-message[' + i + ']:', keys);
    if (keys.length > 0) {
      // fiber tree を探索してUUID的な値を探す
      let fiber = el[keys[0]];
      const found = [];
      for (let d = 0; d < 30 && fiber; d++) {
        const p = fiber.memoizedProps || fiber.pendingProps || {};
        const pKeys = Object.keys(p);
        for (const pk of pKeys) {
          const v = p[pk];
          if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}/.test(v)) {
            found.push(d + ':' + pk + '=' + v);
          }
          if (v && typeof v === 'object' && v.uuid) {
            found.push(d + ':' + pk + '.uuid=' + v.uuid);
          }
        }
        fiber = fiber.return;
      }
      console.log('[BranchScope] UUIDs found in fiber[' + i + ']:', found);
    }
  }

  console.log('[BranchScope] === Diagnosis complete ===');
}
