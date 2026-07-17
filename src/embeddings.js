import { config } from "./config.js";

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
  return data.data.map((d) => d.embedding);
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
  return data.data.map((d) => d.embedding);
}

export function embeddingsEnabled() {
  return config.embeddingProvider !== "none";
}

/**
 * Embed an array of texts. Returns array of vectors (or nulls if disabled).
 * @param {string[]} texts
 * @param {"document"|"query"} inputType
 */
export async function embed(texts, inputType = "document") {
  if (!embeddingsEnabled()) return texts.map(() => null);
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map(
      // hard cap input length to stay under provider token limits
      (t) => t.slice(0, 8000)
    );
    if (config.embeddingProvider === "voyage") {
      out.push(...(await voyageEmbed(batch, inputType)));
    } else if (config.embeddingProvider === "openai") {
      out.push(...(await openaiEmbed(batch)));
    } else {
      throw new Error(`Unknown EMBEDDING_PROVIDER: ${config.embeddingProvider}`);
    }
  }
  return out;
}

export async function embedQuery(text) {
  const [v] = await embed([text], "query");
  return v;
}
