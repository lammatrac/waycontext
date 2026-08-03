import { config } from "./config.js";
import { recordEmbeddingUsage } from "./db.js";

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
 * Embed an array of texts. Returns array of vectors (or nulls if disabled).
 * @param {string[]} texts
 * @param {"document"|"query"} inputType
 * @param {number|null} projectId for token-usage attribution (see `usage`/`waycontext usage`)
 */
export async function embed(texts, inputType = "document", projectId = null) {
  if (!embeddingsEnabled()) return texts.map(() => null);
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
