import { pool, getOrCreateProject } from "../../src/db.js";
import { embeddingModelId } from "../../src/embeddings.js";

export async function createTestProject(name) {
  return getOrCreateProject(name, `/tmp/${name}`);
}

export async function insertTestFile(projectId, filePath, language = "js") {
  const res = await pool.query(
    `INSERT INTO files (project_id, path, language, hash, loc)
     VALUES ($1, $2, $3, 'testhash', 1)
     RETURNING id`,
    [projectId, filePath, language]
  );
  return res.rows[0].id;
}

export async function insertTestSymbol(projectId, fileId, {
  name, kind = "function", signature = null, doc = null, body = null, embedding = null,
  // Stamped like src/indexer.js#writeEmbeddings would, so the vector is
  // comparable with queries embedded by the configured model.
  embeddingModel = embedding ? embeddingModelId() : null,
}) {
  const res = await pool.query(
    `INSERT INTO symbols (project_id, file_id, name, kind, signature, doc, start_line, end_line, body,
                          embedding, embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 10, $7, $8, $9)
     RETURNING id`,
    [projectId, fileId, name, kind, signature, doc, body, embedding, embeddingModel]
  );
  return res.rows[0].id;
}

export async function cleanupTestProject(name) {
  await pool.query(`DELETE FROM projects WHERE name = $1`, [name]);
}
