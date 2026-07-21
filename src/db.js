import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

/** Serialize a JS number array into pgvector literal format. */
export function toVector(arr) {
  return "[" + arr.map((x) => Number(x).toPrecision(8)).join(",") + "]";
}

export async function initDb() {
  const dim = config.embeddingDim;
  const sql = `
  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE TABLE IF NOT EXISTS projects (
    id          SERIAL PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    root_path   TEXT NOT NULL,
    indexed_at  TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS files (
    id          SERIAL PRIMARY KEY,
    project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,            -- relative to project root
    language    TEXT NOT NULL,
    hash        TEXT NOT NULL,            -- sha256 of content, for incremental indexing
    loc         INT DEFAULT 0,
    updated_at  TIMESTAMPTZ DEFAULT now(),
    UNIQUE (project_id, path)
  );

  CREATE TABLE IF NOT EXISTS symbols (
    id          SERIAL PRIMARY KEY,
    project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_id     INT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,            -- e.g. "MyClass::render" or "handle_cron"
    kind        TEXT NOT NULL,            -- function | method | class | interface | trait | hook_callback
    signature   TEXT,
    doc         TEXT,                     -- docblock / leading comment
    start_line  INT,
    end_line    INT,
    body        TEXT,                     -- source snippet (truncated)
    embedding   vector(${dim})
  );
  CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols (project_id, name);
  CREATE INDEX IF NOT EXISTS symbols_file_idx ON symbols (file_id);

  -- Relationship graph between symbols/files.
  -- src/dst reference symbols.id; unresolved targets keep dst NULL + dst_name.
  CREATE TABLE IF NOT EXISTS edges (
    id          SERIAL PRIMARY KEY,
    project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    src         INT REFERENCES symbols(id) ON DELETE CASCADE,
    dst         INT REFERENCES symbols(id) ON DELETE CASCADE,
    dst_name    TEXT,                     -- raw callee/import name when unresolved
    relation    TEXT NOT NULL,            -- CALLS | IMPORTS | EXTENDS | IMPLEMENTS | INSTANTIATES | USES_HOOK | REGISTERS_HOOK
    file_id     INT REFERENCES files(id) ON DELETE CASCADE,
    line        INT
  );
  CREATE INDEX IF NOT EXISTS edges_src_idx ON edges (src);
  CREATE INDEX IF NOT EXISTS edges_dst_idx ON edges (dst);
  CREATE INDEX IF NOT EXISTS edges_rel_idx ON edges (project_id, relation);

  -- One row per embedding API call, for token usage / cost reporting.
  -- project_id is SET NULL (not CASCADE) on project deletion so billing
  -- history survives a project being dropped/reindexed under a new name.
  CREATE TABLE IF NOT EXISTS embedding_usage (
    id          SERIAL PRIMARY KEY,
    project_id  INT REFERENCES projects(id) ON DELETE SET NULL,
    provider    TEXT NOT NULL,           -- voyage | openai
    model       TEXT NOT NULL,
    input_type  TEXT NOT NULL,           -- document | query
    tokens      INT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS embedding_usage_project_idx ON embedding_usage (project_id);
  CREATE INDEX IF NOT EXISTS embedding_usage_provider_idx ON embedding_usage (provider, model);
  `;
  await pool.query(sql);

  // HNSW index for fast ANN search (safe to re-run)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS symbols_embedding_idx
     ON symbols USING hnsw (embedding vector_cosine_ops)`
  );

  // Full-text search column for hybrid search (safe to re-run; a STORED
  // generated column backfills automatically for existing rows).
  await pool.query(
    `ALTER TABLE symbols ADD COLUMN IF NOT EXISTS fts_vector tsvector
     GENERATED ALWAYS AS (
       setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
       setweight(to_tsvector('simple', coalesce(doc,  '')), 'B') ||
       setweight(to_tsvector('simple', coalesce(body, '')), 'C')
     ) STORED`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS symbols_fts_idx ON symbols USING gin (fts_vector)`
  );
}

export async function getOrCreateProject(name, rootPath) {
  const res = await pool.query(
    `INSERT INTO projects (name, root_path) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET root_path = EXCLUDED.root_path
     RETURNING *`,
    [name, rootPath]
  );
  return res.rows[0];
}

export async function getProject(name) {
  const res = await pool.query(`SELECT * FROM projects WHERE name = $1`, [name]);
  return res.rows[0] || null;
}

export async function listProjects() {
  const res = await pool.query(
    `SELECT p.*,
       (SELECT count(*) FROM files f WHERE f.project_id = p.id)   AS file_count,
       (SELECT count(*) FROM symbols s WHERE s.project_id = p.id) AS symbol_count,
       (SELECT count(*) FROM edges e WHERE e.project_id = p.id)   AS edge_count
     FROM projects p ORDER BY p.name`
  );
  return res.rows;
}

/** Log one embedding API call for token usage / cost reporting. */
export async function recordEmbeddingUsage(projectId, provider, model, inputType, tokens) {
  if (!tokens) return;
  await pool.query(
    `INSERT INTO embedding_usage (project_id, provider, model, input_type, tokens)
     VALUES ($1,$2,$3,$4,$5)`,
    [projectId, provider, model, inputType, tokens]
  );
}

/** Aggregate embedding token usage, optionally scoped to one project. */
export async function getEmbeddingUsage(projectName) {
  const params = [];
  let where = "";
  if (projectName) {
    const project = await getProject(projectName);
    if (!project) throw new Error(`Project "${projectName}" not found.`);
    where = "WHERE eu.project_id = $1";
    params.push(project.id);
  }
  const res = await pool.query(
    `SELECT eu.provider, eu.model, eu.input_type,
            COUNT(*)::int AS requests, COALESCE(SUM(eu.tokens), 0)::bigint AS tokens,
            MIN(eu.created_at) AS first_seen, MAX(eu.created_at) AS last_seen
     FROM embedding_usage eu
     ${where}
     GROUP BY eu.provider, eu.model, eu.input_type
     ORDER BY eu.provider, eu.model, eu.input_type`,
    params
  );
  return res.rows;
}
