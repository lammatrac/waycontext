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
  .lang-switch {
    display: inline-flex;
    gap: 2px;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px;
    background: var(--panel);
  }
  .lang-btn {
    border: none;
    background: transparent;
    color: var(--muted);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .lang-btn.active { background: var(--accent); color: #fff; }

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
    <h1 data-i18n="app.title">WayContext · Decision Review</h1>
    <span class="meta">${escapeHtml(graph.feature)} · <span data-i18n="app.updatedLabel">updated</span> ${escapeHtml(graph.updated_at)}</span>
    <span class="pulse" data-i18n="app.pulse">Global pull-to-refresh review mode</span>
  </div>
  <div class="health">
    <span class="badge" data-i18n-tpl="badge.confidence" data-i18n-vars='{"n":${summary.confidence}}'>Confidence ${summary.confidence}%</span>
    <span class="badge" data-i18n-tpl="badge.concerns" data-i18n-vars='{"n":${summary.concerns}}'>⚠ ${summary.concerns} concerns</span>
    <span class="badge" data-i18n-tpl="badge.verified" data-i18n-vars='{"n":${summary.reviewCounts.verified}}'>✓ ${summary.reviewCounts.verified} verified</span>
    <span class="lang-switch">
      <button type="button" class="lang-btn active" data-lang="en">EN</button>
      <button type="button" class="lang-btn" data-lang="vi">VI</button>
    </span>
  </div>
</header>
<main>
  <nav id="review-nav">
    <div class="nav-title" data-i18n="nav.sectionOverview">Overview</div>
    <button class="nav-btn active" data-panel="overview"><span data-i18n="nav.overview">Overview</span><span class="nav-count" data-i18n-tpl="nav.count.decisions" data-i18n-vars='{"n":${summary.nodeCount}}'>${summary.nodeCount} decisions</span></button>
    <button class="nav-btn" data-panel="graph"><span data-i18n="nav.graph">Decision Graph</span><span class="nav-count" data-i18n="nav.count.interactive">interactive</span></button>
    <button class="nav-btn" data-panel="impact"><span data-i18n="nav.impact">Change Map</span><span class="nav-count" data-i18n-tpl="nav.count.files" data-i18n-vars='{"n":${summary.filesTouched}}'>${summary.filesTouched} files</span></button>
    <div class="nav-title" style="margin-top: 12px;" data-i18n="nav.sectionReview">Review</div>
    <button class="nav-btn" data-panel="risks"><span data-i18n="nav.risks">Risks &amp; Conflicts</span><span class="nav-count" data-i18n-tpl="nav.count.concerns" data-i18n-vars='{"n":${summary.concerns}}'>${summary.concerns} concerns</span></button>
    <button class="nav-btn" data-panel="evidence"><span data-i18n="nav.evidence">Evidence</span><span class="nav-count" data-i18n-tpl="nav.count.verified" data-i18n-vars='{"n":${summary.reviewCounts.verified}}'>${summary.reviewCounts.verified} verified</span></button>
    <button class="nav-btn" data-panel="approval"><span data-i18n="nav.approval">Decisions Required</span><span class="nav-count" data-i18n-tpl="nav.count.open" data-i18n-vars='{"n":${summary.unresolved}}'>${summary.unresolved} open</span></button>
  </nav>
  <section id="workspace">
    <section class="panel active" id="panel-overview">
      <h2 class="section-head">${escapeHtml(graph.feature)}</h2>
      <p class="muted" data-i18n="overview.reviewQuestion">Review question: what changes are proposed, why they should work in the current codebase, and what still needs a human decision.</p>
      <div class="cards">
        <article class="card"><div class="k" data-i18n="overview.card.affectedFiles">Affected files</div><div class="v">${summary.filesTouched}</div></article>
        <article class="card"><div class="k" data-i18n="overview.card.resolvedDecisions">Resolved decisions</div><div class="v">${summary.resolved}/${summary.nodeCount}</div></article>
        <article class="card"><div class="k" data-i18n="overview.card.concerns">Concerns</div><div class="v">${summary.concerns}</div></article>
      </div>
      <div class="confidence">
        <div class="muted" data-i18n="overview.confidenceLabel">Confidence</div>
        <div class="confidence-track"><div class="confidence-fill" style="width:${summary.confidence}%"></div></div>
      </div>
      <div class="split">
        <article class="card">
          <div class="k" data-i18n="overview.archCard">Current → Proposed Architecture</div>
          <ul class="list">
            <li data-i18n-tpl="overview.current" data-i18n-vars='{"n":${summary.nodeCount}}'>Current: feature root with ${summary.nodeCount} decision nodes mapped to existing files.</li>
            <li data-i18n="overview.proposed">Proposed: decisions flow through reviewed nodes with explicit evidence and risk annotations.</li>
            <li data-i18n="overview.statusModel">Status model: verified, assumed, inferred, conflict, unknown.</li>
          </ul>
        </article>
        <article class="card">
          <div class="k" data-i18n="overview.approveCard">Before You Approve</div>
          <ul class="list">
            <li data-i18n-tpl="overview.verifiedCount" data-i18n-vars='{"n":${summary.reviewCounts.verified}}'>✓ ${summary.reviewCounts.verified} nodes have verified evidence.</li>
            <li data-i18n-tpl="overview.assumptionHeavy" data-i18n-vars='{"n":${summary.reviewCounts.assumed + summary.reviewCounts.unknown}}'>⚠ ${summary.reviewCounts.assumed + summary.reviewCounts.unknown} nodes are still assumption-heavy.</li>
            <li data-i18n-tpl="overview.conflictCount" data-i18n-vars='{"n":${summary.reviewCounts.conflict}}'>⚠ ${summary.reviewCounts.conflict} nodes are in direct conflict with available evidence.</li>
          </ul>
        </article>
      </div>
    </section>

    <section class="panel" id="panel-graph">
      <h2 class="section-head" data-i18n="panel.graph.head">Decision Graph</h2>
      <p class="muted" data-i18n="panel.graph.desc">Click any node to inspect why it exists, evidence, alternatives, and expected impact.</p>
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

  var I18N = {
    en: {
      'app.title': 'WayContext · Decision Review',
      'app.updatedLabel': 'updated',
      'app.pulse': 'Global pull-to-refresh review mode',
      'badge.confidence': 'Confidence {n}%',
      'badge.concerns': '⚠ {n} concerns',
      'badge.verified': '✓ {n} verified',
      'nav.sectionOverview': 'Overview',
      'nav.overview': 'Overview',
      'nav.graph': 'Decision Graph',
      'nav.impact': 'Change Map',
      'nav.sectionReview': 'Review',
      'nav.risks': 'Risks & Conflicts',
      'nav.evidence': 'Evidence',
      'nav.approval': 'Decisions Required',
      'nav.count.decisions': '{n} decisions',
      'nav.count.interactive': 'interactive',
      'nav.count.files': '{n} files',
      'nav.count.concerns': '{n} concerns',
      'nav.count.verified': '{n} verified',
      'nav.count.open': '{n} open',
      'overview.reviewQuestion': 'Review question: what changes are proposed, why they should work in the current codebase, and what still needs a human decision.',
      'overview.card.affectedFiles': 'Affected files',
      'overview.card.resolvedDecisions': 'Resolved decisions',
      'overview.card.concerns': 'Concerns',
      'overview.confidenceLabel': 'Confidence',
      'overview.archCard': 'Current → Proposed Architecture',
      'overview.approveCard': 'Before You Approve',
      'overview.current': 'Current: feature root with {n} decision nodes mapped to existing files.',
      'overview.proposed': 'Proposed: decisions flow through reviewed nodes with explicit evidence and risk annotations.',
      'overview.statusModel': 'Status model: verified, assumed, inferred, conflict, unknown.',
      'overview.verifiedCount': '✓ {n} nodes have verified evidence.',
      'overview.assumptionHeavy': '⚠ {n} nodes are still assumption-heavy.',
      'overview.conflictCount': '⚠ {n} nodes are in direct conflict with available evidence.',
      'panel.graph.head': 'Decision Graph',
      'panel.graph.desc': 'Click any node to inspect why it exists, evidence, alternatives, and expected impact.',
      'panel.impact.head': 'Codebase Impact Map',
      'panel.impact.desc': 'Impact is computed from decision-node affected files and risk annotations.',
      'impact.col.file': 'File',
      'impact.col.impact': 'Impact',
      'impact.col.touches': 'Touches',
      'impact.col.why': 'Why',
      'impact.level.high': 'HIGH',
      'impact.level.medium': 'MEDIUM',
      'impact.level.low': 'LOW',
      'impact.empty': 'No impacted files recorded yet. Use set_affected_files on decision nodes.',
      'impact.more': '+{n} more',
      'panel.risks.head': 'Risks & Conflicts',
      'panel.risks.desc': 'WayContext concern panel: this is where the review pushes back on weak assumptions.',
      'concern.reason.conflict': 'Plan or assumption conflicts with codebase evidence.',
      'concern.reason.highRisk': 'High-risk change across dependent files.',
      'concern.reason.mediumRisk': 'Medium-risk decision remains unresolved.',
      'concern.reason.partial': 'Evidence is partial; human confirmation recommended.',
      'concern.none.title': 'No active concerns.',
      'concern.none.desc': 'Every node is either verified/inferred with low risk or already resolved.',
      'concern.action.accept': 'Accept',
      'concern.action.reject': 'Reject',
      'concern.action.discuss': 'Discuss',
      'panel.evidence.head': 'Evidence Traceability',
      'panel.evidence.desc': 'Each decision claim should map to concrete evidence. Missing evidence appears as unknown/assumed.',
      'evidence.empty': 'No explicit evidence captured.',
      'common.confidencePct': 'confidence {n}%',
      'panel.approval.head': 'Decisions Required',
      'panel.approval.desc': 'Approve unresolved choices before implementation starts.',
      'alternatives.empty': 'No alternatives recorded yet.',
      'approval.allResolved.title': 'All decision nodes are resolved.',
      'approval.allResolved.desc': 'No pending approval choices detected from graph.json.',
      'inspector.alternatives': 'Alternatives',
      'inspector.affectedFiles': 'Affected files',
      'inspector.evidence': 'Evidence',
      'inspector.notes': 'Notes',
      'inspector.why': 'Why?',
      'inspector.noneRecorded': 'None recorded',
      'inspector.noEvidence': 'No explicit evidence',
      'inspector.noRationale': 'No rationale written yet.',
      'label.selected': ' (selected)',
      'code.open': 'open',
      'code.resolved': 'resolved',
      'code.verified': 'verified',
      'code.assumed': 'assumed',
      'code.inferred': 'inferred',
      'code.conflict': 'conflict',
      'code.unknown': 'unknown',
      'code.low': 'low',
      'code.medium': 'medium',
      'code.high': 'high'
    },
    vi: {
      'app.title': 'WayContext · Đánh giá quyết định',
      'app.updatedLabel': 'cập nhật lúc',
      'app.pulse': 'Chế độ đánh giá tự làm mới toàn cục',
      'badge.confidence': 'Độ tin cậy {n}%',
      'badge.concerns': '⚠ {n} vấn đề cần lưu ý',
      'badge.verified': '✓ {n} đã xác minh',
      'nav.sectionOverview': 'Tổng quan',
      'nav.overview': 'Tổng quan',
      'nav.graph': 'Sơ đồ quyết định',
      'nav.impact': 'Bản đồ thay đổi',
      'nav.sectionReview': 'Đánh giá',
      'nav.risks': 'Rủi ro & Xung đột',
      'nav.evidence': 'Bằng chứng',
      'nav.approval': 'Quyết định cần duyệt',
      'nav.count.decisions': '{n} quyết định',
      'nav.count.interactive': 'tương tác',
      'nav.count.files': '{n} tệp',
      'nav.count.concerns': '{n} vấn đề',
      'nav.count.verified': '{n} đã xác minh',
      'nav.count.open': '{n} chưa xử lý',
      'overview.reviewQuestion': 'Câu hỏi đánh giá: những thay đổi nào được đề xuất, vì sao chúng phù hợp với codebase hiện tại, và điều gì vẫn cần con người quyết định.',
      'overview.card.affectedFiles': 'Tệp bị ảnh hưởng',
      'overview.card.resolvedDecisions': 'Quyết định đã giải quyết',
      'overview.card.concerns': 'Vấn đề cần lưu ý',
      'overview.confidenceLabel': 'Độ tin cậy',
      'overview.archCard': 'Kiến trúc hiện tại → đề xuất',
      'overview.approveCard': 'Trước khi phê duyệt',
      'overview.current': 'Hiện tại: gốc tính năng có {n} nút quyết định được ánh xạ tới các tệp hiện có.',
      'overview.proposed': 'Đề xuất: các quyết định đi qua những nút đã được đánh giá kèm bằng chứng và mức rủi ro rõ ràng.',
      'overview.statusModel': 'Mô hình trạng thái: đã xác minh, giả định, suy luận, xung đột, chưa rõ.',
      'overview.verifiedCount': '✓ {n} nút có bằng chứng đã xác minh.',
      'overview.assumptionHeavy': '⚠ {n} nút vẫn chủ yếu dựa trên giả định.',
      'overview.conflictCount': '⚠ {n} nút đang xung đột trực tiếp với bằng chứng hiện có.',
      'panel.graph.head': 'Sơ đồ quyết định',
      'panel.graph.desc': 'Nhấp vào một nút bất kỳ để xem lý do tồn tại, bằng chứng, phương án thay thế và tác động dự kiến.',
      'panel.impact.head': 'Bản đồ tác động lên codebase',
      'panel.impact.desc': 'Tác động được tính từ các tệp bị ảnh hưởng và mức rủi ro gắn với từng nút quyết định.',
      'impact.col.file': 'Tệp',
      'impact.col.impact': 'Tác động',
      'impact.col.touches': 'Số lần chạm',
      'impact.col.why': 'Lý do',
      'impact.level.high': 'CAO',
      'impact.level.medium': 'TRUNG BÌNH',
      'impact.level.low': 'THẤP',
      'impact.empty': 'Chưa ghi nhận tệp bị ảnh hưởng nào. Dùng set_affected_files trên các nút quyết định.',
      'impact.more': '+{n} nữa',
      'panel.risks.head': 'Rủi ro & Xung đột',
      'panel.risks.desc': 'Bảng vấn đề của WayContext: đây là nơi việc đánh giá phản biện các giả định còn yếu.',
      'concern.reason.conflict': 'Kế hoạch hoặc giả định xung đột với bằng chứng trong codebase.',
      'concern.reason.highRisk': 'Thay đổi rủi ro cao trên các tệp phụ thuộc.',
      'concern.reason.mediumRisk': 'Quyết định rủi ro trung bình vẫn chưa được giải quyết.',
      'concern.reason.partial': 'Bằng chứng chưa đầy đủ; nên có xác nhận từ con người.',
      'concern.none.title': 'Không có vấn đề nào đang mở.',
      'concern.none.desc': 'Mọi nút đều đã xác minh/suy luận với rủi ro thấp hoặc đã được giải quyết.',
      'concern.action.accept': 'Chấp nhận',
      'concern.action.reject': 'Từ chối',
      'concern.action.discuss': 'Thảo luận',
      'panel.evidence.head': 'Truy vết bằng chứng',
      'panel.evidence.desc': 'Mỗi quyết định nên gắn với bằng chứng cụ thể. Thiếu bằng chứng sẽ hiện thành chưa rõ/giả định.',
      'evidence.empty': 'Chưa ghi nhận bằng chứng cụ thể.',
      'common.confidencePct': 'độ tin cậy {n}%',
      'panel.approval.head': 'Quyết định cần duyệt',
      'panel.approval.desc': 'Phê duyệt các lựa chọn còn mở trước khi bắt đầu triển khai.',
      'alternatives.empty': 'Chưa ghi nhận phương án thay thế nào.',
      'approval.allResolved.title': 'Tất cả các nút quyết định đã được giải quyết.',
      'approval.allResolved.desc': 'Không phát hiện lựa chọn nào đang chờ duyệt trong graph.json.',
      'inspector.alternatives': 'Phương án thay thế',
      'inspector.affectedFiles': 'Tệp bị ảnh hưởng',
      'inspector.evidence': 'Bằng chứng',
      'inspector.notes': 'Ghi chú',
      'inspector.why': 'Vì sao?',
      'inspector.noneRecorded': 'Không có bản ghi',
      'inspector.noEvidence': 'Không có bằng chứng cụ thể',
      'inspector.noRationale': 'Chưa có lý do được ghi lại.',
      'label.selected': ' (đã chọn)',
      'code.open': 'chưa xử lý',
      'code.resolved': 'đã giải quyết',
      'code.verified': 'đã xác minh',
      'code.assumed': 'giả định',
      'code.inferred': 'suy luận',
      'code.conflict': 'xung đột',
      'code.unknown': 'chưa rõ',
      'code.low': 'thấp',
      'code.medium': 'trung bình',
      'code.high': 'cao'
    }
  };
  var lang = localStorage.getItem('waycontext-review-lang') || 'en';

  function t(key) {
    return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
  }

  function tv(key, vars) {
    return t(key).replace(/\{(\w+)\}/g, function (_, name) {
      return vars && Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : '{' + name + '}';
    });
  }
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
    return '<span class="pill ' + kind + '-' + esc(value) + '">' + esc(t('code.' + value)) + '</span>';
  }

  function nodeConcernReason(node) {
    if (node.review === 'conflict') return t('concern.reason.conflict');
    if (node.risk === 'high') return t('concern.reason.highRisk');
    if (node.status !== 'resolved' && node.risk === 'medium') return t('concern.reason.mediumRisk');
    if (node.review === 'assumed' || node.review === 'unknown') return t('concern.reason.partial');
    return null;
  }

  function renderImpact() {
    var rows = fileImpactRows();
    var body = rows.length
      ? rows.map(function (row) {
          var impact = row.risk === 'high' ? t('impact.level.high') : (row.risk === 'medium' ? t('impact.level.medium') : t('impact.level.low'));
          return '<tr>' +
            '<td>' + esc(row.file) + '</td>' +
            '<td>' + impact + '</td>' +
            '<td>' + row.count + '</td>' +
            '<td>' + esc(row.titles.slice(0, 3).join(' · ')) + (row.titles.length > 3 ? ' ' + esc(tv('impact.more', { n: row.titles.length - 3 })) : '') + '</td>' +
          '</tr>';
        }).join('')
      : '<tr><td colspan="4" class="muted">' + esc(t('impact.empty')) + '</td></tr>';
    panels.impact.innerHTML =
      '<h2 class="section-head">' + esc(t('panel.impact.head')) + '</h2>' +
      '<p class="muted">' + esc(t('panel.impact.desc')) + '</p>' +
      '<table class="table"><thead><tr><th>' + esc(t('impact.col.file')) + '</th><th>' + esc(t('impact.col.impact')) + '</th><th>' + esc(t('impact.col.touches')) + '</th><th>' + esc(t('impact.col.why')) + '</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function renderRisks() {
    var concerns = allNodes()
      .map(function (node) {
        return { node: node, reason: nodeConcernReason(node) };
      })
      .filter(function (item) { return Boolean(item.reason); });

    panels.risks.innerHTML =
      '<h2 class="section-head">' + esc(t('panel.risks.head')) + '</h2>' +
      '<p class="muted">' + esc(t('panel.risks.desc')) + '</p>' +
      (concerns.length
        ? concerns.map(function (item, idx) {
            var n = item.node;
            return '<article class="concern">' +
              '<h3>' + String(idx + 1).padStart(2, '0') + ' · ' + esc(n.title) + '</h3>' +
              '<div>' + statusPill('review', n.review || 'unknown') + ' ' + (n.risk ? '<span class="dot risk-' + esc(n.risk) + '"></span> ' + esc(t('code.' + n.risk)) : '') + '</div>' +
              '<p>' + esc(item.reason) + '</p>' +
              (n.notes ? '<p class="muted">' + esc(n.notes) + '</p>' : '') +
              '<div class="concern-actions"><span class="btn-lite">' + esc(t('concern.action.accept')) + '</span><span class="btn-lite">' + esc(t('concern.action.reject')) + '</span><span class="btn-lite">' + esc(t('concern.action.discuss')) + '</span></div>' +
            '</article>';
          }).join('')
        : '<div class="card"><strong>' + esc(t('concern.none.title')) + '</strong><div class="muted">' + esc(t('concern.none.desc')) + '</div></div>');
  }

  function renderEvidence() {
    var nodes = allNodes();
    var blocks = nodes.map(function (node) {
      var evidence = node.evidence || [];
      var evidenceList = evidence.length
        ? '<ul class="list">' + evidence.map(function (ev) { return '<li>' + esc(ev) + '</li>'; }).join('') + '</ul>'
        : '<div class="empty">' + esc(t('evidence.empty')) + '</div>';
      return '<article class="card">' +
        '<div><strong>' + esc(node.title) + '</strong></div>' +
        '<div style="margin-top:6px;">' + statusPill('review', node.review || 'unknown') + (node.confidence != null ? ' <span class="muted">' + esc(tv('common.confidencePct', { n: node.confidence })) + '</span>' : '') + '</div>' +
        '<div style="margin-top:8px;">' + evidenceList + '</div>' +
      '</article>';
    });

    panels.evidence.innerHTML =
      '<h2 class="section-head">' + esc(t('panel.evidence.head')) + '</h2>' +
      '<p class="muted">' + esc(t('panel.evidence.desc')) + '</p>' +
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
                var picked = alt.id === node.selected ? esc(t('label.selected')) : '';
                return '<li>' + esc(alt.label) + picked + '</li>';
              }).join('') + '</ul>'
            : '<div class="empty">' + esc(t('alternatives.empty')) + '</div>';
          return '<article class="card">' +
            '<div><strong>' + String(idx + 1) + '. ' + esc(node.title) + '</strong></div>' +
            '<div style="margin-top:6px;">' + statusPill('status', node.status) + ' ' + statusPill('review', node.review || 'unknown') + '</div>' +
            '<div style="margin-top:8px;">' + alternatives + '</div>' +
          '</article>';
        }).join('')
      : '<div class="card"><strong>' + esc(t('approval.allResolved.title')) + '</strong><div class="muted">' + esc(t('approval.allResolved.desc')) + '</div></div>';

    panels.approval.innerHTML =
      '<h2 class="section-head">' + esc(t('panel.approval.head')) + '</h2>' +
      '<p class="muted">' + esc(t('panel.approval.desc')) + '</p>' +
      decisionHtml;
  }

  function renderInspector(node) {
    var html = '<h2>' + esc(node.title) + '</h2>';
    html += '<div>' +
      '<span class="pill status-' + node.status + '">' + esc(t('code.' + node.status)) + '</span> ' +
      '<span class="pill review-' + (node.review || 'unknown') + '">' + esc(t('code.' + (node.review || 'unknown'))) + '</span>' +
      (node.risk ? ' <span class="dot risk-' + node.risk + '"></span> ' + esc(t('code.' + node.risk)) : '') +
      (typeof node.confidence === 'number' ? ' <span class="muted">' + esc(tv('common.confidencePct', { n: node.confidence })) + '</span>' : '') +
      '</div>';
    if (node.alternatives && node.alternatives.length) {
      html += '<h3>' + esc(t('inspector.alternatives')) + '</h3>';
      node.alternatives.forEach(function (alt) {
        html += '<div class="alt' + (alt.id === node.selected ? ' selected' : '') + '">';
        html += '<strong>' + esc(alt.label) + '</strong>';
        if (alt.pros && alt.pros.length) html += '<ul>' + alt.pros.map(function (p) { return '<li>+ ' + esc(p) + '</li>'; }).join('') + '</ul>';
        if (alt.cons && alt.cons.length) html += '<ul>' + alt.cons.map(function (c) { return '<li>- ' + esc(c) + '</li>'; }).join('') + '</ul>';
        html += '</div>';
      });
    }
    html += '<h3>' + esc(t('inspector.affectedFiles')) + '</h3>';
    html += (node.affected_files && node.affected_files.length)
      ? '<ul class="list">' + node.affected_files.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>'
      : '<div class="empty">' + esc(t('inspector.noneRecorded')) + '</div>';

    html += '<h3>' + esc(t('inspector.evidence')) + '</h3>';
    html += (node.evidence && node.evidence.length)
      ? '<ul class="list">' + node.evidence.map(function (entry) { return '<li>' + esc(entry) + '</li>'; }).join('') + '</ul>'
      : '<div class="empty">' + esc(t('inspector.noEvidence')) + '</div>';

    if (node.notes) html += '<h3>' + esc(t('inspector.notes')) + '</h3><div>' + esc(node.notes) + '</div>';

    var why = node.notes || (node.evidence && node.evidence[0]) || t('inspector.noRationale');
    html += '<div class="why-box"><strong>' + esc(t('inspector.why')) + '</strong><div class="muted" style="margin-top:6px;">' + esc(why) + '</div></div>';

    inspector.innerHTML = html;
  }

  function applyStaticTranslations() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-tpl]').forEach(function (el) {
      var vars = {};
      try { vars = JSON.parse(el.getAttribute('data-i18n-vars') || '{}'); } catch (e) { /* leave vars empty */ }
      el.textContent = tv(el.getAttribute('data-i18n-tpl'), vars);
    });
    document.querySelectorAll('.lang-btn').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-lang') === lang);
    });
  }

  function applyLang(next) {
    lang = next;
    localStorage.setItem('waycontext-review-lang', next);
    applyStaticTranslations();
    renderImpact();
    renderRisks();
    renderEvidence();
    renderApproval();
    var selectedRow = document.querySelector('.node-row.sel');
    renderInspector(selectedRow ? graph.nodes[selectedRow.getAttribute('data-id')] : graph.nodes[graph.root_id]);
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

  document.querySelectorAll('.lang-btn').forEach(function (button) {
    button.addEventListener('click', function () {
      applyLang(button.getAttribute('data-lang'));
    });
  });

  applyLang(lang);
})();
</script>
</body>
</html>
`;
}
