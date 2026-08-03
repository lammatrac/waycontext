/**
 * Team sharing without a server: rules and memories in git-tracked YAML.
 *
 * This is the free-tier sharing mechanism -- point every developer's
 * WAYCONTEXT_DATABASE_URL wherever they like, and let `.waycontext/knowledge/`
 * travel with the repository. It is also the second promotion path for rules,
 * which is why the import semantics below are so deliberately one-directional.
 */
import fs from "node:fs";
import path from "node:path";
// js-yaml 5 is ESM-first with named exports only: a default import throws at
// module load.
import { load, dump } from "js-yaml";
import { pool, getProject } from "../db.js";
import { config } from "../config.js";
import { upsertRule } from "./rules.js";
import { remember } from "./memory.js";

const DUMP_OPTS = { lineWidth: 100, noRefs: true, sortKeys: false };

function knowledgeDir(project, dir) {
  return path.resolve(dir ?? path.join(project.root_path, config.knowledgeDir));
}

function readYaml(file, key) {
  if (!fs.existsSync(file)) return [];
  const parsed = load(fs.readFileSync(file, "utf8"));
  const list = parsed?.[key];
  return Array.isArray(list) ? list.filter((e) => e && typeof e === "object") : [];
}

/**
 * Write this project's knowledge to git-trackable YAML.
 *
 * Candidates go in their own file so that a reviewer reading a diff of
 * rules.yaml sees only what humans confirmed, not what a regex guessed.
 */
export async function exportKnowledge(projectName, dir = null) {
  const project = await getProject(projectName);
  if (!project) throw new Error(`Project "${projectName}" not found.`);
  const target = knowledgeDir(project, dir);
  fs.mkdirSync(target, { recursive: true });

  const rules = await pool.query(
    `SELECT e.natural_key AS key, r.statement, r.scope, r.severity, r.origin,
            r.origin_ref, r.confidence, r.state, r.verified_by
       FROM rules r JOIN entities e ON e.id = r.entity_id
      WHERE r.project_id = $1 AND r.state IN ('active','candidate')
      ORDER BY r.state, r.severity, e.natural_key`,
    [project.id]
  );
  const memories = await pool.query(
    `SELECT e.natural_key AS key, m.kind, m.content, m.scope, m.pinned, m.author
       FROM memories m JOIN entities e ON e.id = m.entity_id
      WHERE m.project_id = $1 AND e.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM memories s WHERE s.supersedes = m.entity_id)
      ORDER BY e.natural_key`,
    [project.id]
  );

  const active = rules.rows.filter((r) => r.state === "active").map(({ state, ...r }) => r);
  const candidates = rules.rows.filter((r) => r.state === "candidate").map(({ state, ...r }) => r);

  fs.writeFileSync(path.join(target, "rules.yaml"), dump({ rules: active }, DUMP_OPTS));
  fs.writeFileSync(path.join(target, "candidates.yaml"), dump({ candidates }, DUMP_OPTS));
  fs.writeFileSync(path.join(target, "memories.yaml"), dump({ memories: memories.rows }, DUMP_OPTS));

  return {
    dir: target,
    rules: active.length,
    candidates: candidates.length,
    memories: memories.rows.length,
  };
}

/**
 * Read knowledge back out of YAML.
 *
 * Additive and promoting only: entries in rules.yaml become active, entries in
 * candidates.yaml stay candidates, and nothing here ever deletes, deactivates or
 * downgrades. That is the whole hazard of having two promotion paths -- a stale
 * file must not silently switch off a rule someone confirmed with
 * `rule confirm`, and a candidate listed in YAML must not demote a rule that is
 * already live.
 */
export async function importKnowledge(projectName, dir = null) {
  const project = await getProject(projectName);
  if (!project) throw new Error(`Project "${projectName}" not found.`);
  const target = knowledgeDir(project, dir);
  const result = { rules: 0, candidates: 0, memories: 0, promoted: 0 };
  if (!fs.existsSync(target)) return result;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const entry of readYaml(path.join(target, "rules.yaml"), "rules")) {
      if (!entry.statement) continue;
      const entityId = await upsertRule(client, project, {
        statement: String(entry.statement), scope: entry.scope ?? null,
        severity: entry.severity ?? "medium", origin: entry.origin ?? "imported",
        originRef: entry.origin_ref ?? "rules.yaml", confidence: entry.confidence ?? 1,
        state: "active", verifiedBy: entry.verified_by ?? "yaml",
      });
      // upsertRule never touches the state of a row that already exists, so
      // promotion is an explicit second statement -- and it only moves upward,
      // never from active back to candidate.
      const promoted = await client.query(
        `UPDATE rules SET state = 'active',
                          verified_by = COALESCE(verified_by, $2),
                          verified_at = COALESCE(verified_at, now()),
                          updated_at = now()
          WHERE entity_id = $1 AND state = 'candidate'
          RETURNING entity_id`,
        [entityId, entry.verified_by ?? "yaml"]
      );
      result.promoted += promoted.rowCount ?? 0;
      result.rules++;
    }

    for (const entry of readYaml(path.join(target, "candidates.yaml"), "candidates")) {
      if (!entry.statement) continue;
      await upsertRule(client, project, {
        statement: String(entry.statement), scope: entry.scope ?? null,
        severity: entry.severity ?? "medium", origin: entry.origin ?? "imported",
        originRef: entry.origin_ref ?? "candidates.yaml",
        confidence: entry.confidence ?? 0.5, state: "candidate", verifiedBy: null,
      });
      result.candidates++;
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Memories go through remember() rather than raw SQL so an imported one is
  // chunked and queued for embedding exactly like an agent-written one.
  for (const entry of readYaml(path.join(target, "memories.yaml"), "memories")) {
    if (!entry.content) continue;
    await remember(projectName, {
      content: String(entry.content), kind: entry.kind ?? "gotcha",
      scope: entry.scope ?? null, pinned: Boolean(entry.pinned),
      author: entry.author ?? null, source: "imported",
    });
    result.memories++;
  }

  return result;
}
