import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pool, initDb } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { backfillProjectIdentity } from "../src/backfillIdentity.js";
import { assignSymbolKeys } from "../src/identity.js";
import { cleanupTestProject } from "./helpers/testProject.js";
import { createGitRepo, writeRepoFile, commitAll, cleanupGitRepo } from "./helpers/gitFixture.js";

const PROJECT = "identity_fixture";
let repoDir;
let projectId;
let orgId;

// Long enough to be fingerprinted (see MIN_FINGERPRINT_CHARS) and distinctive
// enough that no other symbol collides with it.
const ALPHA_BODY = `function alpha(items) {
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return Math.round(total * 100) / 100;
}`;

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  repoDir = createGitRepo();
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (repoDir) cleanupGitRepo(repoDir);
  await pool.end();
});

const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

async function entityOf(symbolName) {
  const [row] = await q(
    `SELECT s.entity_id, e.natural_key, e.deleted_at, e.title, e.data->>'path' AS path
       FROM symbols s JOIN entities e ON e.id = s.entity_id
      WHERE s.project_id = $1 AND s.name = $2`,
    [projectId, symbolName]
  );
  return row;
}

test("indexing gives every symbol a key and a durable entity", async () => {
  writeRepoFile(repoDir, "alpha.js", ALPHA_BODY);
  writeRepoFile(repoDir, "beta.js", "function beta() { return 'b'.repeat(40) + 'padding for length'; }");
  commitAll(repoDir, "first");

  await indexProject(PROJECT, repoDir);
  const [project] = await q(`SELECT id, org_id FROM projects WHERE name = $1`, [PROJECT]);
  projectId = project.id;
  orgId = project.org_id;

  const symbols = await q(
    `SELECT name, symbol_key, body_fingerprint, entity_id FROM symbols
      WHERE project_id = $1 ORDER BY name`,
    [projectId]
  );
  assert.deepEqual(symbols.map((s) => s.symbol_key), ["alpha.js#function:alpha", "beta.js#function:beta"]);
  assert.ok(symbols.every((s) => s.entity_id), "every symbol should be linked to an entity");
  assert.ok(symbols.every((s) => s.body_fingerprint), "bodies are long enough to fingerprint");
});

test("re-indexing an edited file keeps the entity id stable", async () => {
  const before = await entityOf("alpha");

  writeRepoFile(repoDir, "alpha.js", ALPHA_BODY.replace("* 100) / 100", "* 1000) / 1000"));
  commitAll(repoDir, "change alpha rounding");
  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.changed, 1);

  const after = await entityOf("alpha");
  // The symbol row was deleted and reinserted with a fresh id; the entity --
  // the thing knowledge hangs off -- must not have moved.
  assert.equal(after.entity_id, before.entity_id);
  assert.equal(after.deleted_at, null);
  assert.equal(stats.identity.renamed, 0);
  assert.equal(stats.identity.tombstoned, 0);
});

test("moving a symbol to another file carries its entity across and records an alias", async () => {
  const before = await entityOf("alpha");

  const current = fs.readFileSync(path.join(repoDir, "alpha.js"), "utf8");
  fs.rmSync(path.join(repoDir, "alpha.js"));
  writeRepoFile(repoDir, "lib/alpha.js", current);
  commitAll(repoDir, "move alpha into lib");

  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.identity.renamed, 1);
  assert.equal(stats.identity.tombstoned, 0);

  const after = await entityOf("alpha");
  assert.equal(after.entity_id, before.entity_id, "entity must survive the move");
  assert.equal(after.natural_key, "lib/alpha.js#function:alpha");
  assert.equal(after.path, "lib/alpha.js");

  const [alias] = await q(
    `SELECT symbol_key, path, reason, entity_id FROM symbol_aliases WHERE project_id = $1`,
    [projectId]
  );
  assert.equal(alias.symbol_key, "alpha.js#function:alpha");
  assert.equal(alias.path, "alpha.js");
  assert.equal(alias.reason, "move");
  assert.equal(alias.entity_id, before.entity_id);
});

test("a symbol that is genuinely deleted is tombstoned, not erased", async () => {
  const before = await entityOf("beta");

  fs.rmSync(path.join(repoDir, "beta.js"));
  commitAll(repoDir, "drop beta");
  const stats = await indexProject(PROJECT, repoDir);
  assert.equal(stats.identity.tombstoned, 1);

  const [entity] = await q(`SELECT deleted_at, natural_key FROM entities WHERE id = $1`, [before.entity_id]);
  assert.ok(entity, "the entity row must still exist -- knowledge may point at it");
  assert.ok(entity.deleted_at, "and it must be marked dead");
  assert.equal(entity.natural_key, "beta.js#function:beta");
});

test("a deleted symbol coming back reuses its original entity id", async () => {
  const [beta] = await q(
    `SELECT id FROM entities WHERE project_id = $1 AND natural_key = $2`,
    [projectId, "beta.js#function:beta"]
  );

  writeRepoFile(repoDir, "beta.js", "function beta() { return 'b'.repeat(40) + 'padding for length'; }");
  commitAll(repoDir, "restore beta");
  await indexProject(PROJECT, repoDir);

  const after = await entityOf("beta");
  assert.equal(after.entity_id, beta.id, "ids are never reused, so the old one must come back");
  assert.equal(after.deleted_at, null, "and the tombstone must be lifted");
});

test("the SQL backfill produces exactly the keys the indexer would have", async () => {
  // The backfill and assignSymbolKeys() are two implementations of one rule.
  // If they drift, an upgraded install gets different keys from a fresh one
  // and every durable link silently points at nothing.
  const expected = new Map();
  for (const rel of ["lib/alpha.js", "beta.js"]) {
    const source = fs.readFileSync(path.join(repoDir, rel), "utf8");
    const { parseFile } = await import("../src/parser.js");
    const parsed = parseFile("js", source);
    assignSymbolKeys(rel, parsed.symbols).forEach(({ key }, i) => {
      expected.set(`${rel}::${parsed.symbols[i].name}`, key);
    });
  }

  // Wipe the identity columns the way a pre-0006 install has them, then let
  // the backfill reconstruct them from the database alone.
  await pool.query(
    `UPDATE symbols SET symbol_key = NULL, body_fingerprint = NULL, entity_id = NULL
      WHERE project_id = $1`,
    [projectId]
  );
  const result = await backfillProjectIdentity({ id: projectId, org_id: orgId, name: PROJECT });
  assert.ok(result.symbols >= 2);

  const rebuilt = await q(
    `SELECT f.path, s.name, s.symbol_key, s.body_fingerprint, s.entity_id
       FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.project_id = $1`,
    [projectId]
  );
  for (const row of rebuilt) {
    assert.equal(row.symbol_key, expected.get(`${row.path}::${row.name}`), `key for ${row.name}`);
    assert.ok(row.entity_id, `${row.name} should be linked to an entity`);
    assert.ok(row.body_fingerprint, `${row.name} should be fingerprinted`);
  }
});

test("the backfill's fingerprints match the ones JavaScript computes", async () => {
  const { bodyFingerprint } = await import("../src/identity.js");
  const rows = await q(
    `SELECT name, body, body_fingerprint FROM symbols WHERE project_id = $1`,
    [projectId]
  );
  for (const row of rows) {
    assert.equal(row.body_fingerprint, bodyFingerprint(row.body), `fingerprint for ${row.name}`);
  }
});

test("re-running the backfill is a no-op", async () => {
  const result = await backfillProjectIdentity({ id: projectId, org_id: orgId, name: PROJECT });
  assert.deepEqual(result, { files: 0, symbols: 0, entities: 0 });
});
