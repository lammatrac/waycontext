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

export async function embedQuery(text, projectId = null) {
  const [v] = await embed([text], "query", projectId);
  return v;
}
