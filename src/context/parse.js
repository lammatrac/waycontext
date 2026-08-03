/**
 * Task parsing for the context composer.
 *
 * Deliberately regex and dictionary lookup, with no LLM anywhere near it. This
 * runs on every request inside a 500 ms p95 budget, and an LLM call to work out
 * that "fix the charge() retry bug in src/payments" mentions a function and a
 * directory would cost more than every other stage put together and be less
 * predictable than the code below.
 *
 * The pure half is here; resolving the guesses against what the project
 * actually contains is one query, at the bottom.
 */
import { pool } from "../db.js";

// Words that carry no retrieval signal in a task description. Kept short on
// purpose: over-filtering loses real query terms, and full-text search already
// has its own stopword handling.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this",
  "these", "those", "there", "here", "it", "its", "is", "are", "was", "were",
  "be", "been", "being", "to", "of", "in", "on", "at", "for", "with", "from",
  "by", "as", "into", "onto", "about", "when", "where", "while", "how", "why",
  "what", "which", "who", "do", "does", "did", "doing", "done", "can", "could",
  "should", "would", "will", "shall", "may", "might", "must", "not", "no",
  "i", "we", "you", "they", "me", "us", "them", "my", "our", "your", "their",
  "please", "need", "want", "make", "let", "get", "have", "has", "had",
]);

const QUOTED_RE = /"([^"]{2,80})"|'([^']{2,80})'/g;
const BACKTICKED_RE = /`([^`]{1,80})`/g;
// A path needs a separator or a known-looking extension; "src/payments" and
// "api.js" both qualify, "and/or" does not (no extension, single letters).
const PATH_RE = /\b[\w.-]+(?:\/[\w.-]+)+(?:\.\w{1,6})?\b|\b[\w-]{2,}\.(?:js|jsx|mjs|cjs|ts|tsx|py|php|go|rb|java|rs|sql|md|mdx|json|ya?ml)\b/g;
// camelCase, PascalCase, snake_case, CONSTANT_CASE, or Class::method.
const IDENTIFIER_RE = /\b(?:[a-z]+[A-Z]\w*|[A-Z][a-z]+[A-Z]\w*|\w+_\w+|[A-Z]{2,}_[A-Z_]+|\w+::\w+)\b/g;

/**
 * Reject slash-joined English. "and/or" matches any reasonable path pattern, and
 * so does "read/write" -- but a path whose every segment is an English function
 * word is not a path. Telling "src/payments" from "and/or" without a dictionary
 * is otherwise impossible, and this is the dictionary we already have.
 *
 * A false positive here is cheap (the path is resolved against `files` and
 * reported as unresolved) but it also strips those words out of `terms`, so it
 * costs real search signal.
 */
function looksLikePath(candidate) {
  if (candidate.includes(".")) return true; // an extension is proof enough
  const segments = candidate.split("/").filter(Boolean);
  return segments.some((s) => !STOPWORDS.has(s.toLowerCase()));
}

function collect(re, text, groups = [1]) {
  const out = [];
  for (const m of text.matchAll(re)) {
    for (const g of groups) if (m[g]) out.push(m[g].trim());
  }
  return out;
}

/**
 * Pull retrieval hints out of a free-form task description.
 *
 * @param {string} task
 * @returns {{text:string, paths:string[], identifiers:string[], phrases:string[], terms:string[]}}
 */
export function parseTask(task) {
  const text = String(task ?? "").trim();

  const phrases = collect(QUOTED_RE, text, [1, 2]);
  // Backticks are the strongest signal a human gives that a word is code, so
  // whatever is in them becomes an identifier candidate even if it doesn't look
  // like one -- `charge` is all lowercase and would otherwise be a plain term.
  const backticked = collect(BACKTICKED_RE, text);

  const paths = [...new Set([
    ...collect(PATH_RE, text, [0]),
    ...backticked.filter((b) => PATH_RE.test(b)),
  ])].filter(looksLikePath);

  const identifiers = [...new Set([
    ...collect(IDENTIFIER_RE, text, [0]),
    ...backticked.filter((b) => !paths.includes(b) && /^[\w:.]+$/.test(b)),
  ])];

  // Terms are for full-text search, so paths and identifiers are stripped out:
  // they get looked up exactly, and leaving them in would double-count them.
  // Lowercased, because `terms` is lowercased: without this "indexProject" never
  // matched the term "indexproject" and every identifier was also searched as a
  // plain word.
  const consumed = new Set([
    ...paths.flatMap((p) => p.toLowerCase().split(/[^\w]+/)),
    ...identifiers.flatMap((i) => i.toLowerCase().split(/[^\w]+/)),
  ]);
  const terms = [...new Set(
    text.toLowerCase()
      .split(/[^\w]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !consumed.has(w))
  )];

  return { text, paths, identifiers, phrases, terms };
}

/**
 * Check the guesses against what the project actually contains.
 *
 * One query per kind, both bounded: a task naming forty identifiers is a task
 * that pasted a stack trace, and expanding all of them would blow the budget
 * before retrieval started.
 *
 * @returns {Promise<{paths:string[], symbols:Array<{name:string,path:string,kind:string}>,
 *                    unresolved:{paths:string[], identifiers:string[]}}>}
 */
export async function resolveHints(project, parsed, limits = {}) {
  const maxPaths = limits.paths ?? 8;
  const maxSymbols = limits.symbols ?? 8;

  const [files, symbols] = await Promise.all([
    parsed.paths.length
      ? pool.query(
          // A directory hint ("src/payments") is as useful as a file hint, so
          // both an exact match and a prefix match count.
          `SELECT path FROM files
            WHERE project_id = $1
              AND (path = ANY($2::text[])
                   OR EXISTS (SELECT 1 FROM unnest($2::text[]) h
                               WHERE files.path LIKE h || '/%'))
            ORDER BY length(path) LIMIT $3`,
          [project.id, parsed.paths, maxPaths]
        )
      : { rows: [] },
    parsed.identifiers.length
      ? pool.query(
          `SELECT DISTINCT s.name, s.kind, f.path
             FROM symbols s JOIN files f ON f.id = s.file_id
            WHERE s.project_id = $1
              AND (s.name = ANY($2::text[])
                   OR s.name LIKE ANY (SELECT '%::' || h FROM unnest($2::text[]) h))
            ORDER BY s.name LIMIT $3`,
          [project.id, parsed.identifiers, maxSymbols]
        )
      : { rows: [] },
  ]);

  const resolvedPaths = files.rows.map((r) => r.path);
  const symbolPaths = symbols.rows.map((r) => r.path);

  return {
    // A symbol's file is a path hint too: "why does charge() double-bill" names
    // no path, but the rules and history that matter hang off the file it's in.
    paths: [...new Set([...resolvedPaths, ...symbolPaths])],
    symbols: symbols.rows,
    // Reported rather than dropped: "you mentioned src/billing, which this
    // project doesn't have" is a useful thing for an agent to be told.
    unresolved: {
      paths: parsed.paths.filter(
        (p) => !resolvedPaths.some((r) => r === p || r.startsWith(`${p}/`))
      ),
      identifiers: parsed.identifiers.filter(
        (i) => !symbols.rows.some((s) => s.name === i || s.name.endsWith(`::${i}`))
      ),
    },
  };
}
