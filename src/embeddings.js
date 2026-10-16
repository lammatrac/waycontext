import { config } from "./config.js";
import { pool, recordEmbeddingUsage } from "./db.js";

const BATCH_SIZE = 64;

async function voyageEmbed(texts, inputType) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.voyage.apiKey}`,
    },
    body: JSON.stringify({
      model: config.voyage.model,
      input: texts,
      input_type: inputType, // "document" | "query"
      output_dimension: config.embeddingDim,
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return { vectors: data.data.map((d) => d.embedding), tokens: data.usage?.total_tokens ?? 0 };
}

async function openaiEmbed(texts) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.openai.model,
      input: texts,
      dimensions: config.embeddingDim,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return { vectors: data.data.map((d) => d.embedding), tokens: data.usage?.total_tokens ?? 0 };
}

export function embeddingsEnabled() {
  return config.embeddingProvider !== "none";
}

/**
 * "provider:model" for the configured embedding model, or null when off.
 *
 * Stamped on every stored vector and compared on every read: vectors from two
 * models live in unrelated spaces, so a query must only ever be ranked
 * against vectors its own model produced.
 */
export function embeddingModelId() {
  if (!embeddingsEnabled()) return null;
  const model =
    config.embeddingProvider === "voyage" ? config.voyage.model : config.openai.model;
  return `${config.embeddingProvider}:${model}`;
}

/**
 * Null every vector in `project` that the configured model did not produce,
 * so the next index run's `embedding IS NULL` sweep re-embeds it.
 *
 * A row's model is its own stamp, or for rows written before stamping
 * existed, the project's legacy_embedding_model (see migration 0014). A row
 * with neither is of unknown provenance and counts as stale.
 *
 * Returns the number of rows affected per table; `dryRun` only counts them.
 */
export async function clearStaleEmbeddings(project, { dryRun = false } = {}) {
  const current = embeddingModelId();
  if (!current) throw new Error("Embeddings are disabled (EMBEDDING_PROVIDER=none); nothing to re-embed with.");
  const params = [project.id, current, project.legacy_embedding_model ?? null];
  const stale = (vector, model) =>
    `project_id = $1 AND ${vector} IS NOT NULL AND COALESCE(${model}, $3::text) IS DISTINCT FROM $2`;

  const run = (table, vector, model) =>
    pool.query(
      dryRun
        ? `SELECT count(*)::int AS n FROM ${table} WHERE ${stale(vector, model)}`
        : `UPDATE ${table} SET ${vector} = NULL WHERE ${stale(vector, model)}`,
      params
    ).then((r) => (dryRun ? r.rows[0].n : r.rowCount));

  return {
    symbols: await run("symbols", "embedding", "embedding_model"),
    chunks: await run("chunks", "embedding", "embedding_model"),
    commits: await run("commits", "message_embedding", "message_embedding_model"),
  };
}

/**
 * Fail on a missing key before spending a request on it.
 *
 * Without this, a provider set with an empty key produces a `401` from the API
 * partway through an index run -- a confusing way to be told about a
 * configuration mistake, and it happens after the run has already done work.
 */
function assertProviderConfigured() {
  const provider = config.embeddingProvider;
  const key = provider === "voyage" ? config.voyage.apiKey : config.openai.apiKey;
  if (provider !== "voyage" && provider !== "openai") {
    throw new Error(
      `EMBEDDING_PROVIDER=${provider} is not a known provider. Use "voyage", "openai" or "none".`,
    );
  }
  if (!key) {
    const envKey = provider === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY";
    throw new Error(`EMBEDDING_PROVIDER=${provider} but ${envKey} is empty.`);
  }
}

/**
 * Embed an array of texts. Returns array of vectors (or nulls if disabled).
 * @param {string[]} texts
 * @param {"document"|"query"} inputType
 * @param {number|null} projectId for token-usage attribution (see `usage`/`waycontext usage`)
 */
export async function embed(texts, inputType = "document", projectId = null) {
  if (!embeddingsEnabled()) return texts.map(() => null);
  assertProviderConfigured();
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map(
      // hard cap input length to stay under provider token limits
      (t) => t.slice(0, 8000)
    );
    let result;
    let model;
    if (config.embeddingProvider === "voyage") {
      result = await voyageEmbed(batch, inputType);
      model = config.voyage.model;
    } else if (config.embeddingProvider === "openai") {
      result = await openaiEmbed(batch);
      model = config.openai.model;
    } else {
      throw new Error(`Unknown EMBEDDING_PROVIDER: ${config.embeddingProvider}`);
    }
    out.push(...result.vectors);
    await recordEmbeddingUsage(projectId, config.embeddingProvider, model, inputType, result.tokens);
  }
  return out;
}

// Query-embedding cache. Two things, both load-bearing for the context
// composer:
//
//   * LRU, because the same question gets asked repeatedly -- an agent
//     re-running a search, a UI re-rendering, a retry after an edit -- and the
//     provider round trip is the single largest cost in a retrieval request.
//   * single-flight, which matters more: the composer runs its channels in
//     parallel and two of them embed the SAME task text at the same instant.
//     Caching only resolved values would still make two API calls, so the
//     in-flight promise is what gets cached, and the second caller joins it.
//
// Keyed on provider, model and dimension as well as the text, so switching
// EMBEDDING_PROVIDER can't serve vectors from the wrong space.
const QUERY_CACHE_MAX = 256;
const queryCache = new Map();

function cacheKey(text) {
  const model =
    config.embeddingProvider === "voyage" ? config.voyage.model : config.openai.model;
  return `${config.embeddingProvider}|${model}|${config.embeddingDim}|${text}`;
}

/** Exposed for tests and for `waycontext serve`, which reports it. */
export function queryCacheStats() {
  return { size: queryCache.size, max: QUERY_CACHE_MAX };
}

export function clearQueryCache() {
  queryCache.clear();
}

export async function embedQuery(text, projectId = null) {
  if (!embeddingsEnabled()) return null;
  const key = cacheKey(text);

  const hit = queryCache.get(key);
  if (hit) {
    // Re-insert so the Map's insertion order stays least-recently-used first.
    queryCache.delete(key);
    queryCache.set(key, hit);
    return hit;
  }

  const pending = embed([text], "query", projectId).then(([v]) => v);
  queryCache.set(key, pending);
  try {
    const vector = await pending;
    // A null vector means the provider is off; caching that would be a lie the
    // moment it is switched back on.
    if (vector == null) queryCache.delete(key);
    while (queryCache.size > QUERY_CACHE_MAX) {
      queryCache.delete(queryCache.keys().next().value);
    }
    return vector;
  } catch (e) {
    // A failed call must not poison the cache: the next request should retry.
    queryCache.delete(key);
    throw e;
  }
}
