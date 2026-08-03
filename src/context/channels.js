/**
 * The candidate channels the context composer fuses.
 *
 * Each channel is independent, bounded by its own deadline, and returns items in
 * one shape so the fusion stage doesn't care where they came from. A channel
 * that misses its deadline is dropped and named in `degraded`, because a slow
 * memory lookup must not turn a 400 ms request into a 4 s one -- and silently
 * returning less context without saying so is worse than either.
 */
import { pool, getProject } from "../db.js";
import { searchKnowledge, getSubgraph, getFileOutline } from "../graph.js";
import { getRules, filterRulesByPaths } from "../knowledge/rules.js";
import { recall } from "../knowledge/memory.js";
import { getHistory } from "../knowledge/history.js";

/** Where a set of symbol names live, in one query. */
async function locateSymbols(projectName, names) {
  if (!names.length) return new Map();
  const project = await getProject(projectName);
  if (!project) return new Map();
  const res = await pool.query(
    `SELECT DISTINCT ON (s.name) s.name, f.path, s.start_line
       FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.project_id = $1 AND s.name = ANY($2::text[])
      ORDER BY s.name, s.start_line`,
    [project.id, names]
  );
  return new Map(res.rows.map((r) => [r.name, r]));
}

/** Default per-channel deadline. The p95 target for a whole request is 500 ms. */
export const DEFAULT_DEADLINE_MS = 400;

/**
 * Run a promise against a deadline.
 *
 * The losing promise is NOT cancelled -- there is no way to abort an in-flight
 * Postgres query through node-postgres without tearing down the connection, and
 * tearing down a pooled connection to save 100 ms is a bad trade. It finishes
 * into the void; only the waiting stops.
 */
export function withDeadline(promise, ms, name) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ name, timedOut: true, value: null }), ms);
  });
  return Promise.race([
    promise.then(
      (value) => ({ name, timedOut: false, value }),
      (error) => ({ name, timedOut: false, value: null, error: error.message })
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

const clip = (s, n = 600) => (s == null ? null : String(s).slice(0, n));

/**
 * Code, docs and memories by similarity to the task.
 *
 * One call to searchKnowledge rather than a separate code channel and doc
 * channel: it already fuses symbols and chunks over the same query embedding, so
 * splitting them here into two ranked lists costs one query instead of two and
 * still lets the fusion stage weight prose differently from code.
 */
async function knowledgeChannel(projectName, task, limit) {
  const rows = await searchKnowledge(projectName, task, Math.max(limit * 2, 12));
  const code = [];
  const prose = [];
  for (const r of rows) {
    const item = {
      key: `${r.type}:${r.path ?? r.title}:${r.heading_path ?? r.line ?? ""}`,
      type: r.type === "code" ? "code" : r.type,
      title: r.title,
      ref: r.type === "code"
        ? `${r.path}${r.line ? `:${r.line}` : ""}`
        : [r.path, r.heading_path].filter(Boolean).join("#"),
      snippet: clip(r.snippet),
      why: `matched the task text (${(r.matched_via ?? []).join("+") || "search"})`,
    };
    (r.type === "code" ? code : prose).push(item);
  }
  return { code, prose };
}

/** Confirmed rules covering the hinted paths. Never candidates. */
async function rulesChannel(projectName, paths) {
  // Fetched once for every path rather than once per path: getRules already
  // loads all active rules and filters in JS, so N calls would be N identical
  // queries. filterRulesByPaths is the same predicate getRules uses.
  const { rules } = await getRules(projectName);
  return filterRulesByPaths(rules, paths).map((r) => ({
    key: r.key,
    type: "rule",
    title: r.statement,
    ref: r.origin_ref ? `${r.origin} ${r.origin_ref}` : r.origin,
    snippet: null,
    severity: r.severity,
    scope: r.scope,
    why: r.scope ? `rule scoped to ${r.scope}` : "project-wide rule",
  }));
}

/** Engineering memory, pinned first. */
async function memoryChannel(projectName, task, limit) {
  // recall() returns the array directly -- unlike getRules and getHistory, which
  // wrap theirs. Destructuring a `memories` key off it silently produced an
  // errored channel that the composer then reported as degraded.
  const memories = await recall(projectName, task, limit);
  return memories.map((m) => ({
    key: m.key,
    type: "memory",
    title: clip(m.content, 200),
    ref: m.key,
    snippet: clip(m.content),
    pinned: m.pinned,
    why: m.pinned ? "pinned memory" : `recalled for this task (${m.kind})`,
  }));
}

/** What was last fixed in the hinted paths. */
async function historyChannel(projectName, paths, limit) {
  if (!paths.length) return [];
  // One target, not N: the first hinted path is the most specific one (they are
  // ordered by length), and a history channel that fires eight queries inside a
  // 400 ms deadline is a channel that gets dropped.
  const { commits } = await getHistory(projectName, paths[0], limit * 2);
  const fixes = commits.filter((c) => c.is_fix);
  // Fixes first, but not exclusively: on a file nobody has ever filed a fix
  // against, recent commits are still the best available answer to "what has
  // been happening here".
  const chosen = (fixes.length ? fixes : commits).slice(0, limit);
  return chosen.map((c) => ({
    key: `commit:${c.short_sha}`,
    type: "commit",
    title: c.subject,
    ref: c.short_sha,
    snippet: clip(c.body, 400),
    why: c.is_fix ? `past fix touching ${paths[0]}` : `recent change to ${paths[0]}`,
  }));
}

/**
 * Graph expansion around what the task actually named.
 *
 * This is the step a pure-vector retriever structurally cannot do: the symbol a
 * task names is rarely the only one that has to change, and its callers and
 * callees are a fact in the database rather than something to hope similarity
 * surfaces.
 */
async function graphChannel(projectName, hints, limit) {
  const neighbours = []; // { name, from }
  for (const sym of hints.symbols.slice(0, 3)) {
    let sub;
    try {
      sub = await getSubgraph(projectName, sym.name, 1);
    } catch {
      continue; // getSubgraph throws on an unknown symbol; the hint was stale
    }
    for (const node of sub.nodes ?? []) {
      if (!node.name || node.name === sym.name) continue;
      neighbours.push({ name: node.name, from: sym.name });
    }
  }

  const items = [];
  if (neighbours.length) {
    // getSubgraph's nodes carry name and kind but no location, and a citation
    // without a file path is not a citation. One query resolves them all.
    const located = await locateSymbols(projectName, [...new Set(neighbours.map((n) => n.name))]);
    const seen = new Set();
    for (const n of neighbours) {
      const loc = located.get(n.name);
      if (!loc || seen.has(n.name)) continue;
      seen.add(n.name);
      items.push({
        key: `code:${loc.path}:${n.name}`,
        type: "graph",
        title: n.name,
        ref: `${loc.path}${loc.start_line ? `:${loc.start_line}` : ""}`,
        snippet: null,
        why: `one hop from ${n.from}`,
      });
    }
  }

  // With no symbol hint but a file hint, the file's outline is the equivalent
  // move: it says what is in the place the task pointed at.
  if (!items.length && hints.paths.length) {
    const outline = await getFileOutline(projectName, hints.paths[0]);
    for (const s of outline.slice(0, limit)) {
      items.push({
        key: `code:${hints.paths[0]}:${s.name}`,
        type: "graph",
        title: s.name,
        ref: `${hints.paths[0]}${s.start_line ? `:${s.start_line}` : ""}`,
        snippet: null,
        why: `defined in ${hints.paths[0]}`,
      });
    }
  }
  return items.slice(0, limit * 2);
}

/**
 * Run every channel in parallel against a shared deadline.
 *
 * @returns {Promise<{lists:Record<string,Array>, degraded:string[], errors:Object}>}
 */
export async function runChannels(projectName, task, hints, opts = {}) {
  const limit = opts.limit ?? 8;
  const deadline = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;

  const results = await Promise.all([
    withDeadline(knowledgeChannel(projectName, task, limit), deadline, "knowledge"),
    withDeadline(rulesChannel(projectName, hints.paths), deadline, "rules"),
    withDeadline(memoryChannel(projectName, task, limit), deadline, "memory"),
    withDeadline(historyChannel(projectName, hints.paths, limit), deadline, "history"),
    withDeadline(graphChannel(projectName, hints, limit), deadline, "graph"),
  ]);

  const lists = { code: [], doc: [], rules: [], memory: [], history: [], graph: [] };
  const degraded = [];
  const errors = {};

  for (const r of results) {
    if (r.timedOut) { degraded.push(`${r.name} (deadline)`); continue; }
    if (r.error) { degraded.push(`${r.name} (error)`); errors[r.name] = r.error; continue; }
    if (r.name === "knowledge") {
      lists.code = r.value.code;
      lists.doc = r.value.prose;
    } else if (r.name === "history") {
      lists.history = r.value;
    } else {
      lists[r.name] = r.value;
    }
  }

  return { lists, degraded, errors: Object.keys(errors).length ? errors : null };
}
