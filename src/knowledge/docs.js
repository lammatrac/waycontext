import path from "node:path";
import { splitSections, chunkMarkdown } from "./chunker.js";

// Extensions a prose reference may plausibly point at. Deliberately a local
// list rather than an import of parser.js's EXT_LANG: this module is pure text
// handling and must stay loadable -- and unit-testable -- without pulling in
// the native tree-sitter bindings.
const PATH_EXT = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".php", ".py", ".pyi", ".go",
  ".md", ".mdx", ".sql", ".json", ".yml", ".yaml", ".sh", ".css", ".html",
]);

const ADR_STATUS = new Set(["proposed", "accepted", "rejected", "superseded", "deprecated"]);
const FENCE_BLOCK = /^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm;

function unquote(v) {
  return v.replace(/^['"]|['"]$/g, "");
}

/**
 * Parse a leading `---` frontmatter block: flat scalars, `[a, b]` inline lists
 * and `- item` block lists.
 *
 * Not a YAML parser, and not trying to be. Frontmatter in a repo's docs is
 * key/value metadata; taking on a YAML dependency for it would be the tail
 * wagging the dog. Phase 3's .waycontext/knowledge/*.yaml export is the right
 * moment to reconsider.
 */
export function parseFrontmatter(content) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { frontmatter: {}, body: content };

  const frontmatter = {};
  let listKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      frontmatter[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;

    const [, key, value] = kv;
    if (!value) {
      listKey = key;
      frontmatter[key] = [];
      continue;
    }
    listKey = null;
    const inline = /^\[(.*)\]$/.exec(value.trim());
    frontmatter[key] = inline
      ? inline[1].split(",").map((v) => unquote(v.trim())).filter(Boolean)
      : unquote(value.trim());
  }
  return { frontmatter, body: content.slice(m[0].length) };
}

function headingOf(sections, re) {
  return sections.find((s) => s.heading && re.test(s.heading));
}

/** A section's text with its own heading line stripped. */
function sectionBody(section) {
  if (!section) return null;
  return section.content.split("\n").slice(1).join("\n").trim() || null;
}

/**
 * Classify a document: adr | readme | changelog | contributing | guide | note.
 *
 * ADR detection is deliberately generous -- location, numbered filename,
 * frontmatter status, or the Context+Decision heading pair -- because teams
 * keep decision records in all of those shapes and a missed ADR is the one
 * classification error that costs real retrieval quality.
 */
export function classifyDoc(relPath, sections = [], frontmatter = {}) {
  const lower = relPath.toLowerCase().replace(/\\/g, "/");
  const base = path.posix.basename(lower);
  const status = String(frontmatter.status ?? "").toLowerCase();

  const isAdr =
    /(^|\/)(adr|adrs|decisions|decision-records)\//.test(lower) ||
    /^\d{3,4}[-_]/.test(base) ||
    ADR_STATUS.has(status) ||
    (!!headingOf(sections, /^context\b/i) && !!headingOf(sections, /^decision\b/i));
  if (isAdr) return "adr";

  if (/^readme\b/.test(base)) return "readme";
  if (/^changelog\b/.test(base)) return "changelog";
  if (/^contributing\b/.test(base)) return "contributing";
  if (/(^|\/)(docs?|documentation|guides?)\//.test(lower)) return "guide";
  return "note";
}

/** { status, context, decision, consequences } for an ADR, or null. */
export function extractAdrSections(sections, frontmatter = {}) {
  const context = sectionBody(headingOf(sections, /^context\b/i));
  const decision = sectionBody(headingOf(sections, /^decision\b/i));
  const consequences = sectionBody(headingOf(sections, /^(consequences|outcome|results?)\b/i));
  const status =
    (frontmatter.status && String(frontmatter.status)) ||
    sectionBody(headingOf(sections, /^status\b/i))?.split("\n")[0] ||
    null;

  if (!context && !decision && !consequences && !status) return null;
  return { status, context, decision, consequences };
}

/**
 * Prose references to code.
 *
 * Paths are taken from anywhere; identifiers only from backticked spans,
 * because prose is full of ordinary words that happen to also be symbol names.
 * Fenced blocks are stripped first: an import inside a code sample is an
 * example, not a claim about what this document is about.
 */
export function extractMentions(body) {
  const prose = body.replace(FENCE_BLOCK, "\n");

  const paths = new Set();
  const pathRe = /(?:^|[\s`("'[])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,5})(?=[\s`)"'\],.:;]|$)/g;
  for (const m of prose.matchAll(pathRe)) {
    const candidate = m[1];
    if (candidate.includes("://")) continue;
    if (PATH_EXT.has(path.posix.extname(candidate).toLowerCase())) paths.add(candidate);
  }

  const identifiers = new Set();
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim();
    if (/^[A-Za-z_$][\w$]*(?:::[A-Za-z_$][\w$]*)?$/.test(token)) identifiers.add(token);
  }

  return { paths: [...paths], identifiers: [...identifiers] };
}

/**
 * Everything the indexer needs from one Markdown file, with no DB access.
 * @param {string} relPath repo-relative path
 * @param {string} content raw file text
 * @param {{target?: number}} [opts] chunker target size
 */
export function parseDocument(relPath, content, { target } = {}) {
  const { frontmatter, body } = parseFrontmatter(content);
  const sections = splitSections(body);
  const docType = classifyDoc(relPath, sections, frontmatter);
  const heading = sections.find((s) => s.heading)?.heading ?? null;

  return {
    title:
      (frontmatter.title && String(frontmatter.title)) ||
      heading ||
      path.posix.basename(relPath).replace(/\.[^.]+$/, ""),
    docType,
    frontmatter,
    adr: docType === "adr" ? extractAdrSections(sections, frontmatter) : null,
    mentions: extractMentions(body),
    chunks: chunkMarkdown(body, target ? { target } : undefined),
  };
}
