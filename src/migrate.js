/**
 * Forward-only SQL migration runner.
 *
 * Migrations live in src/migrations/NNNN_name.sql and are applied in numeric
 * order, once each, tracked in the schema_migrations ledger.
 *
 * Design notes:
 * - A session-level advisory lock serializes concurrent runners, so an MCP
 *   server booting and a `waycontext index` starting at the same moment
 *   can't race. Same discipline as the per-project lock in indexer.js.
 * - Each file runs inside its own transaction, unless its first line is
 *   `-- codectx:no-transaction` (needed for CREATE INDEX CONCURRENTLY, which
 *   cannot run in a transaction block). Such files must contain exactly one
 *   statement, since node-postgres wraps multi-statement queries implicitly.
 * - `${EMBEDDING_DIM}` is substituted from config before execution. Checksums
 *   are computed over the *raw* file text, so changing the env var doesn't
 *   invalidate the ledger.
 * - A checksum mismatch on an already-applied migration warns rather than
 *   fails: an operator who hand-edited a migration shouldn't be locked out
 *   of their own database.
 * - There are no down migrations. These are single-tenant installs where a
 *   schema rollback loses the data it described anyway.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/** Advisory lock key, shared by every runner against this database. */
const LOCK_KEY = "codectx_migrations";
const NO_TRANSACTION = "-- codectx:no-transaction";

/** Read and parse every migration file, sorted by numeric version. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const migrations = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".sql")) continue;
    const match = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!match) throw new Error(`Malformed migration filename: ${file} (expected NNNN_name.sql)`);
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    migrations.push({
      version: parseInt(match[1], 10),
      name: match[2],
      file,
      raw,
      checksum: crypto.createHash("sha256").update(raw).digest("hex"),
      inTransaction: !raw.trimStart().startsWith(NO_TRANSACTION),
    });
  }
  migrations.sort((a, b) => a.version - b.version);
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].version === migrations[i - 1].version) {
      throw new Error(`Duplicate migration version ${migrations[i].version}`);
    }
  }
  return migrations;
}

/** Substitute config-derived placeholders into migration SQL. */
function render(sql) {
  return sql.replaceAll("${EMBEDDING_DIM}", String(config.embeddingDim));
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      INT PRIMARY KEY,
      name         TEXT NOT NULL,
      checksum     TEXT NOT NULL,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      execution_ms INT
    )
  `);
}

async function appliedMap(client) {
  const res = await client.query(`SELECT version, name, checksum, applied_at FROM schema_migrations`);
  return new Map(res.rows.map((r) => [r.version, r]));
}

/**
 * Apply every pending migration. Safe to call on every process start.
 *
 * @param {(msg: string) => void} [log] optional progress sink
 * @returns {Promise<{applied: string[], skipped: number, warnings: string[]}>}
 */
export async function applyMigrations(log) {
  const migrations = loadMigrations();
  const client = await pool.connect();
  const applied = [];
  const warnings = [];
  let skipped = 0;
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [LOCK_KEY]);
    await ensureLedger(client);
    const already = await appliedMap(client);

    for (const m of migrations) {
      const prior = already.get(m.version);
      if (prior) {
        skipped++;
        if (prior.checksum !== m.checksum) {
          warnings.push(
            `Migration ${m.file} changed since it was applied (${prior.applied_at.toISOString?.() ?? prior.applied_at}). Not re-running it.`
          );
        }
        continue;
      }

      const sql = render(m.raw);
      const started = Date.now();
      log?.(`Applying ${m.file}…`);
      if (m.inTransaction) {
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await recordApplied(client, m, Date.now() - started);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw new Error(`Migration ${m.file} failed: ${e.message}`);
        }
      } else {
        try {
          await client.query(sql);
        } catch (e) {
          throw new Error(`Migration ${m.file} failed: ${e.message}`);
        }
        await recordApplied(client, m, Date.now() - started);
      }
      applied.push(m.file);
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK_KEY]).catch(() => {});
    client.release();
  }
  for (const w of warnings) log?.(`Warning: ${w}`);
  return { applied, skipped, warnings };
}

async function recordApplied(client, m, ms) {
  await client.query(
    `INSERT INTO schema_migrations (version, name, checksum, execution_ms)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (version) DO NOTHING`,
    [m.version, m.name, m.checksum, ms]
  );
}

/**
 * Report each migration's state without applying anything.
 * @returns {Promise<Array<{version:number,file:string,status:'applied'|'pending',applied_at:Date|null,checksum_ok:boolean}>>}
 */
export async function migrationStatus() {
  const migrations = loadMigrations();
  const client = await pool.connect();
  try {
    await ensureLedger(client);
    const already = await appliedMap(client);
    return migrations.map((m) => {
      const prior = already.get(m.version);
      return {
        version: m.version,
        file: m.file,
        status: prior ? "applied" : "pending",
        applied_at: prior ? prior.applied_at : null,
        checksum_ok: prior ? prior.checksum === m.checksum : true,
      };
    });
  } finally {
    client.release();
  }
}
