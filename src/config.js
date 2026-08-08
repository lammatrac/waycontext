import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Configuration, resolved from several sources so the same code works whether
 * WayContext was cloned, linked globally, or run via npx.
 *
 * Precedence, highest first:
 *   1. process.env                          (explicit, and what CI uses)
 *   2. ./.env                               (the project you're working in)
 *   3. <install dir>/.env                   (a git clone -- the original layout)
 *   4. ~/.config/waycontext/config.json     (or $WAYCONTEXT_CONFIG)
 *   5. built-in defaults
 *
 * dotenv never overwrites an already-set process.env entry, so loading the
 * files in order gives the earlier one priority.
 *
 * Resolving only via `__dirname` (the previous behaviour) breaks under a
 * global or npx install, where that path points inside node_modules and the
 * user's .env is nowhere near it.
 */
// Set WAYCONTEXT_IGNORE_DOTENV=1 to skip the .env files entirely and take
// configuration only from the environment (and the JSON file). Useful in
// containers and CI, where a stray .env inherited from a bind-mounted source
// tree would otherwise silently override the intended settings.
// Which .env file each key came from, so an error can name it. dotenv folds
// both files into process.env indistinguishably, and "check your environment"
// is unhelpful advice when the value actually came from a .env two directories
// away that the user forgot existed.
const dotenvSources = {};

if (process.env.WAYCONTEXT_IGNORE_DOTENV !== "1") {
  for (const file of [
    path.join(process.cwd(), ".env"),
    path.join(__dirname, "..", ".env"),
  ]) {
    const preexisting = new Set(Object.keys(process.env));
    const { parsed } = dotenv.config({ path: file });
    if (!parsed) continue;
    // dotenv never overwrites, so a key absent beforehand is one this file set.
    for (const key of Object.keys(parsed)) {
      if (!preexisting.has(key)) dotenvSources[key] = file;
    }
  }
}

const configFilePath =
  process.env.WAYCONTEXT_CONFIG ||
  path.join(os.homedir(), ".config", "waycontext", "config.json");

function loadConfigFile() {
  const file = configFilePath;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (e) {
    // A missing file is the normal case. A malformed one is worth saying out
    // loud, since silently ignoring it looks like the setting had no effect.
    if (e.code !== "ENOENT" && process.env.WAYCONTEXT_CONFIG) {
      console.error(`Warning: could not read ${file}: ${e.message}`);
    }
    return {};
  }
}

const fileConfig = loadConfigFile();

/**
 * Where each setting's value came from, keyed by env var name.
 *
 * Populated as a side effect of resolving `config` below. A first-run failure is
 * almost always "the value it used isn't the one you think it set", so the CLI's
 * error messages quote this -- see `describeSource`.
 */
export const sources = {};

/** process.env wins, then the JSON config file, then the built-in default. */
function setting(envKey, fallback) {
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined && fromEnv !== "") {
    sources[envKey] = dotenvSources[envKey] ?? "environment";
    return fromEnv;
  }
  const fromFile = fileConfig[envKey];
  if (fromFile !== undefined && fromFile !== null) {
    sources[envKey] = configFilePath;
    return String(fromFile);
  }
  sources[envKey] = "built-in default";
  return fallback;
}

/** Human-readable phrase for where a setting came from. */
export function describeSource(envKey) {
  const src = sources[envKey];
  if (!src) return "unknown";
  if (src === "environment" || src === "built-in default") return src;
  return src.replace(os.homedir(), "~");
}

function numeric(envKey, fallback) {
  const raw = setting(envKey, null);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNumber(envKey) {
  const raw = setting(envKey, null);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export const config = {
  databaseUrl: setting("DATABASE_URL", "postgres://codectx:codectx@localhost:5432/codectx"),
  embeddingProvider: setting("EMBEDDING_PROVIDER", "none"),
  voyage: {
    apiKey: setting("VOYAGE_API_KEY", ""),
    model: setting("VOYAGE_MODEL", "voyage-code-3"),
    pricePerMTokens: optionalNumber("VOYAGE_PRICE_PER_1M_TOKENS"),
  },
  openai: {
    apiKey: setting("OPENAI_API_KEY", ""),
    model: setting("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
    pricePerMTokens: optionalNumber("OPENAI_PRICE_PER_1M_TOKENS"),
  },
  // Every project belongs to an org. A local install has exactly one; the
  // column exists now so adding tenants later isn't a data migration.
  orgSlug: setting("ORG_SLUG", "default"),
  embeddingDim: numeric("EMBEDDING_DIM", 1024),
  maxFileSize: numeric("MAX_FILE_SIZE", 1048576),

  // Git history ingestion (Phase 1). Bounds apply to the FIRST pass over a
  // repository only -- later runs read the sha..HEAD range and are naturally
  // small. Set either to 0 to remove that bound.
  historyEnabled: setting("HISTORY_ENABLED", "1") !== "0",
  historyWindowMonths: numeric("HISTORY_WINDOW_MONTHS", 24),
  historyMaxCommits: numeric("HISTORY_MAX_COMMITS", 20000),
  // Ownership decays: someone who owned a file two years ago and hasn't
  // touched it since is not who you should ask about it today.
  ownershipHalfLifeDays: numeric("OWNERSHIP_HALF_LIFE_DAYS", 180),

  // Docs / ADR ingestion (Phase 2). Docs ride the same incremental pipeline as
  // code, so narrowing DOCS_GLOBS is about relevance, not cost -- an unchanged
  // file is hash-skipped either way.
  docsEnabled: setting("DOCS_ENABLED", "1") !== "0",
  docsGlobs: setting("DOCS_GLOBS", "**/*.md,**/*.mdx")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean),
  docsChunkChars: numeric("DOCS_CHUNK_CHARS", 4800),

  // Rules + engineering memory (Phase 3). One threshold, not two: nothing is
  // injected into context unless a human set state='active', whatever its
  // confidence, so this only decides what is worth proposing at all.
  rulesEnabled: setting("RULES_ENABLED", "1") !== "0",
  ruleCandidateMinConfidence: numeric("RULE_CANDIDATE_MIN_CONFIDENCE", 0.4),
  knowledgeDir: setting("KNOWLEDGE_DIR", ".waycontext/knowledge"),

  // Reasoning graphs: a Claude-authored decision tree per feature, written into
  // the target project as git-trackable JSON + a self-contained HTML viewer.
  // One dir per feature: <reasoningDir>/<slug>/{graph.json,waycontext-review.html}.
  reasoningDir: setting("REASONING_DIR", "docs/waycontext"),
  // Optional UX helper for local CLI usage: when enabled, create/update opens
  // the generated review HTML with the OS default app. On by default.
  reasoningAutoOpen: setting("REASONING_AUTO_OPEN", "1") === "1",

  // Derived intelligence (Phase 4). Everything here is recomputed from the
  // planes below it and skipped entirely when its inputs haven't moved, so the
  // cost of leaving it on is a watermark comparison per index run.
  deriveEnabled: setting("DERIVE_ENABLED", "1") !== "0",
  // A module is a directory this many levels deep: 2 gives "src/knowledge",
  // 1 gives "src". Depth is what makes modules nameable and stable; see
  // 0009_derived_intelligence.sql for why they aren't graph communities.
  moduleDepth: numeric("MODULE_DEPTH", 2),
  // Metrics are a trailing window, and window_days is stored on every row:
  // churn under 90 days and churn under 365 are not the same number.
  metricsWindowDays: numeric("METRICS_WINDOW_DAYS", 90),
  // A commit touching hundreds of files (a reformat, a dependency bump, a
  // license header sweep) contributes n^2 pairs that mean nothing about
  // coupling, and it is the single biggest source of both noise and cost in
  // co-change. Skipped commits are counted and reported, never dropped
  // silently. Set to 0 to disable the cap.
  cochangeMaxFiles: numeric("COCHANGE_MAX_FILES", 50),
  cochangeMinPairCommits: numeric("COCHANGE_MIN_PAIR_COMMITS", 2),
  // Greedy cosine agglomeration over fix-commit message embeddings. 0.82 is
  // the roadmap's figure; below ~0.75 unrelated fixes start merging.
  bugClusterThreshold: numeric("BUG_CLUSTER_THRESHOLD", 0.82),
  bugClusterMinSize: numeric("BUG_CLUSTER_MIN_SIZE", 2),
};
