import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://codectx:codectx@localhost:5432/codectx",
  embeddingProvider: process.env.EMBEDDING_PROVIDER || "none",
  voyage: {
    apiKey: process.env.VOYAGE_API_KEY || "",
    model: process.env.VOYAGE_MODEL || "voyage-code-3",
    pricePerMTokens: process.env.VOYAGE_PRICE_PER_1M_TOKENS
      ? Number(process.env.VOYAGE_PRICE_PER_1M_TOKENS)
      : null,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
    pricePerMTokens: process.env.OPENAI_PRICE_PER_1M_TOKENS
      ? Number(process.env.OPENAI_PRICE_PER_1M_TOKENS)
      : null,
  },
  embeddingDim: parseInt(process.env.EMBEDDING_DIM || "1024", 10),
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || "1048576", 10),
};
