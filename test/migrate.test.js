import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb } from "../src/db.js";
import { loadMigrations, migrationStatus } from "../src/migrate.js";

let tmpDir;

before(async () => {
  await initDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-migrations-"));
});

after(async () => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  await pool.end();
});

function writeMigration(name, body) {
  fs.writeFileSync(path.join(tmpDir, name), body);
}

// --- loadMigrations: pure, no database ---------------------------------

test("loadMigrations sorts by numeric version, not lexically", () => {
  writeMigration("0002_second.sql", "SELECT 2;\n");
  writeMigration("0010_tenth.sql", "SELECT 10;\n");
  writeMigration("0001_first.sql", "SELECT 1;\n");
  const migrations = loadMigrations(tmpDir);
  assert.deepEqual(
    migrations.map((m) => m.version),
    [1, 2, 10]
  );
  assert.deepEqual(
    migrations.map((m) => m.name),
    ["first", "second", "tenth"]
  );
});

test("loadMigrations detects the no-transaction directive", () => {
  writeMigration("0003_concurrent.sql", "-- codectx:no-transaction\nCREATE INDEX CONCURRENTLY x ON y (z);\n");
  const migrations = loadMigrations(tmpDir);
  const plain = migrations.find((m) => m.version === 1);
  const concurrent = migrations.find((m) => m.version === 3);
  assert.equal(plain.inTransaction, true);
  assert.equal(concurrent.inTransaction, false);
});

test("loadMigrations checksums the raw text, so ${EMBEDDING_DIM} does not affect it", () => {
  writeMigration("0004_templated.sql", "CREATE TABLE t (v vector(${EMBEDDING_DIM}));\n");
  const first = loadMigrations(tmpDir).find((m) => m.version === 4);
  const second = loadMigrations(tmpDir).find((m) => m.version === 4);
  assert.equal(first.checksum, second.checksum);
  assert.match(first.raw, /\$\{EMBEDDING_DIM\}/);
});

test("loadMigrations rejects a malformed filename", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-bad-"));
  fs.writeFileSync(path.join(dir, "no_version_prefix.sql"), "SELECT 1;");
  assert.throws(() => loadMigrations(dir), /Malformed migration filename/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadMigrations rejects duplicate versions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-dup-"));
  fs.writeFileSync(path.join(dir, "0001_a.sql"), "SELECT 1;");
  fs.writeFileSync(path.join(dir, "0001_b.sql"), "SELECT 2;");
  assert.throws(() => loadMigrations(dir), /Duplicate migration version 1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadMigrations returns empty for a missing directory", () => {
  assert.deepEqual(loadMigrations(path.join(tmpDir, "does-not-exist")), []);
});

// --- applyMigrations against the real database -------------------------

test("initDb is idempotent: a second run applies nothing", async () => {
  const result = await initDb();
  assert.deepEqual(result.applied, [], "no migration should be pending after before()");
  assert.ok(result.skipped >= 1, "the baseline should be recorded as already applied");
  assert.deepEqual(result.warnings, []);
});

test("the baseline is recorded in the ledger with a checksum", async () => {
  const res = await pool.query(
    `SELECT version, name, checksum, applied_at FROM schema_migrations WHERE version = 1`
  );
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].name, "baseline");
  assert.match(res.rows[0].checksum, /^[0-9a-f]{64}$/);
  assert.ok(res.rows[0].applied_at instanceof Date);
});

test("the baseline produced the tables the rest of the code depends on", async () => {
  const res = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [["projects", "files", "symbols", "edges", "embedding_usage"]]
  );
  assert.equal(res.rows.length, 5);
});

test("migrationStatus reports every migration as applied with a matching checksum", async () => {
  const rows = await migrationStatus();
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.equal(row.status, "applied", `${row.file} should be applied`);
    assert.equal(row.checksum_ok, true, `${row.file} checksum should match the ledger`);
    assert.ok(row.applied_at instanceof Date);
  }
});

test("concurrent runners serialize on the advisory lock without failing", async () => {
  const results = await Promise.all([initDb(), initDb(), initDb()]);
  for (const result of results) {
    assert.deepEqual(result.applied, []);
  }
  const res = await pool.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 1`);
  assert.equal(res.rows[0].n, 1, "the baseline must be recorded exactly once");
});

test("a checksum drift on an applied migration warns instead of failing", async () => {
  const original = await pool.query(`SELECT checksum FROM schema_migrations WHERE version = 1`);
  await pool.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1`);
  try {
    const result = await initDb();
    assert.deepEqual(result.applied, [], "a drifted migration must not be re-run");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /0001_baseline\.sql changed since it was applied/);

    const status = await migrationStatus();
    assert.equal(status.find((r) => r.version === 1).checksum_ok, false);
  } finally {
    await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = 1`, [
      original.rows[0].checksum,
    ]);
  }
});
