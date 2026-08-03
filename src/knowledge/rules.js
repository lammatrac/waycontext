/**
 * Rules: prescriptive project knowledge that gets injected into an agent's
 * context, and is therefore never created by a machine alone.
 *
 * Extraction here only ever writes `state='candidate'`. Promotion to 'active'
 * is a human action, reached from the CLI or from a git-tracked YAML file that
 * somebody committed. The asymmetry is deliberate: a confidently wrong rule
 * makes an agent measurably worse at its job, and unlike a bad search result it
 * is not self-correcting -- the agent has no way to tell that the rule was
 * invented.
 */
import crypto from "node:crypto";

const FENCE_BLOCK = /^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm;

// Cue strength is the whole confidence model, and it is deliberately crude: a
// prohibition is a rule far more often than a preference is. Anything subtler
// than this wants a language model in the extraction path, which this phase
// explicitly does not have.
const CUES = [
  { re: /\b(never|must not|must never|shall not|do not ever)\b/i, confidence: 0.65 },
  { re: /\b(must|always|required to|requires|don't|do not|no longer)\b/i, confidence: 0.6 },
  { re: /\b(should not|should|avoid|prefer|instead of)\b/i, confidence: 0.5 },
];

export function normalizeStatement(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?;:,]+$/, "");
}

/**
 * The natural key of a rule, derived from its wording and scope.
 *
 * Content-derived rather than serial so that re-extracting from the same ADR on
 * every index converges on the same row instead of piling up duplicates.
 */
export function ruleKey(statement, scope) {
  const hash = crypto
    .createHash("sha256")
    .update(`${normalizeStatement(statement)}|${scope ?? ""}`)
    .digest("hex");
  return `rule:${hash.slice(0, 12)}`;
}

/**
 * Pull normative sentences ("never X", "always Y") out of prose.
 *
 * Everything here is a filter against noise, because the cost of a wrong
 * candidate is a human's attention while the cost of a wrong *active* rule is
 * an agent that behaves worse. Questions go ("should we never do this?" is a
 * discussion, not a rule), fragments go, essays go, and code samples go.
 */
export function extractNormativeSentences(text) {
  if (!text) return [];
  const prose = String(text).replace(FENCE_BLOCK, "\n");
  const out = [];

  for (const rawLine of prose.split("\n")) {
    const line = rawLine.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith(">")) continue;

    for (const raw of line.split(/(?<=[.!?])\s+/)) {
      const sentence = raw.trim().replace(/^[`*_]+|[`*_]+$/g, "").trim();
      if (!sentence || sentence.endsWith("?")) continue;
      if (sentence.length > 300) continue;
      if (sentence.split(/\s+/).length < 4) continue;

      const cue = CUES.find((c) => c.re.test(sentence));
      if (!cue) continue;
      out.push({
        sentence: sentence.replace(/[.;,]+$/, ""),
        confidence: cue.confidence,
        cue: cue.re.exec(sentence)[1].toLowerCase(),
      });
    }
  }
  return out;
}

/**
 * The narrowest glob covering every path, or null for "everywhere".
 *
 * A rule inferred from a commit that touched two unrelated trees has no useful
 * scope, and guessing one would apply it where it was never meant to -- so it
 * gets none, and a human narrows it when confirming.
 */
export function inferScope(paths) {
  const clean = (paths ?? []).filter(Boolean);
  if (!clean.length) return null;
  if (clean.length === 1) return clean[0];

  const split = clean.map((p) => p.split("/").slice(0, -1));
  const common = [];
  for (let i = 0; i < split[0].length; i++) {
    const segment = split[0][i];
    if (split.every((parts) => parts[i] === segment)) common.push(segment);
    else break;
  }
  return common.length ? `${common.join("/")}/**` : null;
}
