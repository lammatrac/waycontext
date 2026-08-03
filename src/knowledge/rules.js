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
import picomatch from "picomatch";
import { pool, getProject } from "../db.js";
import { config } from "../config.js";
import { resolveTarget } from "./history.js";

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

const RULE_COLUMNS = `
  r.entity_id AS id, e.natural_key AS key, r.statement, r.scope, r.severity,
  r.origin, r.origin_ref, r.confidence, r.state, r.verified_by, r.verified_at`;

async function requireProject(name) {
  const project = await getProject(name);
  if (!project) throw new Error(`Project "${name}" not found. Run index_project first.`);
  return project;
}

/**
 * Upsert one rule and return its entity id.
 *
 * The DO UPDATE list is the load-bearing part of this whole phase: it refreshes
 * the wording and provenance but never touches state, confidence or the
 * verification fields. Re-extraction therefore cannot un-confirm a rule a human
 * approved, nor resurrect one they rejected.
 */
export async function upsertRule(client, project, r) {
  const key = ruleKey(r.statement, r.scope ?? null);
  const er = await client.query(
    `INSERT INTO entities (org_id, project_id, kind, natural_key, title, source, data)
     VALUES ($1,$2,'rule',$3,$4,$5,$6)
     ON CONFLICT (project_id, kind, natural_key) DO UPDATE
        SET title = EXCLUDED.title, data = entities.data || EXCLUDED.data,
            deleted_at = NULL, updated_at = now()
     RETURNING id`,
    [
      project.org_id, project.id, key, r.statement.slice(0, 200),
      r.origin === "imported" || r.origin === "manual" ? "manual" : "inferred",
      JSON.stringify({ scope: r.scope ?? null, origin: r.origin }),
    ]
  );
  const entityId = er.rows[0].id;

  await client.query(
    `INSERT INTO rules (entity_id, org_id, project_id, statement, scope, severity,
                        origin, origin_ref, confidence, state, verified_by, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (entity_id) DO UPDATE
        SET statement  = EXCLUDED.statement,
            origin_ref = EXCLUDED.origin_ref,
            updated_at = now()`,
    [
      entityId, project.org_id, project.id, r.statement, r.scope ?? null,
      r.severity ?? "medium", r.origin, r.originRef ?? null,
      r.confidence ?? 0.5, r.state ?? "candidate",
      r.verifiedBy ?? null, r.verifiedBy ? new Date() : null,
    ]
  );
  return entityId;
}

/**
 * Propose rule candidates from this project's documents and fix commits.
 *
 * Runs on every index with no watermark: regex over a few thousand short
 * strings costs nothing next to the embedding round-trips in the same run, and
 * the upsert is idempotent by construction, since the key is derived from the
 * statement itself.
 */
export async function proposeRules(project, log = () => {}) {
  const result = { proposed: 0, candidates: 0 };
  const min = config.ruleCandidateMinConfidence;

  const docs = await pool.query(
    `SELECT d.path, d.adr FROM documents d WHERE d.project_id = $1`,
    [project.id]
  );
  const chunks = await pool.query(
    `SELECT d.path, c.content
       FROM chunks c JOIN documents d ON d.entity_id = c.entity_id
      WHERE c.project_id = $1`,
    [project.id]
  );
  const fixes = await pool.query(
    `SELECT c.sha, c.subject, c.body,
            (SELECT array_agg(cf.path) FROM commit_files cf
              WHERE cf.commit_entity_id = c.entity_id) AS paths
       FROM commits c
      WHERE c.project_id = $1 AND c.is_fix
      ORDER BY c.authored_at DESC`,
    [project.id]
  );

  const proposals = [];

  for (const doc of docs.rows) {
    const adr = doc.adr ?? {};
    for (const field of ["decision", "consequences"]) {
      for (const found of extractNormativeSentences(adr[field] ?? "")) {
        // An ADR's Decision section is the highest-signal prose a repository
        // has: somebody wrote it down deliberately, with consequences attached.
        proposals.push({
          statement: found.sentence, scope: null, origin: "adr", originRef: doc.path,
          confidence: Math.min(0.95, found.confidence + 0.1),
        });
      }
    }
  }

  for (const chunk of chunks.rows) {
    for (const found of extractNormativeSentences(chunk.content)) {
      proposals.push({
        statement: found.sentence, scope: null, origin: "doc", originRef: chunk.path,
        confidence: found.confidence,
      });
    }
  }

  for (const fix of fixes.rows) {
    const scope = inferScope(fix.paths ?? []);
    const text = [fix.subject, fix.body].filter(Boolean).join("\n");
    for (const found of extractNormativeSentences(text)) {
      proposals.push({
        statement: found.sentence, scope, origin: "fix_commit", originRef: fix.sha,
        confidence: Math.max(0.1, found.confidence - 0.1),
      });
    }
  }

  // Highest confidence wins when the same statement arrives from several
  // sources, so an ADR-backed rule isn't demoted by the same sentence appearing
  // in a commit message.
  const best = new Map();
  for (const p of proposals) {
    if (p.confidence < min) continue;
    const key = ruleKey(p.statement, p.scope);
    const prev = best.get(key);
    if (!prev || p.confidence > prev.confidence) best.set(key, p);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of best.values()) {
      await upsertRule(client, project, { ...p, severity: "medium", state: "candidate" });
      result.proposed++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    log(`Rule extraction failed: ${e.message}`);
    return result;
  } finally {
    client.release();
  }

  const count = await pool.query(
    `SELECT count(*)::int AS n FROM rules WHERE project_id = $1 AND state = 'candidate'`,
    [project.id]
  );
  result.candidates = count.rows[0].n;
  return result;
}

/**
 * Active rules that apply to a target.
 *
 * Glob matching happens here rather than in SQL because the scope is a
 * picomatch pattern, and because a rule with no scope is project-wide and must
 * apply to every target -- including one that resolves to no paths at all.
 */
export async function getRules(projectName, target) {
  const project = await requireProject(projectName);
  const resolved = target
    ? await resolveTarget(project, target)
    : { kind: "project", value: null, paths: null };

  const res = await pool.query(
    `SELECT ${RULE_COLUMNS} FROM rules r JOIN entities e ON e.id = r.entity_id
      WHERE r.project_id = $1 AND r.state = 'active'
      ORDER BY CASE r.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                               WHEN 'medium' THEN 2 ELSE 3 END, r.updated_at DESC`,
    [project.id]
  );

  const paths = resolved.paths;
  const rules = res.rows.filter((r) => {
    if (!r.scope) return true;
    if (!paths) return true; // project-wide question: every rule is in scope
    const match = picomatch(r.scope);
    return paths.some((p) => match(p) || p === r.scope);
  });

  return { target: resolved, rules };
}

/** Move a rule between states. Human-only: reached from the CLI, never from MCP. */
export async function setRuleState(projectName, idOrKey, state, verifiedBy = null) {
  if (!["candidate", "active", "rejected"].includes(state)) {
    throw new Error(`Unknown rule state "${state}"`);
  }
  const project = await requireProject(projectName);
  const res = await pool.query(
    `UPDATE rules r
        SET state = $3, verified_by = $4, verified_at = now(), updated_at = now()
       FROM entities e
      WHERE e.id = r.entity_id AND r.project_id = $1
        AND (e.natural_key = $2 OR r.entity_id::text = $2)
      RETURNING r.entity_id AS id, e.natural_key AS key, r.state, r.statement`,
    [project.id, String(idOrKey), state, verifiedBy]
  );
  if (!res.rows.length) throw new Error(`No rule "${idOrKey}" in project "${projectName}"`);
  return res.rows[0];
}

/** The candidate queue, best-first. CLI-only by design. */
export async function listCandidates(projectName, limit = 50) {
  const project = await requireProject(projectName);
  const res = await pool.query(
    `SELECT ${RULE_COLUMNS} FROM rules r JOIN entities e ON e.id = r.entity_id
      WHERE r.project_id = $1 AND r.state = 'candidate'
      ORDER BY r.confidence DESC, r.updated_at DESC
      LIMIT $2`,
    [project.id, limit]
  );
  return res.rows;
}
