/**
 * Renders a Decision Review artifact as one self-contained HTML file: no CDN,
 * no framework, no build step, no external requests. The page is intentionally
 * reviewer-first (overview, impact, risks, evidence, approval) with the decision
 * graph as an interactive center panel.
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function reviewBadge(review) {
  const text = review ?? "unknown";
  return `<span class="pill review-${text}">${text}</span>`;
}

function riskDot(risk) {
  return risk ? `<span class="dot risk-${risk}" title="risk: ${escapeHtml(risk)}"></span>` : "";
}

function renderNodeLabel(node) {
  return (
    `<span class="node-row" data-id="${escapeHtml(node.id)}">` +
      `<span class="pill status-${node.status}">${node.status}</span>` +
      reviewBadge(node.review) +
      riskDot(node.risk) +
      `<span class="title">${escapeHtml(node.title)}</span>` +
    `</span>`
  );
}

function renderNodeTree(graph, id) {
  const node = graph.nodes[id];
  const label = renderNodeLabel(node);
  if (!node.children.length) return `<div class="node leaf">${label}</div>`;
  const childrenHtml = node.children.map((childId) => renderNodeTree(graph, childId)).join("");
  return `<details open class="node"><summary>${label}</summary><div class="children">${childrenHtml}</div></details>`;
}

function nonRootNodes(graph) {
  return Object.values(graph.nodes).filter((node) => node.id !== graph.root_id);
}

function fileImpactRows(graph) {
  const rows = new Map();
  for (const node of nonRootNodes(graph)) {
    for (const file of node.affected_files ?? []) {
      if (!rows.has(file)) {
        rows.set(file, { file, count: 0, risk: "low", review: new Set(), titles: [] });
      }
      const row = rows.get(file);
      row.count += 1;
      row.titles.push(node.title);
      row.review.add(node.review ?? "unknown");
      if (node.risk === "high") row.risk = "high";
      else if (node.risk === "medium" && row.risk !== "high") row.risk = "medium";
    }
  }
  return Array.from(rows.values())
    .map((row) => ({ ...row, review: Array.from(row.review) }))
    .sort((a, b) => {
      const rank = { high: 3, medium: 2, low: 1 };
      return rank[b.risk] - rank[a.risk] || b.count - a.count || a.file.localeCompare(b.file);
    });
}

function computeSummary(graph) {
  const nodes = nonRootNodes(graph);
  const resolved = nodes.filter((node) => node.status === "resolved").length;
  const reviewCounts = {
    verified: nodes.filter((node) => node.review === "verified").length,
    assumed: nodes.filter((node) => node.review === "assumed").length,
    inferred: nodes.filter((node) => node.review === "inferred").length,
    conflict: nodes.filter((node) => node.review === "conflict").length,
    unknown: nodes.filter((node) => !node.review || node.review === "unknown").length,
  };
  const concerns = nodes.filter((node) => {
    if (node.review === "conflict") return true;
    if (node.risk === "high") return true;
    if (node.status !== "resolved" && (node.risk === "medium" || node.review === "assumed")) return true;
    return false;
  }).length;
  const confidenceSamples = nodes.filter((node) => typeof node.confidence === "number").map((node) => node.confidence);
  let confidence;
  if (confidenceSamples.length) {
    confidence = Math.round(confidenceSamples.reduce((sum, value) => sum + value, 0) / confidenceSamples.length);
  } else if (!nodes.length) {
    confidence = 100;
  } else {
    const weight = { verified: 1, inferred: 0.75, assumed: 0.55, unknown: 0.45, conflict: 0.2 };
    const avg = nodes.reduce((sum, node) => sum + weight[node.review ?? "unknown"], 0) / nodes.length;
    confidence = Math.round(avg * 100);
  }

  const fileRows = fileImpactRows(graph);
  const highImpact = fileRows.filter((row) => row.risk === "high").length;
  const mediumImpact = fileRows.filter((row) => row.risk === "medium").length;
  const lowImpact = fileRows.filter((row) => row.risk === "low").length;

  return {
    nodeCount: nodes.length,
    resolved,
    unresolved: nodes.length - resolved,
    reviewCounts,
    concerns,
    confidence,
    filesTouched: fileRows.length,
    highImpact,
    mediumImpact,
    lowImpact,
  };
}

// Embedding raw JSON inside <script type="application/json"> is safe from
// execution, but a title containing a literal "</script>" would still close
// the tag early to the HTML parser -- escaping "<" as < (valid inside a
// JSON string) keeps JSON.parse working while making that impossible.
function embeddableJson(graph) {
  return JSON.stringify(graph).replace(/</g, "\\u003c");
}

export function renderHtml(graph) {
  const summary = computeSummary(graph);
  const tree = renderNodeTree(graph, graph.root_id);

  return `<!doctype html>
<!--
  Decision review for "${escapeHtml(graph.feature)}".

  Self-contained: no CDN, no framework, no build step, no external requests --
  same bar as web/index.html. Regenerated by create_reasoning_graph and
  update_reasoning_graph; hand-edit graph.json, not this file, since the next
  patch overwrites it.
-->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Decision Review — ${escapeHtml(graph.feature)}</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f3f3ef;
    --bg-2: #ecebe3;
    --panel: #fefdf9;
    --fg: #1a1f24;
    --muted: #5f666f;
    --line: #d4d2c8;
    --ink: #26313f;
    --accent: #006d77;
    --accent-2: #d95d39;
    --ok: #2a9d8f;
    --warn: #e9a03b;
    --bad: #d1495b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #121519;
      --bg-2: #1a1e24;
      --panel: #1b2027;
      --fg: #edf0f4;
      --muted: #a7b1bc;
      --line: #2f3844;
      --ink: #dbe4ef;
      --accent: #43b7b8;
      --accent-2: #ff8a5b;
      --ok: #63d3a8;
      --warn: #f3be63;
      --bad: #ff6f7d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background:
      radial-gradient(1200px 650px at 15% -10%, rgba(0, 109, 119, 0.14), transparent 55%),
      radial-gradient(850px 520px at 100% 0%, rgba(217, 93, 57, 0.12), transparent 60%),
      var(--bg);
    color: var(--fg);
    font: 14px/1.5 'IBM Plex Sans', 'Space Grotesk', ui-sans-serif, system-ui, sans-serif;
  }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 30;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--panel) 92%, transparent);
    backdrop-filter: blur(8px);
  }
  .title {
    display: flex;
    gap: 12px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  h1 {
    margin: 0;
    font: 700 18px/1.2 'Space Grotesk', 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif;
    letter-spacing: 0.01em;
  }
  .meta {
    color: var(--muted);
    font-size: 12px;
  }
  .pulse {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg-2) 72%, transparent);
    font-size: 12px;
    color: var(--ink);
  }
  .pulse::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 70%, transparent);
    animation: pulse 1.8s infinite;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent); }
    70% { box-shadow: 0 0 0 9px transparent; }
    100% { box-shadow: 0 0 0 0 transparent; }
  }
  .health {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 12px;
    background: var(--panel);
  }

  main {
    display: grid;
    grid-template-columns: 250px minmax(0, 1fr) 360px;
    gap: 0;
    min-height: calc(100vh - 68px);
  }
  @media (max-width: 1120px) {
    main { grid-template-columns: 220px minmax(0, 1fr); }
    aside#inspector { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); }
  }
  @media (max-width: 760px) {
    main { grid-template-columns: 1fr; }
    nav#review-nav { border-right: 0; border-bottom: 1px solid var(--line); }
  }

  nav#review-nav {
    border-right: 1px solid var(--line);
    background: color-mix(in srgb, var(--panel) 94%, transparent);
    padding: 14px;
  }
  .nav-title {
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 8px;
  }
  .nav-btn {
    width: 100%;
    text-align: left;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
    color: var(--fg);
    padding: 9px 10px;
    margin-bottom: 8px;
    cursor: pointer;
    font-weight: 600;
    transition: transform .15s ease, border-color .15s ease;
  }
  .nav-btn:hover { transform: translateX(2px); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .nav-btn.active {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 50%, transparent);
  }
  .nav-count {
    color: var(--muted);
    font-size: 11px;
    font-weight: 500;
    margin-left: 6px;
  }

  #workspace {
    overflow-y: auto;
    padding: 16px;
  }
  .panel {
    display: none;
    animation: fadein .2s ease;
  }
  .panel.active { display: block; }
  @keyframes fadein {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .section-head {
    margin: 0 0 10px;
    font: 700 16px/1.3 'Space Grotesk', 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif;
  }
  .muted { color: var(--muted); }
  .cards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin: 10px 0 14px;
  }
  @media (max-width: 820px) { .cards { grid-template-columns: 1fr; } }
  .card {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    padding: 10px;
  }
  .card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; }
  .card .v { font-size: 22px; font-weight: 700; margin-top: 4px; }

  .confidence {
    margin: 10px 0 14px;
  }
  .confidence-track {
    height: 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: color-mix(in srgb, var(--bg-2) 84%, transparent);
    overflow: hidden;
  }
  .confidence-fill {
    height: 100%;
    width: 0;
    background: linear-gradient(90deg, var(--accent), var(--ok));
    transition: width .35s ease;
  }

  .split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  @media (max-width: 900px) { .split { grid-template-columns: 1fr; } }

  .list {
    margin: 0;
    padding-left: 18px;
  }
  .list li { margin: 4px 0; }

  details.node { margin: 2px 0 2px 16px; }
  details.node > summary { list-style: none; cursor: pointer; }
  details.node > summary::-webkit-details-marker { display: none; }
  .node.leaf { margin: 2px 0 2px 16px; }
  .node-row { display: inline-flex; align-items: center; gap: 6px; padding: 4px 7px; border-radius: 7px; }
  .node-row:hover, .node-row.sel { background: color-mix(in srgb, var(--line) 72%, transparent); }
  .pill {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: .03em;
  }
  .pill.status-resolved { color: var(--accent); border-color: var(--accent); }
  .pill.review-verified { color: var(--ok); border-color: var(--ok); }
  .pill.review-assumed { color: var(--warn); border-color: var(--warn); }
  .pill.review-inferred { color: var(--accent); border-color: var(--accent); }
  .pill.review-conflict { color: var(--bad); border-color: var(--bad); }
  .pill.review-unknown { color: var(--muted); border-color: var(--line); }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.risk-low { background: var(--ok); }
  .dot.risk-medium { background: var(--warn); }
  .dot.risk-high { background: var(--bad); }

  .table {
    width: 100%;
    border-collapse: collapse;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
  }
  .table th, .table td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  .table th {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .05em;
    color: var(--muted);
    background: color-mix(in srgb, var(--bg-2) 80%, transparent);
  }
  .table tr:last-child td { border-bottom: 0; }

  .concern {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
    padding: 10px;
    margin-bottom: 10px;
  }
  .concern h3 {
    margin: 0 0 6px;
    font-size: 14px;
  }
  .concern-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
  .btn-lite {
    border: 1px solid var(--line);
    background: color-mix(in srgb, var(--panel) 70%, var(--bg-2));
    color: var(--ink);
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 12px;
  }

  aside#inspector {
    border-left: 1px solid var(--line);
    background: color-mix(in srgb, var(--panel) 94%, transparent);
    padding: 14px 16px;
    overflow-y: auto;
  }
  aside h2 { font-size: 15px; margin: 0 0 8px; }
  aside h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .05em;
    color: var(--muted);
    margin: 14px 0 6px;
  }
  .alt { border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; margin-bottom: 8px; }
  .alt.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent); }
  .alt ul { margin: 4px 0; padding-left: 18px; }
  .empty { color: var(--muted); }
  .why-box {
    margin-top: 12px;
    border: 1px dashed var(--line);
    border-radius: 10px;
    padding: 10px;
    background: color-mix(in srgb, var(--bg-2) 60%, transparent);
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="title">
    <h1>WayContext · Decision Review</h1>
    <span class="meta">${escapeHtml(graph.feature)} · updated ${escapeHtml(graph.updated_at)}</span>
    <span class="pulse">Global pull-to-refresh review mode</span>
  </div>
  <div class="health">
    <span class="badge">Confidence ${summary.confidence}%</span>
    <span class="badge">⚠ ${summary.concerns} concerns</span>
    <span class="badge">✓ ${summary.reviewCounts.verified} verified</span>
  </div>
</header>
<main>
  <nav id="review-nav">
    <div class="nav-title">Overview</div>
    <button class="nav-btn active" data-panel="overview">Overview<span class="nav-count">${summary.nodeCount} decisions</span></button>
    <button class="nav-btn" data-panel="graph">Decision Graph<span class="nav-count">interactive</span></button>
    <button class="nav-btn" data-panel="impact">Change Map<span class="nav-count">${summary.filesTouched} files</span></button>
    <div class="nav-title" style="margin-top: 12px;">Review</div>
    <button class="nav-btn" data-panel="risks">Risks &amp; Conflicts<span class="nav-count">${summary.concerns} concerns</span></button>
    <button class="nav-btn" data-panel="evidence">Evidence<span class="nav-count">${summary.reviewCounts.verified} verified</span></button>
    <button class="nav-btn" data-panel="approval">Decisions Required<span class="nav-count">${summary.unresolved} open</span></button>
  </nav>
  <section id="workspace">
    <section class="panel active" id="panel-overview">
      <h2 class="section-head">${escapeHtml(graph.feature)}</h2>
      <p class="muted">Review question: what changes are proposed, why they should work in the current codebase, and what still needs a human decision.</p>
      <div class="cards">
        <article class="card"><div class="k">Affected files</div><div class="v">${summary.filesTouched}</div></article>
        <article class="card"><div class="k">Resolved decisions</div><div class="v">${summary.resolved}/${summary.nodeCount}</div></article>
        <article class="card"><div class="k">Concerns</div><div class="v">${summary.concerns}</div></article>
      </div>
      <div class="confidence">
        <div class="muted">Confidence</div>
        <div class="confidence-track"><div class="confidence-fill" style="width:${summary.confidence}%"></div></div>
      </div>
      <div class="split">
        <article class="card">
          <div class="k">Current → Proposed Architecture</div>
          <ul class="list">
            <li>Current: feature root with ${summary.nodeCount} decision nodes mapped to existing files.</li>
            <li>Proposed: decisions flow through reviewed nodes with explicit evidence and risk annotations.</li>
            <li>Status model: verified, assumed, inferred, conflict, unknown.</li>
          </ul>
        </article>
        <article class="card">
          <div class="k">Before You Approve</div>
          <ul class="list">
            <li>✓ ${summary.reviewCounts.verified} nodes have verified evidence.</li>
            <li>⚠ ${summary.reviewCounts.assumed + summary.reviewCounts.unknown} nodes are still assumption-heavy.</li>
            <li>⚠ ${summary.reviewCounts.conflict} nodes are in direct conflict with available evidence.</li>
          </ul>
        </article>
      </div>
    </section>

    <section class="panel" id="panel-graph">
      <h2 class="section-head">Decision Graph</h2>
      <p class="muted">Click any node to inspect why it exists, evidence, alternatives, and expected impact.</p>
      <div id="tree">${tree}</div>
    </section>

    <section class="panel" id="panel-impact"></section>
    <section class="panel" id="panel-risks"></section>
    <section class="panel" id="panel-evidence"></section>
    <section class="panel" id="panel-approval"></section>
  </section>
  <aside id="inspector"></aside>
</main>
<script type="application/json" id="graph-data">${embeddableJson(graph)}</script>
<script>
(function () {
  var graph = JSON.parse(document.getElementById('graph-data').textContent);
  var inspector = document.getElementById('inspector');
  var navButtons = Array.from(document.querySelectorAll('.nav-btn'));
  var panels = {
    overview: document.getElementById('panel-overview'),
    graph: document.getElementById('panel-graph'),
    impact: document.getElementById('panel-impact'),
    risks: document.getElementById('panel-risks'),
    evidence: document.getElementById('panel-evidence'),
    approval: document.getElementById('panel-approval')
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function allNodes() {
    return Object.values(graph.nodes).filter(function (node) { return node.id !== graph.root_id; });
  }

  function fileImpactRows() {
    var byFile = new Map();
    allNodes().forEach(function (node) {
      (node.affected_files || []).forEach(function (file) {
        if (!byFile.has(file)) {
          byFile.set(file, { file: file, count: 0, risk: 'low', titles: [] });
        }
        var row = byFile.get(file);
        row.count += 1;
        row.titles.push(node.title);
        if (node.risk === 'high') row.risk = 'high';
        else if (node.risk === 'medium' && row.risk !== 'high') row.risk = 'medium';
      });
    });
    return Array.from(byFile.values()).sort(function (a, b) {
      var rank = { high: 3, medium: 2, low: 1 };
      if (rank[b.risk] !== rank[a.risk]) return rank[b.risk] - rank[a.risk];
      if (b.count !== a.count) return b.count - a.count;
      return a.file.localeCompare(b.file);
    });
  }

  function statusPill(kind, value) {
    return '<span class="pill ' + kind + '-' + esc(value) + '">' + esc(value) + '</span>';
  }

  function nodeConcernReason(node) {
    if (node.review === 'conflict') return 'Plan or assumption conflicts with codebase evidence.';
    if (node.risk === 'high') return 'High-risk change across dependent files.';
    if (node.status !== 'resolved' && node.risk === 'medium') return 'Medium-risk decision remains unresolved.';
    if (node.review === 'assumed' || node.review === 'unknown') return 'Evidence is partial; human confirmation recommended.';
    return null;
  }

  function renderImpact() {
    var rows = fileImpactRows();
    var body = rows.length
      ? rows.map(function (row) {
          var impact = row.risk === 'high' ? 'HIGH' : (row.risk === 'medium' ? 'MEDIUM' : 'LOW');
          return '<tr>' +
            '<td>' + esc(row.file) + '</td>' +
            '<td>' + impact + '</td>' +
            '<td>' + row.count + '</td>' +
            '<td>' + esc(row.titles.slice(0, 3).join(' · ')) + (row.titles.length > 3 ? ' +' + (row.titles.length - 3) + ' more' : '') + '</td>' +
          '</tr>';
        }).join('')
      : '<tr><td colspan="4" class="muted">No impacted files recorded yet. Use set_affected_files on decision nodes.</td></tr>';
    panels.impact.innerHTML =
      '<h2 class="section-head">Codebase Impact Map</h2>' +
      '<p class="muted">Impact is computed from decision-node affected files and risk annotations.</p>' +
      '<table class="table"><thead><tr><th>File</th><th>Impact</th><th>Touches</th><th>Why</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function renderRisks() {
    var concerns = allNodes()
      .map(function (node) {
        return { node: node, reason: nodeConcernReason(node) };
      })
      .filter(function (item) { return Boolean(item.reason); });

    panels.risks.innerHTML =
      '<h2 class="section-head">Risks &amp; Conflicts</h2>' +
      '<p class="muted">WayContext concern panel: this is where the review pushes back on weak assumptions.</p>' +
      (concerns.length
        ? concerns.map(function (item, idx) {
            var n = item.node;
            return '<article class="concern">' +
              '<h3>' + String(idx + 1).padStart(2, '0') + ' · ' + esc(n.title) + '</h3>' +
              '<div>' + statusPill('review', n.review || 'unknown') + ' ' + (n.risk ? '<span class="dot risk-' + esc(n.risk) + '"></span> ' + esc(n.risk) : '') + '</div>' +
              '<p>' + esc(item.reason) + '</p>' +
              (n.notes ? '<p class="muted">' + esc(n.notes) + '</p>' : '') +
              '<div class="concern-actions"><span class="btn-lite">Accept</span><span class="btn-lite">Reject</span><span class="btn-lite">Discuss</span></div>' +
            '</article>';
          }).join('')
        : '<div class="card"><strong>No active concerns.</strong><div class="muted">Every node is either verified/inferred with low risk or already resolved.</div></div>');
  }

  function renderEvidence() {
    var nodes = allNodes();
    var blocks = nodes.map(function (node) {
      var evidence = node.evidence || [];
      var evidenceList = evidence.length
        ? '<ul class="list">' + evidence.map(function (ev) { return '<li>' + esc(ev) + '</li>'; }).join('') + '</ul>'
        : '<div class="empty">No explicit evidence captured.</div>';
      return '<article class="card">' +
        '<div><strong>' + esc(node.title) + '</strong></div>' +
        '<div style="margin-top:6px;">' + statusPill('review', node.review || 'unknown') + (node.confidence != null ? ' <span class="muted">confidence ' + node.confidence + '%</span>' : '') + '</div>' +
        '<div style="margin-top:8px;">' + evidenceList + '</div>' +
      '</article>';
    });

    panels.evidence.innerHTML =
      '<h2 class="section-head">Evidence Traceability</h2>' +
      '<p class="muted">Each decision claim should map to concrete evidence. Missing evidence appears as unknown/assumed.</p>' +
      blocks.join('');
  }

  function renderApproval() {
    var decisions = allNodes().filter(function (node) {
      return node.type !== 'feature' && (node.status !== 'resolved' || !node.selected);
    });

    var decisionHtml = decisions.length
      ? decisions.map(function (node, idx) {
          var alternatives = (node.alternatives || []).length
            ? '<ul class="list">' + node.alternatives.map(function (alt) {
                var picked = alt.id === node.selected ? ' (selected)' : '';
                return '<li>' + esc(alt.label + picked) + '</li>';
              }).join('') + '</ul>'
            : '<div class="empty">No alternatives recorded yet.</div>';
          return '<article class="card">' +
            '<div><strong>' + String(idx + 1) + '. ' + esc(node.title) + '</strong></div>' +
            '<div style="margin-top:6px;">' + statusPill('status', node.status) + ' ' + statusPill('review', node.review || 'unknown') + '</div>' +
            '<div style="margin-top:8px;">' + alternatives + '</div>' +
          '</article>';
        }).join('')
      : '<div class="card"><strong>All decision nodes are resolved.</strong><div class="muted">No pending approval choices detected from graph.json.</div></div>';

    panels.approval.innerHTML =
      '<h2 class="section-head">Decisions Required</h2>' +
      '<p class="muted">Approve unresolved choices before implementation starts.</p>' +
      decisionHtml;
  }

  function renderInspector(node) {
    var html = '<h2>' + esc(node.title) + '</h2>';
    html += '<div>' +
      '<span class="pill status-' + node.status + '">' + node.status + '</span> ' +
      '<span class="pill review-' + (node.review || 'unknown') + '">' + (node.review || 'unknown') + '</span>' +
      (node.risk ? ' <span class="dot risk-' + node.risk + '"></span> ' + node.risk : '') +
      (typeof node.confidence === 'number' ? ' <span class="muted">confidence ' + node.confidence + '%</span>' : '') +
      '</div>';
    if (node.alternatives && node.alternatives.length) {
      html += '<h3>Alternatives</h3>';
      node.alternatives.forEach(function (alt) {
        html += '<div class="alt' + (alt.id === node.selected ? ' selected' : '') + '">';
        html += '<strong>' + esc(alt.label) + '</strong>';
        if (alt.pros && alt.pros.length) html += '<ul>' + alt.pros.map(function (p) { return '<li>+ ' + esc(p) + '</li>'; }).join('') + '</ul>';
        if (alt.cons && alt.cons.length) html += '<ul>' + alt.cons.map(function (c) { return '<li>- ' + esc(c) + '</li>'; }).join('') + '</ul>';
        html += '</div>';
      });
    }
    html += '<h3>Affected files</h3>';
    html += (node.affected_files && node.affected_files.length)
      ? '<ul class="list">' + node.affected_files.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>'
      : '<div class="empty">None recorded</div>';

    html += '<h3>Evidence</h3>';
    html += (node.evidence && node.evidence.length)
      ? '<ul class="list">' + node.evidence.map(function (entry) { return '<li>' + esc(entry) + '</li>'; }).join('') + '</ul>'
      : '<div class="empty">No explicit evidence</div>';

    if (node.notes) html += '<h3>Notes</h3><div>' + esc(node.notes) + '</div>';

    var why = node.notes || (node.evidence && node.evidence[0]) || 'No rationale written yet.';
    html += '<div class="why-box"><strong>Why?</strong><div class="muted" style="margin-top:6px;">' + esc(why) + '</div></div>';

    inspector.innerHTML = html;
  }

  function switchPanel(name) {
    navButtons.forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-panel') === name);
    });
    Object.keys(panels).forEach(function (key) {
      panels[key].classList.toggle('active', key === name);
    });
  }

  document.querySelectorAll('.node-row').forEach(function (row) {
    row.addEventListener('click', function () {
      document.querySelectorAll('.node-row.sel').forEach(function (r) { r.classList.remove('sel'); });
      row.classList.add('sel');
      renderInspector(graph.nodes[row.getAttribute('data-id')]);
      switchPanel('graph');
      var graphButton = document.querySelector('.nav-btn[data-panel="graph"]');
      if (graphButton) graphButton.classList.add('active');
    });
  });

  navButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      switchPanel(button.getAttribute('data-panel'));
    });
  });

  renderImpact();
  renderRisks();
  renderEvidence();
  renderApproval();

  renderInspector(graph.nodes[graph.root_id]);
})();
</script>
</body>
</html>
`;
}
