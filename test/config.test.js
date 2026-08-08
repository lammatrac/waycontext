import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.js reads its sources at import time, so each case loads a fresh copy
// with a cache-busting query string under a controlled environment.
let counter = 0;
async function loadConfig(env) {
  const saved = { ...process.env };
  // Ignore the repo's own .env so these assertions describe the precedence
  // rules rather than whatever this machine happens to have configured.
  process.env.WAYCONTEXT_IGNORE_DOTENV = "1";
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const mod = await import(`../src/config.js?case=${counter++}`);
    return mod.config;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-config-"));
function writeConfigFile(obj) {
  const file = path.join(dir, `config-${counter}.json`);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

test("environment variables are used when present", async () => {
  const cfg = await loadConfig({
    DATABASE_URL: "postgres://env@localhost/envdb",
    EMBEDDING_PROVIDER: "voyage",
    ORG_SLUG: "acme",
    WAYCONTEXT_CONFIG: undefined,
  });
  assert.equal(cfg.databaseUrl, "postgres://env@localhost/envdb");
  assert.equal(cfg.embeddingProvider, "voyage");
  assert.equal(cfg.orgSlug, "acme");
});

test("a JSON config file supplies values the environment lacks", async () => {
  const file = writeConfigFile({ ORG_SLUG: "from-file", EMBEDDING_DIM: 512 });
  const cfg = await loadConfig({ WAYCONTEXT_CONFIG: file, ORG_SLUG: undefined, EMBEDDING_DIM: undefined });
  assert.equal(cfg.orgSlug, "from-file");
  assert.equal(cfg.embeddingDim, 512);
});

test("the environment outranks the config file", async () => {
  const file = writeConfigFile({ ORG_SLUG: "from-file" });
  const cfg = await loadConfig({ WAYCONTEXT_CONFIG: file, ORG_SLUG: "from-env" });
  assert.equal(cfg.orgSlug, "from-env");
});

test("built-in defaults apply when nothing else sets a value", async () => {
  const cfg = await loadConfig({
    WAYCONTEXT_CONFIG: path.join(dir, "does-not-exist.json"),
    ORG_SLUG: undefined,
    EMBEDDING_PROVIDER: undefined,
    EMBEDDING_DIM: undefined,
    MAX_FILE_SIZE: undefined,
    REASONING_AUTO_OPEN: undefined,
  });
  assert.equal(cfg.orgSlug, "default");
  assert.equal(cfg.embeddingProvider, "none");
  assert.equal(cfg.embeddingDim, 1024);
  assert.equal(cfg.maxFileSize, 1048576);
  assert.equal(cfg.reasoningAutoOpen, true);
});

test("an empty environment variable falls through instead of blanking a default", async () => {
  const cfg = await loadConfig({ EMBEDDING_PROVIDER: "", WAYCONTEXT_CONFIG: undefined });
  assert.equal(cfg.embeddingProvider, "none");
});

test("numeric settings are coerced, and garbage falls back to the default", async () => {
  const good = await loadConfig({ EMBEDDING_DIM: "768", WAYCONTEXT_CONFIG: undefined });
  assert.equal(good.embeddingDim, 768);
  assert.equal(typeof good.embeddingDim, "number");

  const bad = await loadConfig({ EMBEDDING_DIM: "not-a-number", WAYCONTEXT_CONFIG: undefined });
  assert.equal(bad.embeddingDim, 1024);
});

test("optional prices stay null when unset rather than becoming NaN", async () => {
  const cfg = await loadConfig({
    VOYAGE_PRICE_PER_1M_TOKENS: undefined,
    OPENAI_PRICE_PER_1M_TOKENS: undefined,
    WAYCONTEXT_CONFIG: undefined,
  });
  assert.equal(cfg.voyage.pricePerMTokens, null);
  assert.equal(cfg.openai.pricePerMTokens, null);

  const priced = await loadConfig({ VOYAGE_PRICE_PER_1M_TOKENS: "0.18", WAYCONTEXT_CONFIG: undefined });
  assert.equal(priced.voyage.pricePerMTokens, 0.18);
});

test("a malformed config file does not crash startup", async () => {
  const file = path.join(dir, "broken.json");
  fs.writeFileSync(file, "{ not json");
  const cfg = await loadConfig({ WAYCONTEXT_CONFIG: file, ORG_SLUG: undefined });
  assert.equal(cfg.orgSlug, "default");
});

test("config file values of the wrong type are coerced to strings", async () => {
  const file = writeConfigFile({ ORG_SLUG: 42 });
  const cfg = await loadConfig({ WAYCONTEXT_CONFIG: file, ORG_SLUG: undefined });
  assert.equal(cfg.orgSlug, "42");
});

process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
