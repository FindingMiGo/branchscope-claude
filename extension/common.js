// Shared state and logic for BranchScope viewer and sidepanel

var TOTAL = 0;
var SEG_TEXTS = {};
var SEG_UUIDS = {};
var root = null;
var svg, g, gL, gZ, gN, zoom, treeLayout;
var deletedRanges = [];
var confirmTarget = null;
var currentReaderNode = null;
var tooltip = document.getElementById('tooltip');

var searchHits = [];
var searchIdx = -1;
var searchTimer = null;

// ── Tree construction ──────────────────────────────

function buildTree(convData, onReady) {
  var msgsList = convData.chat_messages;
  var msg = {};
  msgsList.forEach(function(m) { msg[m.uuid] = m; });

  var childrenMap = {};
  msgsList.forEach(function(m) {
    var p = m.parent_message_uuid;
    if (p && msg[p]) {
      if (!childrenMap[p]) childrenMap[p] = [];
      childrenMap[p].push(m.uuid);
    }
  });

  var roots = msgsList.filter(function(m) {
    return !m.parent_message_uuid || !msg[m.parent_message_uuid];
  }).map(function(m) { return m.uuid; });
  var rootUuid = roots[0];

  function getText(uuid, maxLen) {
    maxLen = maxLen || 60;
    var cs = (msg[uuid] || {}).content || [];
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].type === 'text') {
        var t = (cs[i].text || '').trim().replace(/\n/g, ' ');
        if (t) return t.slice(0, maxLen);
      }
    }
    return '';
  }

  // DFS route numbering
  var routeNum = {};
  var counter = 0;
  var dfsStack = [rootUuid];
  while (dfsStack.length) {
    var uuid = dfsStack.pop();
    var kids = childrenMap[uuid] || [];
    if (!kids.length) { counter++; routeNum[uuid] = counter; }
    else { for (var i = kids.length - 1; i >= 0; i--) dfsStack.push(kids[i]); }
  }
  TOTAL = counter;

  // Compress into segments
  var segIdCtr = 0;
  function newSid() { return 's' + (++segIdCtr); }
  var segUuids = {}, segChildren = {};
  var rootSid = newSid();
  segUuids[rootSid] = []; segChildren[rootSid] = [];

  var bfsQ = [[rootUuid, rootSid]];
  while (bfsQ.length) {
    var item = bfsQ.shift();
    var u = item[0], sid = item[1];
    segUuids[sid].push(u);
    var ks = childrenMap[u] || [];
    if (ks.length === 1) {
      bfsQ.push([ks[0], sid]);
    } else if (ks.length > 1) {
      ks.forEach(function(kid) {
        var csid = newSid();
        segUuids[csid] = []; segChildren[csid] = [];
        segChildren[sid].push(csid);
        bfsQ.push([kid, csid]);
      });
    }
  }

  // Topological order for route range computation
  var topo = [], topoStack = [rootSid], topoVisited = {};
  while (topoStack.length) {
    var s = topoStack.pop();
    if (topoVisited[s]) continue;
    topoVisited[s] = true;
    topo.push(s);
    (segChildren[s] || []).forEach(function(c) { topoStack.push(c); });
  }

  var segRmin = {}, segRmax = {};
  for (var ti = topo.length - 1; ti >= 0; ti--) {
    var sid = topo[ti];
    var cs = segChildren[sid] || [];
    if (!cs.length) {
      var lu = segUuids[sid][segUuids[sid].length - 1];
      var rn = routeNum[lu] || -1;
      segRmin[sid] = rn; segRmax[sid] = rn;
    } else {
      segRmin[sid] = Math.min.apply(null, cs.map(function(c) { return segRmin[c]; }));
      segRmax[sid] = Math.max.apply(null, cs.map(function(c) { return segRmax[c]; }));
    }
  }

  // Longest path (most messages from root to leaf)
  function segDepth(sid) {
    var cs = segChildren[sid] || [];
    if (!cs.length) return segUuids[sid].length;
    var maxChild = 0;
    for (var i = 0; i < cs.length; i++) {
      var d = segDepth(cs[i]);
      if (d > maxChild) maxChild = d;
    }
    return segUuids[sid].length + maxChild;
  }
  var mainPathSids = {};
  var cur = rootSid;
  while (true) {
    mainPathSids[cur] = true;
    var cs = segChildren[cur] || [];
    if (!cs.length) break;
    cur = cs.reduce(function(b, s) {
      return segDepth(s) > segDepth(b) ? s : b;
    });
  }

  function segLabel(sid) {
    var uuids = segUuids[sid] || [];
    // Prefer human messages for labels
    for (var i = 0; i < uuids.length; i++) {
      if ((msg[uuids[i]] || {}).sender === 'human') {
        var t = getText(uuids[i], 50);
        if (t) return t;
      }
    }
    for (var i = 0; i < uuids.length; i++) {
      var t = getText(uuids[i], 50);
      if (t) return t;
    }
    return '(empty)';
  }

  // Expose segment UUIDs globally for branch navigation
  SEG_UUIDS = segUuids;

  // Build segment text data
  SEG_TEXTS = {};
  var maxMsgCount = 0;
  Object.keys(segUuids).forEach(function(sid) {
    var entries = [];
    segUuids[sid].forEach(function(uuid) {
      var m = msg[uuid] || {};
      var sender = m.sender === 'human' ? 'human' : 'assistant';
      var text = '';
      var content = m.content || [];
      for (var i = 0; i < content.length; i++) {
        if (content[i].type === 'text') { text = (content[i].text || '').trim(); break; }
      }
      if (text) entries.push({ role: sender, text: text });
    });
    SEG_TEXTS[sid] = entries;
    if (segUuids[sid].length > maxMsgCount) maxMsgCount = segUuids[sid].length;
  });

  function toD3(sid) {
    var cs = segChildren[sid] || [];
    var rmin = segRmin[sid], rmax = segRmax[sid];
    var node = {
      id: sid, label: segLabel(sid),
      route_min: rmin, route_max: rmax,
      leaf_count: rmax - rmin + 1, msg_count: segUuids[sid].length,
      n_branch: cs.length, is_main: !!mainPathSids[sid]
    };
    if (cs.length) node.children = cs.map(toD3);
    return node;
  }

  var treeData = toD3(rootSid);
  var totalSegs = Object.keys(segUuids).length;

  // Update stats UI
  document.getElementById('s-segs').textContent = totalSegs;
  document.getElementById('s-total').textContent = TOTAL;
  document.getElementById('s-keep').textContent = TOTAL;
  document.getElementById('s-del').textContent = '0';
  document.getElementById('threshold-slider').max = maxMsgCount;

  if (onReady) onReady(convData);
  initD3(treeData);
}

// ── D3 rendering ───────────────────────────────────

function initD3(treeData) {
  svg = d3.select('#main-svg');
  svg.selectAll('*').remove();
  g = svg.append('g');
  gL = g.append('g'); gZ = g.append('g'); gN = g.append('g');

  zoom = d3.zoom().scaleExtent([0.04, 4])
    .on('zoom', function(e) { g.attr('transform', e.transform); });
  svg.call(zoom);

  treeLayout = d3.tree().nodeSize([22, 230]);
  root = d3.hierarchy(treeData);
  root.x0 = 0; root.y0 = 0;
  root.each(function(d) { d._allChildren = d.children || d._children || null; });

  deletedRanges = [];
  update(root);
  resetView();
}

function nodeColor(d) {
  if (!d.children && !d._children) return '#3a3a50';
  var n = d.data.n_branch;
  if (n <= 1) return '#56d4c8';
  if (n === 2) return '#5ba4e6';
  if (n <= 4) return '#e8b931';
  return '#e85d6f';
}

function linkStroke(d) { return d.target.data.is_main ? '#e8b931' : '#2a2a40'; }
function linkW(d) { return 1.5; }

function diagonal(d) {
  var sx = d.source.y, sy = d.source.x, tx = d.target.y, ty = d.target.x, mx = (sx + tx) / 2;
  return 'M' + sx + ',' + sy + 'C' + mx + ',' + sy + ' ' + mx + ',' + ty + ' ' + tx + ',' + ty;
}

function routeLabel(rmin, rmax) {
  function pad(n) { return String(n).padStart(3, '0'); }
  return rmin === rmax ? 'route_' + pad(rmin) : 'route_' + pad(rmin) + '~' + pad(rmax);
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function update(source) {
  var DUR = 250;
  treeLayout(root);
  var nodes = root.descendants(), links = root.links();
  nodes.forEach(function(d) { d.y = d.depth * 240; });

  var sx0 = source.x0 !== undefined ? source.x0 : 0;
  var sy0 = source.y0 !== undefined ? source.y0 : 0;
  var zero = 'M' + sy0 + ',' + sx0 + 'C' + sy0 + ',' + sx0 + ' ' + sy0 + ',' + sx0 + ' ' + sy0 + ',' + sx0;

  // Links
  var lSel = gL.selectAll('.link').data(links, function(d) { return d.target.data.id; });
  var lEnter = lSel.enter().append('path')
    .attr('class', function(d) { return 'link' + (d.target.data.is_main ? ' is-main' : ''); })
    .attr('stroke', linkStroke).attr('stroke-width', linkW).attr('d', zero);
  lSel.merge(lEnter).transition().duration(DUR)
    .attr('stroke', linkStroke).attr('stroke-width', linkW).attr('d', diagonal);
  lSel.exit().transition().duration(DUR)
    .attr('d', 'M' + (source.y || 0) + ',' + (source.x || 0) + 'C' + (source.y || 0) + ',' + (source.x || 0) + ' ' + (source.y || 0) + ',' + (source.x || 0) + ' ' + (source.y || 0) + ',' + (source.x || 0))
    .remove();

  // Click zones
  var zSel = gZ.selectAll('.link-zone').data(links, function(d) { return d.target.data.id; });
  var zEnter = zSel.enter().append('path').attr('class', 'link-zone').attr('d', zero)
    .on('click', function(event, d) { event.stopPropagation(); openModal(event, d); })
    .on('mouseover', function(event, d) {
      showTip(event, '<b>Click to prune</b><br>' + routeLabel(d.target.data.route_min, d.target.data.route_max) + ' (' + d.target.data.leaf_count + ')');
    })
    .on('mousemove', function(e) { moveTip(e); })
    .on('mouseout', hideTip);
  zSel.merge(zEnter).transition().duration(DUR).attr('d', diagonal);
  zSel.exit().remove();

  // Nodes
  var nSel = gN.selectAll('.node').data(nodes, function(d) { return d.data.id; });
  var nEnter = nSel.enter().append('g')
    .attr('class', function(d) { return 'node' + (d.data.is_main ? ' is-main' : ''); })
    .attr('transform', 'translate(' + sy0 + ',' + sx0 + ')')
    .on('mouseover', function(event, d) {
      showTip(event,
        '<b>' + escHtml(d.data.label) + '</b><br>' +
        routeLabel(d.data.route_min, d.data.route_max) + ' (' + d.data.leaf_count + ')<br>' +
        d.data.msg_count + ' msg / ' + d.data.n_branch + ' branches' +
        (d.data.is_main ? '<br>Longest' : '')
      );
    })
    .on('mousemove', function(e) { moveTip(e); })
    .on('mouseout', hideTip);

  nEnter.append('circle')
    .attr('r', 0)
    .attr('fill', nodeColor)
    .attr('stroke', function(d) { return d.data.is_main ? '#e8b931' : 'rgba(255,255,255,0.15)'; })
    .on('click', function(event, d) {
      event.stopPropagation();
      if (d.children) { d._children = d.children; d.children = null; }
      else { d.children = d._children; d._children = null; }
      update(d);
    });

  nEnter.append('text')
    .attr('dy', '0.32em').attr('text-anchor', 'middle')
    .on('click', function(event, d) { event.stopPropagation(); openReader(d); });

  var nMerge = nSel.merge(nEnter);
  nMerge.transition().duration(DUR)
    .attr('transform', function(d) { return 'translate(' + d.y + ',' + d.x + ')'; });
  nMerge.select('circle')
    .attr('r', function(d) { return 4; })
    .attr('fill', nodeColor);
  nMerge.select('text')
    .attr('y', function(d) { return -(4 + 3); })
    .text(function(d) {
      var rmin = d.data.route_min, rmax = d.data.route_max;
      var rstr = rmin === rmax
        ? '[' + String(rmin).padStart(3, '0') + ']'
        : '[' + String(rmin).padStart(3, '0') + '-' + String(rmax).padStart(3, '0') + ']';
      var lbl = d.data.label.length > 18 ? d.data.label.slice(0, 18) + '...' : d.data.label;
      return rstr + ' ' + lbl;
    });

  nSel.exit().transition().duration(DUR)
    .attr('transform', 'translate(' + (source.y || 0) + ',' + (source.x || 0) + ')').remove();
  nodes.forEach(function(d) { d.x0 = d.x; d.y0 = d.y; });
}

// ── Modal ──────────────────────────────────────────

function openModal(event, d) {
  confirmTarget = d.target;
  var rmin = d.target.data.route_min, rmax = d.target.data.route_max;
  document.getElementById('modal-body').innerHTML =
    '<b>' + routeLabel(rmin, rmax) + '</b> (' + d.target.data.leaf_count + ' routes) will be pruned.';
  document.getElementById('modal-overlay').classList.add('show');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('show');
  confirmTarget = null;
}

function doDelete() {
  if (!confirmTarget) return;
  var d = confirmTarget;
  deletedRanges.push({ min: d.data.route_min, max: d.data.route_max, label: d.data.label });
  var parent = d.parent;
  [parent.children, parent._children].forEach(function(arr) {
    if (!arr) return;
    var idx = arr.indexOf(d);
    if (idx >= 0) arr.splice(idx, 1);
  });
  if (parent.children && parent.children.length === 0) parent.children = null;
  if (parent._children && parent._children.length === 0) parent._children = null;
  closeModal();
  updatePanel();
  update(parent);
}

function countDel() {
  var n = 0;
  deletedRanges.forEach(function(r) { n += r.max - r.min + 1; });
  return n;
}

function updatePanel() {
  var del = countDel(), keep = TOTAL - del;
  document.getElementById('s-del').textContent = del;
  document.getElementById('s-keep').textContent = keep;
}

// ── Reader ─────────────────────────────────────────

function openReader(d3node) {
  currentReaderNode = d3node;
  var sid = d3node.data.id;
  var rmin = d3node.data.route_min, rmax = d3node.data.route_max;
  var entries = SEG_TEXTS[sid] || [];

  document.getElementById('reader-title').textContent =
    routeLabel(rmin, rmax) + ' (' + entries.length + ' msg)';

  var body = document.getElementById('reader-body');
  body.innerHTML = '';
  if (!entries.length) {
    body.innerHTML = '<div style="color:var(--text-dim);font-style:italic">(empty)</div>';
  } else {
    entries.forEach(function(e) {
      var block = document.createElement('div');
      block.className = 'msg-block';
      var role = document.createElement('div');
      role.className = 'msg-role ' + e.role;
      role.textContent = e.role === 'human' ? 'YOU' : 'AI';
      var text = document.createElement('div');
      text.className = 'msg-text';
      text.textContent = e.text;
      block.appendChild(role);
      block.appendChild(text);
      body.appendChild(block);
    });
  }
  document.getElementById('reader').classList.add('open');
  body.scrollTop = 0;
}

function closeReader() {
  document.getElementById('reader').classList.remove('open');
  currentReaderNode = null;
}

function saveLog() {
  if (!currentReaderNode) return;
  var path = [];
  var node = currentReaderNode;
  while (node) { path.unshift(node.data.id); node = node.parent; }
  var lines = [];
  path.forEach(function(sid) {
    (SEG_TEXTS[sid] || []).forEach(function(e) {
      lines.push('[' + (e.role === 'human' ? 'HUMAN' : 'ASSISTANT') + ']');
      lines.push(e.text);
      lines.push('');
    });
  });
  var blob = new Blob([lines.join('\n')], { type: 'text/plain; charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = routeLabel(currentReaderNode.data.route_min, currentReaderNode.data.route_max) + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Tooltip ────────────────────────────────────────

function showTip(event, html) {
  tooltip.innerHTML = html; tooltip.style.display = 'block'; moveTip(event);
}
function moveTip(event) {
  tooltip.style.left = (event.clientX + 14) + 'px';
  tooltip.style.top = (event.clientY - 10) + 'px';
}
function hideTip() { tooltip.style.display = 'none'; }

// ── View reset ─────────────────────────────────────

var RESET_VIEW_SCALE = 0.4;
var RESET_VIEW_X = 100;

function resetView() {
  var H = document.getElementById('tree-area').clientHeight;
  svg.call(zoom.transform, d3.zoomIdentity.translate(RESET_VIEW_X, H / 2).scale(RESET_VIEW_SCALE));
}

// ── Threshold filter ───────────────────────────────

function countMsgsBelow(node) {
  var n = node.data.msg_count;
  (node._allChildren || []).forEach(function(c) { n += countMsgsBelow(c); });
  return n;
}

function countNodes(node) {
  var n = 1;
  (node.children || []).forEach(function(c) { n += countNodes(c); });
  return n;
}

function countAllNodes(node) {
  var n = 1;
  (node._allChildren || []).forEach(function(c) { n += countAllNodes(c); });
  return n;
}

function applyThreshold() {
  var val = parseInt(document.getElementById('threshold-slider').value, 10);
  document.getElementById('threshold-val').textContent = val;
  if (!root) return;
  filterTree(root, val);
  update(root);
  var total = countAllNodes(root);
  var visible = countNodes(root);
  var visEl = document.getElementById('visible-count');
  var hidEl = document.getElementById('hidden-count');
  if (visEl) visEl.textContent = visible;
  if (hidEl) hidEl.textContent = total - visible;
}

function filterTree(node, threshold) {
  var all = node._allChildren;
  if (!all) return;
  if (threshold === 0) {
    node.children = all;
    node._children = null;
    all.forEach(function(c) { filterTree(c, threshold); });
  } else {
    var show = [], hide = [];
    all.forEach(function(c) {
      if (countMsgsBelow(c) <= threshold) { hide.push(c); }
      else { show.push(c); filterTree(c, threshold); }
    });
    node.children = show.length ? show : null;
    node._children = hide.length ? hide : null;
  }
}

// ── Search ─────────────────────────────────────────

function doSearch() {
  var query = document.getElementById('search-input').value.trim().toLowerCase();
  var countEl = document.getElementById('search-count');
  var navEl = document.getElementById('search-nav');

  gN.selectAll('.node').classed('search-hit', false).classed('search-current', false);
  searchHits = [];
  searchIdx = -1;

  if (!query || !root) {
    countEl.textContent = '';
    navEl.style.display = 'none';
    return;
  }

  var matchSids = {};
  var sids = Object.keys(SEG_TEXTS);
  for (var si = 0; si < sids.length; si++) {
    var entries = SEG_TEXTS[sids[si]];
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].text.toLowerCase().indexOf(query) >= 0) {
        matchSids[sids[si]] = true;
        break;
      }
    }
  }

  root.each(function(d) {
    if (matchSids[d.data.id]) searchHits.push(d);
  });

  countEl.textContent = searchHits.length + ' hit' + (searchHits.length !== 1 ? 's' : '');
  if (searchHits.length > 0) {
    navEl.style.display = 'flex';
    var hitIds = {};
    searchHits.forEach(function(d) { hitIds[d.data.id] = true; });
    gN.selectAll('.node').classed('search-hit', function(d) { return !!hitIds[d.data.id]; });
    searchIdx = 0;
    showSearchCurrent();
  } else {
    navEl.style.display = 'none';
  }
}

function showSearchCurrent() {
  if (!searchHits.length) return;
  document.getElementById('search-pos').textContent = (searchIdx + 1) + '/' + searchHits.length;

  var curId = searchHits[searchIdx].data.id;
  gN.selectAll('.node').classed('search-current', function(d) { return d.data.id === curId; });

  var cur = searchHits[searchIdx];
  var area = document.getElementById('tree-area');
  svg.transition().duration(400).call(
    zoom.transform,
    d3.zoomIdentity.translate(area.clientWidth / 2 - cur.y * 0.6, area.clientHeight / 2 - cur.x * 0.6).scale(0.6)
  );
}

function searchNext() {
  if (!searchHits.length) return;
  searchIdx = (searchIdx + 1) % searchHits.length;
  showSearchCurrent();
}

function searchPrev() {
  if (!searchHits.length) return;
  searchIdx = (searchIdx - 1 + searchHits.length) % searchHits.length;
  showSearchCurrent();
}

function searchClear() {
  document.getElementById('search-input').value = '';
  doSearch();
}

// ── Shared event listener setup ────────────────────

function initCommonListeners() {
  document.getElementById('modal-overlay').addEventListener('click', function(e) {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });
  document.getElementById('threshold-slider').addEventListener('input', applyThreshold);
  document.getElementById('btn-save-log').addEventListener('click', saveLog);
  document.getElementById('reader-close').addEventListener('click', closeReader);
  document.getElementById('btn-modal-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-modal-confirm').addEventListener('click', doDelete);
  document.getElementById('search-input').addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 250);
  });
  document.getElementById('search-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); searchHits.length ? searchNext() : doSearch(); }
    if (e.key === 'Escape') { searchClear(); this.blur(); }
  });
  document.getElementById('search-prev').addEventListener('click', searchPrev);
  document.getElementById('search-next').addEventListener('click', searchNext);
  document.getElementById('search-clear').addEventListener('click', searchClear);

  var btnJump = document.getElementById('btn-jump-branch');
  if (btnJump) btnJump.addEventListener('click', function() {
    if (currentReaderNode) jumpToBranch(currentReaderNode);
  });
}

// ── Branch navigation ──────────────────────────────

function getPathUuids(d3node) {
  var path = [];
  var node = d3node;
  while (node) { path.unshift(node.data.id); node = node.parent; }
  var uuids = [];
  path.forEach(function(sid) {
    (SEG_UUIDS[sid] || []).forEach(function(uuid) { uuids.push(uuid); });
  });
  return uuids;
}

function jumpToBranch(d3node) {
  var uuids = getPathUuids(d3node);
  if (!uuids.length) { alert('UUID path is empty'); return; }

  var btn = document.getElementById('btn-jump-branch');
  if (btn) { btn.textContent = '⏳ Moving...'; btn.disabled = true; }

  function resetBtn() {
    if (btn) { btn.textContent = '↗ Continue here'; btn.disabled = false; }
  }

  chrome.tabs.query({ url: 'https://claude.ai/*' }, function(tabs) {
    if (chrome.runtime.lastError) {
      resetBtn();
      alert('tabs.query failed: ' + chrome.runtime.lastError.message);
      return;
    }
    var chatTab = null;
    for (var i = 0; i < (tabs || []).length; i++) {
      if (tabs[i].url && tabs[i].url.indexOf('/chat/') >= 0) { chatTab = tabs[i]; break; }
    }
    if (!chatTab) {
      resetBtn();
      alert('Claude.ai のチャットタブが見つかりません');
      return;
    }

    // 先にタブを切り替えてからスクリプトを実行
    // （executeScript は async 関数の完了を待てないため）
    chrome.tabs.update(chatTab.id, { active: true }, function() {
      if (chrome.runtime.lastError) {
        // タブ切替失敗時はリトライ
        setTimeout(function() {
          chrome.tabs.update(chatTab.id, { active: true });
        }, 300);
      }
      // セグメントの先頭テキスト（スクロール先のマッチング用）
      var segTexts = SEG_TEXTS[d3node.data.id] || [];
      var scrollText = '';
      for (var ti = 0; ti < segTexts.length; ti++) {
        if (segTexts[ti].text && segTexts[ti].text.length > 10) {
          scrollText = segTexts[ti].text.slice(0, 80);
          break;
        }
      }
      chrome.scripting.executeScript({
        target: { tabId: chatTab.id },
        world: 'MAIN',
        func: injectedNavigate,
        args: [uuids, scrollText]
      }, function() {
        resetBtn();
        if (chrome.runtime.lastError) {
          alert('Script injection failed: ' + chrome.runtime.lastError.message);
        }
      });
    });
  });
}

// この関数は chrome.scripting.executeScript (world: MAIN) で Claude.ai タブ内で直接実行される
function injectedNavigate(targetUuids, scrollText) {
  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function getFiber(el) {
    var key = Object.keys(el).find(function(k) {
      return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
    });
    return key ? el[key] : null;
  }

  // DOM要素からメッセージUUIDを抽出（React fiber経由）
  function extractMsgUuid(el) {
    var fiber = getFiber(el);
    for (var d = 0; d < 30 && fiber; d++) {
      var p = fiber.memoizedProps || fiber.pendingProps || {};
      // よくあるprop名
      if (p.uuid) return p.uuid;
      if (p.messageUuid) return p.messageUuid;
      if (p.message_uuid) return p.message_uuid;
      if (p.id && typeof p.id === 'string' && /^[0-9a-f]{8}-/.test(p.id)) return p.id;
      if (p.message && p.message.uuid) return p.message.uuid;
      if (p.msg && p.msg.uuid) return p.msg.uuid;
      // children props 内にUUIDがある場合
      var keys = Object.keys(p);
      for (var ki = 0; ki < keys.length; ki++) {
        var v = p[keys[ki]];
        if (v && typeof v === 'object' && !Array.isArray(v) && v.uuid &&
            typeof v.uuid === 'string' && /^[0-9a-f]{8}-/.test(v.uuid)) {
          return v.uuid;
        }
      }
      fiber = fiber.return;
    }
    return null;
  }

  function showToast(text, done) {
    var id = '__branchscope_toast';
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);'
        + 'background:rgba(20,20,36,0.92);color:#c8c8d8;border:1px solid rgba(255,255,255,0.1);'
        + 'border-radius:8px;padding:8px 18px;font:13px sans-serif;z-index:99999;'
        + 'backdrop-filter:blur(12px);transition:opacity 0.3s;';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    if (done) {
      setTimeout(function() {
        el.style.opacity = '0';
        setTimeout(function() { el.remove(); }, 400);
      }, 1500);
    }
  }

  async function run() {
    showToast('🔀 Navigating branch...');
    console.log('[BranchScope] injectedNavigate v4, uuids:', targetUuids.length);

    // 会話データ取得
    var convMatch = location.pathname.match(/\/chat\/([0-9a-f-]+)/);
    if (!convMatch) return { ok: false, error: '会話ページではありません' };

    var orgs = await fetch('/api/organizations', { credentials: 'include' }).then(function(r) { return r.json(); });
    var orgId = orgs[0] && orgs[0].uuid;
    if (!orgId) return { ok: false, error: 'Org ID not found' };

    var convData = await fetch(
      '/api/organizations/' + orgId + '/chat_conversations/' + convMatch[1] + '?tree=True&rendering_mode=messages',
      { credentials: 'include' }
    ).then(function(r) { return r.json(); });

    var messages = {};
    convData.chat_messages.forEach(function(m) { messages[m.uuid] = m; });

    var childrenOf = {};
    convData.chat_messages.forEach(function(m) {
      var p = m.parent_message_uuid;
      if (p) {
        if (!childrenOf[p]) childrenOf[p] = [];
        childrenOf[p].push(m.uuid);
      }
    });

    // 分岐点を特定
    var branchPoints = [];
    for (var i = 0; i < targetUuids.length; i++) {
      var uuid = targetUuids[i];
      var msg = messages[uuid];
      if (!msg) continue;
      var parentUuid = msg.parent_message_uuid;
      if (!parentUuid) continue;
      var siblings = childrenOf[parentUuid] || [];
      if (siblings.length > 1) {
        branchPoints.push({
          parentUuid: parentUuid,
          targetChildUuid: uuid,
          targetIndex: siblings.indexOf(uuid),
          totalSiblings: siblings.length
        });
      }
    }

    console.log('[BranchScope] Branch points to navigate:', branchPoints.length);
    if (!branchPoints.length) return { ok: true };

    // ブランチ切替ボタンを探す
    // Claude.ai: aria-label="以前のバージョン" (prev), "次のバージョン" (next)
    // 英語: "Previous version", "Next version" 等
    var PREV_LABELS = ['以前のバージョン', 'previous version', 'previous', 'prev'];
    var NEXT_LABELS = ['次のバージョン', 'next version', 'next'];

    function findVersionButtons() {
      var allBtns = document.querySelectorAll('button');
      var results = [];
      allBtns.forEach(function(b) {
        var aria = (b.getAttribute('aria-label') || '').toLowerCase();
        var isPrev = PREV_LABELS.some(function(l) { return aria === l; });
        var isNext = NEXT_LABELS.some(function(l) { return aria === l; });
        if (isPrev || isNext) {
          results.push({ el: b, type: isPrev ? 'prev' : 'next', aria: aria });
        }
      });
      return results;
    }

    // 各分岐点で、ブランチ切替ボタンを使って目的のブランチに移動
    for (var bi = 0; bi < branchPoints.length; bi++) {
      var bp = branchPoints[bi];
      console.log('[BranchScope] Navigating branch', bi + 1, '/', branchPoints.length,
        'target index:', bp.targetIndex, '/', bp.totalSiblings);

      // 現在のブランチ位置を確認するため、対象の親メッセージ付近のボタンを探す
      // 戦略: "以前のバージョン"/"次のバージョン" ボタンをクリックして
      //        目的のインデックスに到達するまで繰り返す

      var maxClicks = bp.totalSiblings + 2;
      var found = false;

      for (var attempt = 0; attempt < maxClicks && !found; attempt++) {
        // 現在のDOMの状態を確認
        var versionBtns = findVersionButtons();
        if (!versionBtns.length) {
          console.log('[BranchScope] No version buttons found, skipping');
          break;
        }

        // 親メッセージに最も近いボタンペアを見つける
        // user-message 要素から React fiber で UUID を確認
        var userMsgs = document.querySelectorAll('[data-testid="user-message"]');
        var currentChildUuid = null;

        // 各 user-message の UUID を fiber から取得して、
        // 目的の子UUIDが表示されているか確認
        for (var mi = 0; mi < userMsgs.length; mi++) {
          var msgUuid = extractMsgUuid(userMsgs[mi]);
          if (msgUuid === bp.targetChildUuid) {
            found = true;
            console.log('[BranchScope] Target branch already visible!');
            break;
          }
          // 兄弟のいずれかが表示されているか
          var siblings = childrenOf[bp.parentUuid] || [];
          if (siblings.indexOf(msgUuid) >= 0) {
            currentChildUuid = msgUuid;
          }
        }

        if (found) break;

        if (currentChildUuid) {
          var currentIdx = (childrenOf[bp.parentUuid] || []).indexOf(currentChildUuid);
          console.log('[BranchScope] Currently showing sibling index:', currentIdx, 'need:', bp.targetIndex);

          // 近いボタンを探す（currentChildUuid の user-message 要素の近く）
          var targetMsgEl = null;
          for (var mi = 0; mi < userMsgs.length; mi++) {
            if (extractMsgUuid(userMsgs[mi]) === currentChildUuid) {
              targetMsgEl = userMsgs[mi];
              break;
            }
          }

          if (targetMsgEl) {
            // このメッセージの祖先コンテナ内のバージョンボタンを探す
            var container = targetMsgEl;
            for (var up = 0; up < 6; up++) {
              if (container.parentElement) container = container.parentElement;
            }
            var localBtns = container.querySelectorAll('button');
            var prevBtn = null, nextBtn = null;
            localBtns.forEach(function(b) {
              var aria = (b.getAttribute('aria-label') || '').toLowerCase();
              if (PREV_LABELS.some(function(l) { return aria === l; })) prevBtn = b;
              if (NEXT_LABELS.some(function(l) { return aria === l; })) nextBtn = b;
            });

            var clickBtn = bp.targetIndex > currentIdx ? nextBtn : prevBtn;
            if (clickBtn) {
              console.log('[BranchScope] Clicking:', clickBtn.getAttribute('aria-label'));
              clickBtn.click();
              await sleep(500);
            } else {
              console.log('[BranchScope] No suitable button found near message');
              break;
            }
          } else {
            // メッセージ要素が見つからない場合、グローバルなボタンを使う
            var nextBtns = versionBtns.filter(function(b) { return b.type === 'next'; });
            var prevBtns = versionBtns.filter(function(b) { return b.type === 'prev'; });
            var clickBtn = bp.targetIndex > 0 ? (nextBtns[0] && nextBtns[0].el) : (prevBtns[0] && prevBtns[0].el);
            if (clickBtn) {
              console.log('[BranchScope] Clicking global button:', clickBtn.getAttribute('aria-label'));
              clickBtn.click();
              await sleep(500);
            } else {
              break;
            }
          }
        } else {
          // UUID確認できない場合、次のバージョンボタンを順にクリック
          var nextBtns = versionBtns.filter(function(b) { return b.type === 'next'; });
          if (nextBtns.length > 0) {
            console.log('[BranchScope] Clicking next (blind)');
            nextBtns[0].el.click();
            await sleep(500);
          } else {
            break;
          }
        }
      }

      if (found) {
        console.log('[BranchScope] Branch', bi + 1, 'navigation succeeded');
      } else {
        console.log('[BranchScope] Branch', bi + 1, 'navigation: could not confirm target');
      }

      await sleep(300);
    }

    // スクロール: テキストマッチ → scrollIntoView
    // Claude.ai のチャットコンテナを探す
    console.log('[BranchScope] scrollText:', JSON.stringify(scrollText));
    if (scrollText) {
      function stripMd(s) {
        return s.replace(/```[\s\S]*?```/g, '')
          .replace(/^#{1,6}\s*/gm, '')
          .replace(/^[-*_]{3,}\s*$/gm, '')
          .replace(/[*_`~#>\[\]()!|]/g, '')
          .replace(/\n/g, '').replace(/\s+/g, '');
      }
      var snippet = stripMd(scrollText).slice(0, 30);
      console.log('[BranchScope] Looking for snippet:', JSON.stringify(snippet));

      function findScrollTarget() {
        // user-message と通常のdivの両方を探す
        var candidates = document.querySelectorAll('div');
        for (var i = 0; i < candidates.length; i++) {
          var el = candidates[i];
          // 直接のテキストノードを持つ要素（深すぎない）
          var text = (el.innerText || '').replace(/\n/g, '').replace(/\s+/g, '');
          if (text.length > 3000) continue;
          if (text.indexOf(snippet) >= 0 && text.indexOf(snippet) < 80) {
            return el;
          }
        }
        // フォールバック: textContent に含む最小の要素
        var allEls = document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]');
        for (var i = 0; i < allEls.length; i++) {
          if ((allEls[i].textContent || '').replace(/\n/g, '').replace(/\s+/g, '').indexOf(snippet) >= 0 && (allEls[i].textContent || '').replace(/\n/g, '').replace(/\s+/g, '').indexOf(snippet) < 80) {
            return allEls[i];
          }
        }
        return null;
      }

      function doScroll() {
        var target = findScrollTarget();
        if (target) {
          // スクロールコンテナを探す（overflow: auto/scroll の祖先）
          var container = target.parentElement;
          while (container && container !== document.body) {
            var ov = getComputedStyle(container).overflowY;
            if (ov === 'auto' || ov === 'scroll') break;
            container = container.parentElement;
          }
          if (container && container !== document.body) {
            var targetRect = target.getBoundingClientRect();
            var containerRect = container.getBoundingClientRect();
            container.scrollTop += targetRect.top - containerRect.top - 80;
            console.log('[BranchScope] Scrolled via container');
          } else {
            target.scrollIntoView({ behavior: 'instant', block: 'center' });
            console.log('[BranchScope] Scrolled via scrollIntoView');
          }
          return true;
        }
        console.log('[BranchScope] Scroll target not found');
        return false;
      }

      await sleep(1000);
      doScroll();
      await sleep(1000);
      doScroll();
      await sleep(1500);
      doScroll();
      showToast('✓ Ready', true);
    } else {
      showToast('✓ Ready', true);
    }

    return { ok: true };
  }

  return run();
}
