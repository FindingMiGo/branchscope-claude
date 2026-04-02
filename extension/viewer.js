// Viewer-specific: full-page tab opened from background.js

RESET_VIEW_SCALE = 0.4;
RESET_VIEW_X = 100;

async function apiFetch(url) {
  return new Promise(function(resolve, reject) {
    chrome.runtime.sendMessage({ type: 'api-fetch', url: url }, function(resp) {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error(resp?.error || 'fetch failed'));
      resolve(JSON.parse(resp.text));
    });
  });
}

async function loadData() {
  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('error-text').style.display = 'none';
  document.getElementById('loading-text').style.display = 'block';
  document.querySelector('.spinner').style.display = 'block';
  document.getElementById('loading-text').textContent = 'Loading conversation...';

  try {
    var params = new URLSearchParams(location.search);
    var convId = params.get('conv');
    if (!convId) throw new Error('会話IDがURLに含まれていません');

    document.getElementById('loading-text').textContent = 'Fetching organization...';
    var orgs = await apiFetch('https://claude.ai/api/organizations');
    var orgId = orgs[0]?.uuid;
    if (!orgId) throw new Error('Organization ID が取得できません');

    document.getElementById('loading-text').textContent = 'Fetching tree data...';
    var convData = await apiFetch(
      'https://claude.ai/api/organizations/' + orgId + '/chat_conversations/' + convId + '?tree=True&rendering_mode=messages'
    );
    if (!convData.chat_messages) throw new Error('chat_messages が見つかりません');

    buildTree(convData, function(data) {
      if (data.name) document.title = 'BranchScope - ' + data.name;
      document.getElementById('loading').classList.add('hidden');
      document.getElementById('panel').style.display = 'flex';
      document.getElementById('tree-area').style.display = 'block';
    });
  } catch (err) {
    document.getElementById('loading-text').style.display = 'none';
    document.querySelector('.spinner').style.display = 'none';
    var errEl = document.getElementById('error-text');
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

function copyDeleted() {
  var s = new Set();
  deletedRanges.forEach(function(r) { for (var i = r.min; i <= r.max; i++) s.add(i); });
  var nums = Array.from(s).sort(function(a, b) { return a - b; });
  if (!nums.length) { alert('No pruned routes'); return; }
  navigator.clipboard.writeText(nums.map(function(n) { return 'route_' + String(n).padStart(3, '0'); }).join('\n'))
    .then(function() { alert(nums.length + ' pruned routes copied'); });
}

function copyKept() {
  var del = new Set();
  deletedRanges.forEach(function(r) { for (var i = r.min; i <= r.max; i++) del.add(i); });
  var nums = Array.from({ length: TOTAL }, function(_, i) { return i + 1; }).filter(function(n) { return !del.has(n); });
  navigator.clipboard.writeText(nums.map(function(n) { return 'route_' + String(n).padStart(3, '0'); }).join('\n'))
    .then(function() { alert(nums.length + ' kept routes copied'); });
}

function resetAll() { if (confirm('Reset all?')) location.reload(); }

// Event listeners
initCommonListeners();
document.getElementById('btn-reset-view').addEventListener('click', resetView);
document.getElementById('btn-copy-del').addEventListener('click', copyDeleted);
document.getElementById('btn-copy-kept').addEventListener('click', copyKept);
document.getElementById('btn-reset-all').addEventListener('click', resetAll);

loadData();
