import { pool, getProject } from "../db.js";
import { config } from "../config.js";

/**
 * Increment 1A UI recognition, phase 1A-7 (REQ-008/REQ-009/REQ-010/REQ-011):
 * the UI Reference Resolver -- turns a free-text task description and/or
 * structured hints into a ranked list of candidate `ui_element` rows, using
 * a deterministic 4-signal `match_score`.
 *
 * Not an MCP operation. 1A-8 is the phase that wires `resolveUiReference()`
 * into `resolve_ui_reference` (and the other four MCP-facing UI tools) via
 * `src/operations.js` -- this module is a plain, DB-aware library function,
 * the same "pure where possible" convention as every other `src/ui/*.js`
 * sibling (phpElements.js, phpHooks.js, phpI18nCalls.js, ...), except this
 * one is allowed to touch the DB itself since its whole job is a query, not
 * an extraction.
 *
 * REQ-009 judgment call (see contracts.md "Phase 1A-7" for the full
 * rationale): only the deterministic fallback path is implemented. No
 * server-side LLM/model-provider call is made anywhere in this module --
 * `task_text` never leaves the process. No "model provider" abstraction for
 * chat/completion exists anywhere in this codebase (only embedding-provider
 * config, which is unrelated); building one from scratch was judged out of
 * scope for a phase this size, and a forward-looking clause in REQ-009, not
 * a mandate for Increment 1A.
 */

// ---------------------------------------------------------------------------
// Text normalization / similarity -- deterministic, no ML, no LLM.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "is", "are", "was",
  "were", "it", "its", "this", "that", "and", "or", "with", "by", "from",
  "as", "be", "i", "we", "you", "my", "our", "your", "please", "when",
  "where", "how", "what", "which", "not", "does", "doesnt", "dont", "screen",
  "page", "tab", "click", "clicking", "button", "if", "but", "so", "just",
]);

function normalize(s) {
  if (typeof s !== "string" || !s) return "";
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits a raw identifier-ish string (owner name, file basename, ...) on
 * `::`, `_`, `-`, whitespace, and camelCase boundaries, in addition to the
 * normal normalize()+tokenize() rules. Used for the "context" signal, where
 * the input is code identifiers rather than prose. */
function tokenizeIdentifier(s) {
  if (typeof s !== "string" || !s) return [];
  const spaced = s
    .replace(/::/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]/g, " ");
  return tokenize(spaced);
}

function tokenize(s) {
  return normalize(s)
    .split(" ")
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/**
 * Deterministic 0..1 similarity between two free-text strings: exact match
 * (after normalization) scores 1, a substring containment either direction
 * scores 0.85, otherwise Jaccard token overlap. Returns 0 if either side is
 * empty/unresolvable -- an absent field never manufactures a match.
 */
export function textSimilarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  if (intersection === 0) return 0;
  const union = new Set([...ta, ...tb]).size;
  return intersection / union;
}

// ---------------------------------------------------------------------------
// REQ-008 / REQ-009: deterministic field extraction from free text, with
// structured hints (Q-009: screen/text/role) bypassing extraction per field.
// ---------------------------------------------------------------------------

// Longest phrase first, so "text field" matches before a bare "field" would.
// Heuristic, documented not exhaustive -- same style as i18nCatalog.js's own
// discovery heuristic doc comment.
const ELEMENT_TYPE_PHRASES = [
  ["radio button", "radio"],
  ["radio buttons", "radio"],
  ["check box", "checkbox"],
  ["checkbox", "checkbox"],
  ["text field", "textbox"],
  ["text box", "textbox"],
  ["search box", "textbox"],
  ["input field", "textbox"],
  ["textarea", "textbox"],
  ["textbox", "textbox"],
  ["input", "textbox"],
  ["field", "textbox"],
  ["drop down", "select"],
  ["drop-down", "select"],
  ["dropdown", "select"],
  ["select", "select"],
  ["menu item", "menuitem"],
  ["menuitem", "menuitem"],
  ["menu", "menu"],
  ["heading", "heading"],
  ["header", "heading"],
  ["title", "heading"],
  ["hyperlink", "link"],
  ["link", "link"],
  ["submit button", "button"],
  ["btn", "button"],
  ["button", "button"],
  ["icon", "image"],
  ["image", "image"],
  ["img", "image"],
  ["label", "label"],
  ["tab", "tab"],
  ["option", "option"],
  ["summary", "summary"],
  ["legend", "legend"],
  ["caption", "caption"],
];

/**
 * Canonicalizes an element-type phrase (from a structured hint, or from a
 * candidate's own already-resolved `data.type`/`data.role`) against the
 * table above. Structured hints are authoritative: an unrecognized hint is
 * passed through normalized rather than dropped. Returns null for an empty
 * input.
 */
export function canonicalElementType(raw, { passthroughUnknown = true } = {}) {
  const n = normalize(raw);
  if (!n) return null;
  for (const [phrase, canonical] of ELEMENT_TYPE_PHRASES) {
    if (n === phrase || n.includes(phrase)) return canonical;
  }
  return passthroughUnknown ? n : null;
}

function extractElementType(lowerText) {
  for (const [phrase, canonical] of ELEMENT_TYPE_PHRASES) {
    if (new RegExp(`\\b${phrase.replace(/[- ]/g, "[- ]")}\\b`, "i").test(lowerText)) {
      return canonical;
    }
  }
  return null;
}

// "on/in/at/under the <words> page/screen/tab/section/panel/menu"
const SCREEN_RE = /\b(?:on|in|at|under)\s+the\s+([a-z0-9][a-z0-9 '&-]{1,40}?)\s+(?:page|screen|tab|section|panel|menu)\b/i;

function extractScreen(text) {
  const m = SCREEN_RE.exec(text);
  return m ? m[1].trim() : null;
}

// Quoted substring -- the only deterministic, unambiguous way to pull a
// literal visible-text phrase out of free text without guessing at
// sentence structure.
const QUOTED_RE = /["“”']([^"“”']{1,80})["“”']/;

function extractVisibleText(text) {
  const m = QUOTED_RE.exec(text);
  return m ? m[1].trim() : null;
}

const VIEWPORT_PATTERNS = [
  [/\bmobile\b|\bphone\b|\bsmall screen\b|\bsmartphone\b/i, "mobile"],
  [/\btablet\b|\bipad\b/i, "tablet"],
  [/\bdesktop\b|\blaptop\b|\bwide screen\b|\bwidescreen\b/i, "desktop"],
];

function extractViewport(text) {
  for (const [re, value] of VIEWPORT_PATTERNS) {
    if (re.test(text)) return value;
  }
  return null;
}

const PROBLEM_TYPE_PATTERNS = [
  [/\bmissing\b|\bdoesn'?t (?:show|appear)\b|\bdoes not (?:show|appear)\b|\bnot (?:visible|showing|appearing)\b/i, "missing"],
  [/\bwrong text\b|\bincorrect (?:text|label)\b|\bmistranslat\w*\b/i, "incorrect_text"],
  [/\bdisabled\b|\bgreyed out\b|\bgrayed out\b/i, "disabled"],
  [/\bbroken\b|\bnot working\b|\bdoesn'?t work\b|\bdoes not work\b|\bfails?\b|\berror\b|\bcrash\w*\b/i, "broken"],
  // "positioned"/"position" added by 1A-9 (AC-007): the spec's own worked
  // example task text ("...is badly positioned on mobile") didn't match any
  // pattern here, leaving problem_type null for the canonical AC-007
  // scenario. A narrow addition to this already-non-exhaustive table, not a
  // new mechanism -- see contracts.md "Phase 1A-9".
  [/\bstyl(?:e|ing)\b|\bmisaligned\b|\boverlap\w*\b|\blayout\b|\bposition(?:ed|ing)?\b/i, "styling"],
];

function extractProblemType(text) {
  for (const [re, value] of PROBLEM_TYPE_PATTERNS) {
    if (re.test(text)) return value;
  }
  return null;
}

/**
 * REQ-008: extracts {screen, element_type, visible_text, viewport,
 * problem_type} from free-text `taskText`. `hints` (Q-009: `screen`,
 * `text`, `role`) bypass extraction for the fields they cover -- an
 * explicit hint is never overridden or second-guessed by the free-text
 * parse. Deterministic, synchronous, no I/O, no LLM (REQ-009).
 */
export function extractQueryFields(taskText, hints = {}) {
  const text = typeof taskText === "string" ? taskText : "";
  const lower = text.toLowerCase();

  const screen = hints.screen != null && hints.screen !== ""
    ? String(hints.screen).trim()
    : extractScreen(text);

  const visible_text = hints.text != null && hints.text !== ""
    ? String(hints.text).trim()
    : extractVisibleText(text);

  const element_type = hints.role != null && hints.role !== ""
    ? canonicalElementType(hints.role)
    : extractElementType(lower);

  const viewport = extractViewport(lower);
  const problem_type = extractProblemType(lower);

  return { screen, element_type, visible_text, viewport, problem_type };
}

// ---------------------------------------------------------------------------
// REQ-011: 4-signal match_score.
// ---------------------------------------------------------------------------

export const SIGNAL_WEIGHTS = Object.freeze({
  text: 0.4,
  route: 0.3,
  role: 0.2,
  context: 0.1,
});

export const MIN_MATCH_SCORE = 0.45;
export const MAX_CANDIDATES = 5;

/**
 * `candidate`: {data, screens}. `data` is a `ui_element.data` blob (1A-1/
 * 1A-4 shape). `screens` is an array (length 0, 1, or many -- EDGE-006) of
 * `ui_screen.data` blobs reached via this element's `RENDERED_ON` links.
 *
 * `queryFields`: the {screen, element_type, visible_text, viewport,
 * problem_type} shape `extractQueryFields()` returns, PLUS an optional
 * `taskText` (the raw free-text string) -- `taskText` feeds only the
 * context signal (below), which needs the raw prose rather than an already-
 * extracted field. Omitting it simply zeroes out the context signal's
 * contribution; the other three signals are unaffected.
 *
 * Returns {match_score, evidence}. `evidence` names signals in fixed order
 * (text, route, role, context) whenever that signal's own component score
 * is > 0, matching REQ-011's own example ordering.
 */
export function scoreCandidate(candidate, queryFields) {
  const data = candidate?.data || {};
  const screens = Array.isArray(candidate?.screens) ? candidate.screens : [];
  const qf = queryFields || {};

  // Text (0.40): the already-resolved data.text/data.text_source, verbatim
  // -- never re-derived from raw attrs (contracts.md "What 1A-7 needs to
  // know", Phase 1A-6).
  const textScore = textSimilarity(data.text, qf.visible_text);

  // Route/screen (0.30): max over every RENDERED_ON-linked screen, since a
  // ui_element may legitimately sit on 0, 1, or several screens (EDGE-006).
  let routeScore = 0;
  for (const screen of screens) {
    if (!screen) continue;
    const screenText = [screen.route, screen.menu_slug, screen.page_title, screen.menu_title]
      .filter(Boolean)
      .join(" ");
    routeScore = Math.max(routeScore, textSimilarity(screenText, qf.screen));
  }

  // Role/type (0.20): canonicalized exact match only -- role is a discrete
  // category, not a free-text field, so partial credit doesn't apply here.
  let roleScore = 0;
  if (qf.element_type) {
    const wantType = canonicalElementType(qf.element_type);
    const candType = data.type ? canonicalElementType(data.type) : null;
    const candRole = data.role ? canonicalElementType(data.role) : null;
    if (wantType && (wantType === candType || wantType === candRole)) {
      roleScore = 1;
    }
  }

  // Context (0.10): token-recall overlap between the raw task text and the
  // owning component's identity (data.owner + source_path basename). Judgment
  // call -- REQ-011 names this signal but doesn't define an algorithm; see
  // contracts.md "Phase 1A-7" for the reasoning. Deliberately reuses
  // data.owner directly rather than a second ui_component query, since
  // `owner` already *is* the component identity (1A-6).
  let contextScore = 0;
  const taskTokens = new Set(tokenize(qf.taskText || ""));
  if (taskTokens.size > 0 && data.owner && data.owner !== "@file") {
    const basename = (data.source_path || "").split("/").pop().replace(/\.[a-z0-9]+$/i, "");
    const componentTokens = new Set([
      ...tokenizeIdentifier(data.owner),
      ...tokenizeIdentifier(basename),
    ]);
    if (componentTokens.size > 0) {
      let hit = 0;
      for (const t of componentTokens) if (taskTokens.has(t)) hit++;
      contextScore = Math.min(1, hit / componentTokens.size);
    }
  }

  const match_score = Math.min(
    1,
    SIGNAL_WEIGHTS.text * textScore +
      SIGNAL_WEIGHTS.route * routeScore +
      SIGNAL_WEIGHTS.role * roleScore +
      SIGNAL_WEIGHTS.context * contextScore
  );

  const evidence = [];
  if (textScore > 0) evidence.push("text");
  if (routeScore > 0) evidence.push("route");
  if (roleScore > 0) evidence.push("role");
  if (contextScore > 0) evidence.push("context");

  return { match_score, evidence };
}

// ---------------------------------------------------------------------------
// REQ-010: DB-backed resolution -- ranked, capped at 5, floored at 0.45.
// ---------------------------------------------------------------------------

const CANDIDATE_POOL_LIMIT = 500;

/**
 * `resolveUiReference({project, taskText, hints, log})`:
 *  - `project`: project name (string), resolved via getProject().
 *  - `taskText`: free-text task description (optional).
 *  - `hints`: {screen?, text?, role?} structured hints (Q-009, optional).
 *  - `log`: optional (message) => void.
 *
 * Returns `{enabled, queryFields, candidates}`.
 *  - `enabled: false` (queryFields: null, candidates: []) when
 *    `config.uiEnabled` is off -- checked before any DB query, never throws
 *    for this reason.
 *  - Otherwise `queryFields` is `extractQueryFields()`'s output and
 *    `candidates` is at most MAX_CANDIDATES entries, each scoring >=
 *    MIN_MATCH_SCORE, sorted by `match_score` descending (ties broken by
 *    `element_id` for determinism).
 *
 * Throws if `project` does not resolve to an existing project (same
 * "caller's job to have a valid project name" contract every other query
 * function in this codebase assumes).
 */
export async function resolveUiReference({ project: projectName, taskText = "", hints = {}, log = () => {} }) {
  if (!config.uiEnabled) {
    return { enabled: false, queryFields: null, candidates: [] };
  }

  const project = await getProject(projectName);
  if (!project) {
    throw new Error(`Project not found: ${projectName}`);
  }

  const queryFields = extractQueryFields(taskText, hints);

  const res = await pool.query(
    `SELECT id, natural_key, title, data
       FROM entities
      WHERE project_id = $1 AND kind = 'ui_element' AND deleted_at IS NULL
      ORDER BY id
      LIMIT $2`,
    [project.id, CANDIDATE_POOL_LIMIT]
  );
  const rows = res.rows;
  if (rows.length === 0) {
    return { enabled: true, queryFields, candidates: [] };
  }
  if (rows.length === CANDIDATE_POOL_LIMIT) {
    log(
      `resolveUiReference: candidate pool hit the ${CANDIDATE_POOL_LIMIT}-row cap for project ` +
        `"${projectName}" -- results may omit relevant elements beyond this bound`
    );
  }

  const ids = rows.map((r) => r.id);
  const screenRes = await pool.query(
    `SELECT el.src_id, s.data AS screen_data
       FROM entity_links el
       JOIN entities s ON s.id = el.dst_id
      WHERE el.relation = 'RENDERED_ON' AND el.src_id = ANY($1::bigint[]) AND s.deleted_at IS NULL`,
    [ids]
  );
  const screensByElement = new Map();
  for (const row of screenRes.rows) {
    if (!screensByElement.has(row.src_id)) screensByElement.set(row.src_id, []);
    screensByElement.get(row.src_id).push(row.screen_data);
  }

  const scoreQueryFields = { ...queryFields, taskText };

  const scored = rows.map((r) => {
    const screens = screensByElement.get(r.id) || [];
    const { match_score, evidence } = scoreCandidate({ data: r.data, screens }, scoreQueryFields);
    return {
      element_id: r.data?.element_id || r.natural_key,
      title: r.title,
      match_score,
      evidence,
      text_source: r.data?.text_source ?? null,
      visible_text: r.data?.text ?? null,
      role: r.data?.role ?? null,
      type: r.data?.type ?? null,
      source_path: r.data?.source_path ?? null,
      owner: r.data?.owner ?? null,
      line: r.data?.line ?? null,
      ownership: r.data?.ownership ?? null,
      screens: screens.map((s) => ({
        screen_id: s?.screen_id ?? null,
        route: s?.route ?? null,
        menu_slug: s?.menu_slug ?? null,
        page_title: s?.page_title ?? null,
        menu_title: s?.menu_title ?? null,
      })),
    };
  });

  const candidates = scored
    .filter((c) => c.match_score >= MIN_MATCH_SCORE)
    .sort((a, b) => b.match_score - a.match_score || String(a.element_id).localeCompare(String(b.element_id)))
    .slice(0, MAX_CANDIDATES);

  return { enabled: true, queryFields, candidates };
}
