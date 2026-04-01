#!/usr/bin/env python3
"""
har_to_vis.py  <conversation.har | conversation.json>

HAR または JSON → 会話ツリー可視化HTML を1ステップで生成する。

生成物:
  tree_vis.html          … 可視化HTML
  tree_vis_segs/s*.txt   … セグメントごとの全文テキスト
"""

import sys
import json
import base64
import os
import pathlib
from collections import defaultdict

# ── 引数処理 ──────────────────────────────────────────
if len(sys.argv) < 2:
    print("使い方: python3 har_to_vis.py <conversation.har|.json> [output.html]")
    sys.exit(1)

INPUT_PATH = sys.argv[1]
HTML_PATH  = sys.argv[2] if len(sys.argv) > 2 else "tree_vis.html"
D3_PATH    = os.path.join(os.path.dirname(os.path.abspath(__file__)), "d3.v7.min.js")

# ── 入力ファイル読み込み（HAR / JSON 自動判定）─────────────
print(f"[1/4] 解析中: {INPUT_PATH}")
with open(INPUT_PATH, encoding="utf-8") as f:
    raw_data = json.load(f)

conv_data = None

if "chat_messages" in raw_data:
    # JSON直接形式（Claude API レスポンス）
    conv_data = raw_data
    print("  JSON形式（chat_messages）を検出")
elif "log" in raw_data and "entries" in raw_data.get("log", {}):
    # HAR形式
    for entry in raw_data["log"]["entries"]:
        url = entry["request"]["url"]
        if "tree=True" not in url:
            continue
        content = entry["response"]["content"]
        raw = content.get("text", "")
        if not raw:
            continue
        try:
            decoded = base64.b64decode(raw).decode("utf-8")
            conv_data = json.loads(decoded)
            print(f"  tree=True エンドポイント検出: {url[:80]}...")
            break
        except Exception:
            pass

if conv_data is None:
    print("ERROR: 会話データが見つかりません。")
    sys.exit(1)

# ── メッセージツリー構築 ───────────────────────────────
print("[2/4] メッセージツリー構築中")
msgs_list = conv_data["chat_messages"]
msg       = {m["uuid"]: m for m in msgs_list}

children_map: dict[str, list[str]] = defaultdict(list)
for m_obj in msgs_list:
    p = m_obj.get("parent_message_uuid")
    if p and p in msg:
        children_map[p].append(m_obj["uuid"])

roots = [
    m_obj["uuid"] for m_obj in msgs_list
    if not m_obj.get("parent_message_uuid") or m_obj["parent_message_uuid"] not in msg
]
root_uuid = roots[0]
print(f"  メッセージ数: {len(msg)}  根: 1  ")

def get_text(uuid: str, max_len: int = 60) -> str:
    for c in msg[uuid].get("content", []):
        if c.get("type") == "text":
            t = c.get("text", "").strip().replace("\n", " ")
            if t:
                return t[:max_len]
    return ""

# ── ルート番号付与（seikei.py と同じ DFS 順） ─────────────
route_num: dict[str, int] = {}
counter = 0
dfs_stack = [root_uuid]
while dfs_stack:
    uuid = dfs_stack.pop()
    kids = children_map.get(uuid, [])
    if not kids:
        counter += 1
        route_num[uuid] = counter
    else:
        for child in reversed(kids):
            dfs_stack.append(child)

total_routes = counter
print(f"  ルート総数: {total_routes}")

# ── 圧縮ツリー構築（線形チェーンを1セグメントに） ────────────
print("[3/4] 圧縮ツリー生成中")
seg_id_ctr = [0]
def new_sid() -> str:
    seg_id_ctr[0] += 1
    return f"s{seg_id_ctr[0]}"

seg_uuids:    dict[str, list[str]] = {}
seg_children: dict[str, list[str]] = {}

root_sid = new_sid()
seg_uuids[root_sid]    = []
seg_children[root_sid] = []

bfs_q = [(root_uuid, root_sid)]
while bfs_q:
    uuid, sid = bfs_q.pop(0)
    seg_uuids[sid].append(uuid)
    kids = children_map.get(uuid, [])
    if len(kids) == 0:
        pass
    elif len(kids) == 1:
        bfs_q.append((kids[0], sid))
    else:
        for kid in kids:
            csid = new_sid()
            seg_uuids[csid]    = []
            seg_children[csid] = []
            seg_children[sid].append(csid)
            bfs_q.append((kid, csid))

# ── 各セグメントの route_min / route_max 計算 ─────────────
topo: list[str] = []
topo_stack = [root_sid]
topo_visited: set[str] = set()
while topo_stack:
    s = topo_stack.pop()
    if s in topo_visited:
        continue
    topo_visited.add(s)
    topo.append(s)
    for c in seg_children.get(s, []):
        topo_stack.append(c)

seg_rmin: dict[str, int] = {}
seg_rmax: dict[str, int] = {}
for sid in reversed(topo):
    cs = seg_children.get(sid, [])
    if not cs:
        leaf_uuid = seg_uuids[sid][-1]
        rn = route_num.get(leaf_uuid, -1)
        seg_rmin[sid] = rn
        seg_rmax[sid] = rn
    else:
        seg_rmin[sid] = min(seg_rmin[c] for c in cs)
        seg_rmax[sid] = max(seg_rmax[c] for c in cs)

# ── 最有力ルート（各分岐で最多葉側を選択） ─────────────────
main_path_sids: set[str] = set()
cur = root_sid
while True:
    main_path_sids.add(cur)
    cs = seg_children.get(cur, [])
    if not cs:
        break
    cur = max(cs, key=lambda s: seg_rmax[s] - seg_rmin[s] + 1)

def seg_label(sid: str) -> str:
    for uuid in seg_uuids.get(sid, []):
        if msg[uuid].get("sender") == "human":
            t = get_text(uuid, 50)
            if t:
                return t
    for uuid in seg_uuids.get(sid, []):
        t = get_text(uuid, 50)
        if t:
            return t
    return "(空)"

def route_label(rmin: int, rmax: int) -> str:
    if rmin == rmax:
        return f"route_{rmin:03d}"
    return f"route_{rmin:03d}〜{rmax:03d}"

def to_d3(sid: str) -> dict:
    cs  = seg_children.get(sid, [])
    rmin = seg_rmin[sid]
    rmax = seg_rmax[sid]
    lc   = rmax - rmin + 1
    node: dict = {
        "id":        sid,
        "label":     seg_label(sid),
        "route_min": rmin,
        "route_max": rmax,
        "leaf_count": lc,
        "msg_count": len(seg_uuids.get(sid, [])),
        "n_branch":  len(cs),
        "is_main":   sid in main_path_sids,
    }
    if cs:
        node["children"] = [to_d3(c) for c in cs]
    return node

tree_data = to_d3(root_sid)
tree_json = json.dumps(tree_data, ensure_ascii=False)

# ── セグメント本文データ構築（HTML埋め込み用）──────────────
seg_texts: dict[str, list[dict]] = {}

for sid in seg_uuids:
    entries = []
    for uuid in seg_uuids[sid]:
        m = msg.get(uuid, {})
        sender = "human" if m.get("sender") == "human" else "assistant"
        text = ""
        for c in m.get("content", []):
            if c.get("type") == "text":
                text = c.get("text", "").strip()
                break
        if text:
            entries.append({"role": sender, "text": text})
    seg_texts[sid] = entries

seg_texts_json = json.dumps(seg_texts, ensure_ascii=False)

total_segs = len(seg_uuids)
max_msg_count = max(len(seg_uuids[sid]) for sid in seg_uuids)
print(f"  セグメント数: {total_segs}  最有力ルート: {len(main_path_sids)} セグメント")

# ── HTML 生成 ─────────────────────────────────────────
print(f"[4/4] HTML 生成中: {HTML_PATH}")

html_parts = []
html_parts.append("""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>BranchScope</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #161625; color: #e0e0e0;
       font-family: 'Segoe UI', sans-serif; display: flex; height: 100vh; overflow: hidden; }

/* ── 左サイドパネル ── */
#panel {
  width: 260px; min-width: 200px; background: #1e1e30;
  border-right: 1px solid #333; display: flex; flex-direction: column;
  padding: 14px 12px; gap: 10px; overflow-y: auto; flex-shrink: 0;
}
#panel h2 { margin: 0; font-size: 15px; color: #ffd700; }
.stat { font-size: 13px; }
.stat b { color: #ffd700; }
#deleted-list {
  overflow-y: auto; font-size: 12px;
  background: #13131f; border-radius: 6px; padding: 8px;
  min-height: 60px; max-height: 180px;
  white-space: pre-wrap; word-break: break-all; color: #ccc;
}
#deleted-list .empty { color: #555; font-style: italic; }
button {
  background: #2d2d45; color: #eee; border: 1px solid #444;
  border-radius: 5px; padding: 6px 10px; cursor: pointer; font-size: 12px;
  width: 100%; text-align: left;
}
button:hover { background: #3a3a58; }
button.danger { color: #ff6b6b; border-color: #552222; }
button.danger:hover { background: #3a2020; }
#legend { font-size: 11px; }
#legend div { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
.dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
hr { border: none; border-top: 1px solid #333; margin: 4px 0; }

/* ── ツリー本体 ── */
#tree-area { flex: 1; position: relative; overflow: hidden; }
svg { width: 100%; height: 100%; display: block; }
.link { fill: none; stroke-opacity: 0.45; }
.link.is-main { stroke-opacity: 0.85; }
.link-zone { fill: none; stroke: rgba(0,0,0,0); stroke-width: 18px; cursor: pointer; pointer-events: stroke; }
.node circle { stroke-width: 1.5px; cursor: pointer; }
.node text { font-size: 10.5px; fill: #bbb; cursor: pointer; }
.node text:hover { fill: #ffd700; text-decoration: underline; }
.node.is-main circle { stroke: #ffd700 !important; stroke-width: 2.5px; }
#btn-reset-view { position: absolute; top: 10px; right: 10px; width: auto; padding: 6px 14px; }

/* ── 右サイドパネル（テキスト表示）── */
#reader {
  width: 0; background: #1a1a2e; border-left: 1px solid #333;
  display: flex; flex-direction: column; flex-shrink: 0;
  transition: width 0.25s ease; overflow: hidden;
}
#reader.open { width: 420px; }
#reader-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-bottom: 1px solid #333; flex-shrink: 0;
}
#reader-header h3 { margin: 0; font-size: 13px; color: #ffd700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
#btn-save-log { background: #1a3a2a; color: #4ade80; border: 1px solid #2a5a3a; border-radius: 4px; font-size: 11px; cursor: pointer; width: auto; padding: 4px 10px; white-space: nowrap; }
#btn-save-log:hover { background: #2a4a3a; }
#reader-close { background: none; border: none; color: #888; font-size: 18px; cursor: pointer; width: auto; padding: 2px 6px; }
#reader-close:hover { color: #fff; }
#reader-body {
  flex: 1; overflow-y: auto; padding: 14px; font-size: 13px; line-height: 1.7;
}
.msg-block { margin-bottom: 16px; }
.msg-role {
  font-size: 11px; font-weight: bold; margin-bottom: 4px; padding: 2px 8px;
  border-radius: 3px; display: inline-block;
}
.msg-role.human { background: #2a3a2a; color: #4ade80; }
.msg-role.assistant { background: #2a2a3a; color: #818cf8; }
.msg-text { white-space: pre-wrap; word-break: break-word; color: #ddd; }

/* ── ツールチップ ── */
#tooltip {
  position: fixed; display: none; background: rgba(10,10,20,0.92);
  border: 1px solid #444; border-radius: 7px; padding: 8px 12px;
  font-size: 12px; max-width: 260px; pointer-events: none;
  z-index: 30; line-height: 1.6; color: #eee;
}

/* ── 確認モーダル ── */
#modal-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,0.55); z-index: 50;
  align-items: center; justify-content: center;
}
#modal-overlay.show { display: flex; }
#modal {
  background: #1e1e30; border: 1px solid #555; border-radius: 10px;
  padding: 22px 26px; max-width: 360px; width: 90%;
}
#modal h3 { margin: 0 0 10px; font-size: 14px; color: #ffd700; }
#modal p { font-size: 13px; margin: 0 0 16px; line-height: 1.6; color: #ccc; }
#modal .btns { display: flex; gap: 10px; justify-content: flex-end; }
#modal .btns button { width: auto; }
#btn-confirm { background: #552222; color: #ff8888; border-color: #772222; }
#btn-confirm:hover { background: #6a2020; }
</style>
</head>
<body>

<!-- 左サイドパネル -->
<div id="panel">
  <h2>&#x1F50D; BranchScope</h2>
""")

html_parts.append(f"""  <div class="stat">セグメント: <b>{total_segs}</b></div>
  <div class="stat">全ルート: <b id="total-count">{total_routes}</b> 本</div>
  <div class="stat">保持: <b id="keep-count" style="color:#4ade80">{total_routes}</b> 本</div>
  <div class="stat">除外: <b id="del-count" style="color:#f87171">0</b> 本</div>
""")

html_parts.append(f"""  <hr>
  <div style="font-size:12px;color:#aaa;margin-bottom:4px">
    <b>枝フィルタ</b>（メッセージ数しきい値）
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    <input type="range" id="threshold-slider" min="0" max="{max_msg_count}" value="0"
           style="flex:1;accent-color:#ffd700" oninput="applyThreshold()">
    <span id="threshold-val" style="font-size:13px;color:#ffd700;min-width:28px;text-align:right">0</span>
  </div>
  <div style="font-size:11px;color:#666;margin-top:2px">
    0 = 全表示 / 値以下のメッセージ数の枝を非表示
  </div>
  <div style="font-size:11px;color:#888;margin-top:2px">
    表示中: <b id="visible-count" style="color:#4ade80">-</b> / 非表示: <b id="hidden-count" style="color:#f87171">0</b>
  </div>
  <hr>""")

html_parts.append("""  <div style="font-size:11px;color:#aaa">
    <b>操作方法</b><br>
    ・ラベル（文字）クリック: 全文テキストを開く<br>
    ・ノード（点）クリック: 枝を折りたたむ<br>
    ・エッジ（線）クリック: 枝を除外
  </div>
  <hr>
  <div style="font-size:12px;color:#888;margin-bottom:4px">除外されたルート</div>
  <div id="deleted-list"><span class="empty">（まだ除外なし）</span></div>
  <button onclick="copyDeleted()">&#x1F4CB; 除外リストをコピー</button>
  <button onclick="copyKept()">&#x1F4CB; 保持リストをコピー</button>
  <button class="danger" onclick="resetAll()">&#x21A9; すべてリセット</button>
  <hr>
  <div id="legend">
    <div><span class="dot" style="background:#4ecdc4"></span>直線（分岐なし）</div>
    <div><span class="dot" style="background:#45b7d1"></span>2分岐</div>
    <div><span class="dot" style="background:#f9ca24"></span>3〜4分岐</div>
    <div><span class="dot" style="background:#e17055"></span>5分岐以上</div>
    <div><span class="dot" style="background:#555"></span>葉（終点）</div>
    <div><span class="dot" style="background:#555;border:2px solid #ffd700"></span>最有力ルート</div>
  </div>
</div>

<!-- ツリー本体 -->
<div id="tree-area">
  <button id="btn-reset-view" onclick="resetView()">&#x1F50D; リセット</button>
  <svg id="main-svg"></svg>
</div>

<!-- 右サイドパネル（テキスト表示）-->
<div id="reader">
  <div id="reader-header">
    <h3 id="reader-title"></h3>
    <button id="btn-save-log" onclick="saveLog()">&#x1F4BE; ここまで保存</button>
    <button id="reader-close" onclick="closeReader()">&times;</button>
  </div>
  <div id="reader-body"></div>
</div>

<!-- ツールチップ -->
<div id="tooltip"></div>

<!-- 確認モーダル -->
<div id="modal-overlay">
  <div id="modal">
    <h3>&#x26A0; 枝を除外</h3>
    <p id="modal-body"></p>
    <div class="btns">
      <button id="btn-cancel" onclick="closeModal()">キャンセル</button>
      <button id="btn-confirm" onclick="doDelete()">除外する</button>
    </div>
  </div>
</div>

<script>
""")

# D3.js インライン埋め込み
if os.path.exists(D3_PATH):
    with open(D3_PATH, encoding='utf-8') as _f:
        html_parts.append(_f.read())
    print("  D3.js インライン埋め込み完了")
else:
    html_parts.append('document.write("<h1>d3.v7.min.js が見つかりません</h1>");')

html_parts.append("\n</script>\n<script>\n")
html_parts.append("const RAW_DATA = ")
html_parts.append(tree_json)
html_parts.append(";\n")
html_parts.append(f"const TOTAL = {total_routes};\n")
html_parts.append("const SEG_TEXTS = ")
html_parts.append(seg_texts_json)
html_parts.append(";\n")

html_parts.append("""
var deletedRanges = [];
var confirmTarget = null;

// ── D3セットアップ ──────────────────────────────────
var svg  = d3.select('#main-svg');
var g    = svg.append('g');
var gL   = g.append('g');
var gZ   = g.append('g');
var gN   = g.append('g');

var zoom = d3.zoom().scaleExtent([0.04, 4])
               .on('zoom', function(e) { g.attr('transform', e.transform); });
svg.call(zoom);

var treeLayout = d3.tree().nodeSize([22, 230]);

function nodeColor(d) {
  if (!d.children && !d._children) return '#555';
  var n = d.data.n_branch;
  if (n <= 1) return '#4ecdc4';
  if (n === 2) return '#45b7d1';
  if (n <= 4) return '#f9ca24';
  return '#e17055';
}
function linkStroke(d) { return d.target.data.is_main ? '#ffd700' : '#4a4a6a'; }
function linkW(d) { return Math.max(1, Math.sqrt(d.target.data.leaf_count / TOTAL) * 14); }
function diagonal(d) {
  var sx = d.source.y, sy = d.source.x, tx = d.target.y, ty = d.target.x, mx = (sx+tx)/2;
  return 'M'+sx+','+sy+'C'+mx+','+sy+' '+mx+','+ty+' '+tx+','+ty;
}

// ── ツリー初期化（全展開） ────────────────────────────
var root = d3.hierarchy(RAW_DATA);
root.x0 = 0;
root.y0 = 0;

// ── ルートラベル ──────────────────────────────────
function routeLabel(rmin, rmax) {
  function pad(n) { return String(n).padStart(3, '0'); }
  return rmin === rmax ? 'route_'+pad(rmin) : 'route_'+pad(rmin)+'~'+pad(rmax);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

var tooltip = document.getElementById('tooltip');

// ── 描画 ──────────────────────────────────────────
function update(source) {
  var DUR = 250;
  treeLayout(root);
  var nodes = root.descendants();
  var links = root.links();
  nodes.forEach(function(d) { d.y = d.depth * 240; });

  var sx0 = source.x0 !== undefined ? source.x0 : 0;
  var sy0 = source.y0 !== undefined ? source.y0 : 0;
  var zero = 'M'+sy0+','+sx0+'C'+sy0+','+sx0+' '+sy0+','+sx0+' '+sy0+','+sx0;

  // links
  var lSel = gL.selectAll('.link').data(links, function(d) { return d.target.data.id; });
  var lEnter = lSel.enter().append('path')
    .attr('class', function(d) { return 'link'+(d.target.data.is_main?' is-main':''); })
    .attr('stroke', linkStroke).attr('stroke-width', linkW).attr('d', zero);
  lSel.merge(lEnter).transition().duration(DUR)
    .attr('stroke', linkStroke).attr('stroke-width', linkW).attr('d', diagonal);
  lSel.exit().transition().duration(DUR)
    .attr('d', 'M'+(source.y||0)+','+(source.x||0)+'C'+(source.y||0)+','+(source.x||0)+' '+(source.y||0)+','+(source.x||0)+' '+(source.y||0)+','+(source.x||0))
    .remove();

  // click zones
  var zSel = gZ.selectAll('.link-zone').data(links, function(d) { return d.target.data.id; });
  var zEnter = zSel.enter().append('path').attr('class', 'link-zone').attr('d', zero)
    .on('click', function(event, d) { event.stopPropagation(); openModal(event, d); })
    .on('mouseover', function(event, d) {
      var rmin=d.target.data.route_min, rmax=d.target.data.route_max, lc=d.target.data.leaf_count;
      showTip(event, '<b>クリックで除外</b><br>'+routeLabel(rmin,rmax)+'('+lc+'本)');
    })
    .on('mousemove', function(e) { moveTip(e); })
    .on('mouseout', hideTip);
  zSel.merge(zEnter).transition().duration(DUR).attr('d', diagonal);
  zSel.exit().remove();

  // nodes
  var nSel = gN.selectAll('.node').data(nodes, function(d) { return d.data.id; });
  var nEnter = nSel.enter().append('g')
    .attr('class', function(d) { return 'node'+(d.data.is_main?' is-main':''); })
    .attr('transform', 'translate('+sy0+','+sx0+')')
    .on('mouseover', function(event, d) {
      var rmin=d.data.route_min, rmax=d.data.route_max;
      showTip(event,
        '<b>'+escHtml(d.data.label)+'</b><br>'+
        routeLabel(rmin,rmax)+'('+d.data.leaf_count+'本)<br>'+
        d.data.msg_count+'msg / 分岐:'+d.data.n_branch+
        (d.data.is_main?'<br><b>★ 最有力ルート</b>':'')+
        '<br><span style="color:#aaa;font-size:11px">ラベルクリックで全文表示</span>'
      );
    })
    .on('mousemove', function(e) { moveTip(e); })
    .on('mouseout', hideTip);

  // 円クリック → 折りたたみ
  nEnter.append('circle')
    .attr('r', 0)
    .attr('fill', nodeColor)
    .attr('stroke', function(d) { return d.data.is_main ? '#ffd700' : '#888'; })
    .on('click', function(event, d) {
      event.stopPropagation();
      if (d.children) { d._children = d.children; d.children = null; }
      else             { d.children = d._children; d._children = null; }
      update(d);
    });

  // テキストラベルクリック → 右パネルに全文表示
  nEnter.append('text')
    .attr('dy', '0.32em')
    .attr('text-anchor', 'middle')
    .on('click', function(event, d) {
      event.stopPropagation();
      openReader(d);
    });

  var nMerge = nSel.merge(nEnter);
  nMerge.transition().duration(DUR)
    .attr('transform', function(d) { return 'translate('+d.y+','+d.x+')'; });
  nMerge.select('circle')
    .attr('r', function(d) { return Math.max(4, Math.sqrt(d.data.leaf_count)*1.6); })
    .attr('fill', nodeColor);
  nMerge.select('text')
    .attr('y', function(d) { return -(Math.max(4, Math.sqrt(d.data.leaf_count)*1.6)+3); })
    .text(function(d) {
      var rmin=d.data.route_min, rmax=d.data.route_max;
      var rstr = rmin===rmax
        ? '['+String(rmin).padStart(3,'0')+']'
        : '['+String(rmin).padStart(3,'0')+'-'+String(rmax).padStart(3,'0')+']';
      var lbl = d.data.label.length>18 ? d.data.label.slice(0,18)+'...' : d.data.label;
      return rstr+' '+lbl;
    });

  nSel.exit().transition().duration(DUR)
    .attr('transform', 'translate('+(source.y||0)+','+(source.x||0)+')').remove();

  nodes.forEach(function(d) { d.x0=d.x; d.y0=d.y; });
}

// ── モーダル ──────────────────────────────────────
function openModal(event, d) {
  confirmTarget = d.target;
  var rmin=d.target.data.route_min, rmax=d.target.data.route_max, lc=d.target.data.leaf_count;
  document.getElementById('modal-body').innerHTML =
    '<b>'+routeLabel(rmin,rmax)+'</b>（'+lc+' 本）を除外しますか？';
  document.getElementById('modal-overlay').classList.add('show');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('show');
  confirmTarget = null;
}
document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

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
  if (parent.children   && parent.children.length   === 0) parent.children   = null;
  if (parent._children  && parent._children.length  === 0) parent._children  = null;
  closeModal();
  updatePanel();
  update(parent);
}

// ── パネル更新 ──────────────────────────────────
function countDel() {
  var n=0; deletedRanges.forEach(function(r){n+=r.max-r.min+1;}); return n;
}
function delSet() {
  var s=new Set();
  deletedRanges.forEach(function(r){for(var i=r.min;i<=r.max;i++)s.add(i);}); return s;
}
function updatePanel() {
  var del=countDel(), keep=TOTAL-del;
  document.getElementById('del-count').textContent=del;
  document.getElementById('keep-count').textContent=keep;
  var el=document.getElementById('deleted-list');
  if (deletedRanges.length===0) {
    el.innerHTML='<span class="empty">（まだ除外なし）</span>'; return;
  }
  el.textContent=deletedRanges.map(function(r){
    return routeLabel(r.min,r.max)+' ('+(r.max-r.min+1)+'本) — '+r.label.slice(0,20);
  }).join('\\n');
}
function copyDeleted() {
  var nums=Array.from(delSet()).sort(function(a,b){return a-b;});
  if (!nums.length){alert('除外ルートはありません');return;}
  navigator.clipboard.writeText(nums.map(function(n){return 'route_'+String(n).padStart(3,'0');}).join('\\n'))
    .then(function(){alert(nums.length+'本の除外ルートをコピーしました');});
}
function copyKept() {
  var del=delSet();
  var nums=Array.from({length:TOTAL},function(_,i){return i+1;}).filter(function(n){return !del.has(n);});
  navigator.clipboard.writeText(nums.map(function(n){return 'route_'+String(n).padStart(3,'0');}).join('\\n'))
    .then(function(){alert(nums.length+'本の保持ルートをコピーしました');});
}
function resetAll() {
  if (confirm('除外をすべてリセットしますか？')) location.reload();
}

// ── 右パネル（テキスト表示）──────────────────────
var currentReaderNode = null;

function openReader(d3node) {
  currentReaderNode = d3node;
  var sid = d3node.data.id;
  var rmin = d3node.data.route_min, rmax = d3node.data.route_max;
  var entries = SEG_TEXTS[sid] || [];
  var title = routeLabel(rmin, rmax) + ' (' + entries.length + ' msg)';
  document.getElementById('reader-title').textContent = title;
  var body = document.getElementById('reader-body');
  body.innerHTML = '';
  if (entries.length === 0) {
    body.innerHTML = '<div style="color:#666;font-style:italic">（テキストなし）</div>';
  } else {
    entries.forEach(function(e) {
      var block = document.createElement('div');
      block.className = 'msg-block';
      var role = document.createElement('div');
      role.className = 'msg-role ' + e.role;
      role.textContent = e.role === 'human' ? 'あなた' : 'AI';
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

// ── ログ保存（ルートから現在のセグメントまで結合）──────
function saveLog() {
  if (!currentReaderNode) return;
  // ルートまで遡ってセグメントIDを収集
  var path = [];
  var node = currentReaderNode;
  while (node) {
    path.unshift(node.data.id);
    node = node.parent;
  }
  // 各セグメントのテキストを結合
  var lines = [];
  path.forEach(function(sid) {
    var entries = SEG_TEXTS[sid] || [];
    entries.forEach(function(e) {
      var role = e.role === 'human' ? 'HUMAN' : 'ASSISTANT';
      lines.push('[' + role + ']');
      lines.push(e.text);
      lines.push('');
    });
  });
  var text = lines.join('\\n');
  var rmin = currentReaderNode.data.route_min;
  var rmax = currentReaderNode.data.route_max;
  var fname = routeLabel(rmin, rmax) + '.txt';
  // ダウンロード
  var blob = new Blob([text], {type: 'text/plain; charset=utf-8'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── ツールチップ ──────────────────────────────
function showTip(event, html) {
  tooltip.innerHTML=html; tooltip.style.display='block'; moveTip(event);
}
function moveTip(event) {
  tooltip.style.left=(event.clientX+14)+'px'; tooltip.style.top=(event.clientY-10)+'px';
}
function hideTip() { tooltip.style.display='none'; }

// ── リセットビュー ────────────────────────────
function resetView() {
  var H=window.innerHeight;
  svg.call(zoom.transform, d3.zoomIdentity.translate(100, H/2).scale(0.4));
}

// ── しきい値フィルタ ─────────────────────────────
root.each(function(d) {
  d._allChildren = d.children || d._children || null;
});

var currentThreshold = 0;

function countMsgsBelow(node) {
  var n = node.data.msg_count;
  var kids = node._allChildren || [];
  kids.forEach(function(c) { n += countMsgsBelow(c); });
  return n;
}

function applyThreshold() {
  var val = parseInt(document.getElementById('threshold-slider').value, 10);
  currentThreshold = val;
  document.getElementById('threshold-val').textContent = val;
  filterTree(root, val);
  var counts = countVisibility(root);
  document.getElementById('visible-count').textContent = counts.visible;
  document.getElementById('hidden-count').textContent = counts.hidden;
  update(root);
}

function filterTree(node, threshold) {
  var all = node._allChildren;
  if (!all) return;
  if (threshold === 0) {
    node.children = all;
    node._children = null;
    all.forEach(function(c) { filterTree(c, threshold); });
  } else {
    var show = [];
    var hide = [];
    all.forEach(function(c) {
      var total = countMsgsBelow(c);
      if (total <= threshold) {
        hide.push(c);
      } else {
        show.push(c);
        filterTree(c, threshold);
      }
    });
    node.children = show.length > 0 ? show : null;
    node._children = hide.length > 0 ? hide : null;
  }
}

function countVisibility(node) {
  var visible = 1, hidden = 0;
  if (node.children) {
    node.children.forEach(function(c) {
      var r = countVisibility(c);
      visible += r.visible;
      hidden += r.hidden;
    });
  }
  if (node._children) {
    node._children.forEach(function(c) {
      hidden += countAllBelow(c);
    });
  }
  return {visible: visible, hidden: hidden};
}

function countAllBelow(node) {
  var n = 1;
  var kids = node._allChildren || [];
  kids.forEach(function(c) { n += countAllBelow(c); });
  return n;
}

// ── 起動 ─────────────────────────────────────
update(root);
resetView();
applyThreshold();
</script>
</body>
</html>
""")

html = "".join(html_parts)

with open(HTML_PATH, "w", encoding="utf-8") as f:
    f.write(html)

size_kb = os.path.getsize(HTML_PATH) // 1024
print(f"完了: {HTML_PATH}  ({size_kb} KB)")
print(f"  ブラウザで開いてください")
