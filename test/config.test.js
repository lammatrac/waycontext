import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.js reads its sources at import time, so each case loads a fresh copy
// with a cache-busting query string under a controlled environment.
let counter = 0;
async function loadConfig(env, { whole = false, clean = false } = {}) {
  const saved = { ...process.env };
  // `clean` drops every inherited variable but PATH/HOME, so a snapshot of the
  // defaults cannot be skewed by whatever the machine or CI has exported.
  if (clean) {
    for (const k of Object.keys(process.env)) if (k !== "PATH" && k !== "HOME") delete process.env[k];
  }
  // Ignore the repo's own .env so these assertions describe the precedence
  // rules rather than whatever this machine happens to have configured.
  process.env.WAYCONTEXT_IGNORE_DOTENV = "1";
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const mod = await import(`../src/config.js?case=${counter++}`);
    return whole ? mod : mod.config;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// Captured from the pre-registry build with a clean env (see the shape test).
const SHAPE_SNAPSHOT =
  "{\"databaseUrl\":\"postgres://codectx:codectx@localhost:5432/codectx\",\"embeddingProvider\":\"none\",\"voyage\":{\"apiKey\":\"\",\"model\":\"voyage-code-3\",\"pricePerMTokens\":null},\"openai\":{\"apiKey\":\"\",\"model\":\"text-embedding-3-small\",\"pricePerMTokens\":null},\"orgSlug\":\"default\",\"embeddingDim\":1024,\"embedConcurrency\":4,\"maxFileSize\":1048576,\"historyEnabled\":true,\"historyWindowMonths\":24,\"historyMaxCommits\":20000,\"ownershipHalfLifeDays\":180,\"docsEnabled\":true,\"docsGlobs\":[\"**/*.md\",\"**/*.mdx\"],\"docsChunkChars\":4800,\"rulesEnabled\":true,\"ruleCandidateMinConfidence\":0.4,\"knowledgeDir\":\".waycontext/knowledge\",\"reasoningDir\":\"docs/waycontext\",\"reasoningAutoOpen\":true,\"serviceAutoStart\":true,\"serviceHost\":\"127.0.0.1\",\"servicePort\":4747,\"uiEnabled\":true,\"uiI18nLocale\":null,\"browserEnabled\":true,\"browserStateDir\":\"/fixed/browser-state\",\"browserIdleTimeoutSeconds\":900,\"deriveEnabled\":true,\"moduleDepth\":2,\"metricsWindowDays\":90,\"cochangeMaxFiles\":50,\"cochangeMinPairCommits\":2,\"bugClusterThreshold\":0.82,\"bugClusterMinSize\":2}";

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

test("a project's own DATABASE_URL in ./.env does not override WayContext's", async () => {
  const { loadDotenvFiles } = await import(`../src/config.js?case=${counter++}`);
  const projectFile = path.join(dir, `project-${counter}.env`);
  const installFile = path.join(dir, `install-${counter}.env`);
  fs.writeFileSync(projectFile, "DATABASE_URL=postgresql+psycopg://app@localhost:55432/app\nORG_SLUG=from-project\n");
  fs.writeFileSync(installFile, "DATABASE_URL=postgres://codectx@localhost:5432/codectx\n");

  const env = {};
  const { sources, ignored } = loadDotenvFiles([projectFile, installFile], env);
  assert.equal(env.DATABASE_URL, "postgres://codectx@localhost:5432/codectx");
  assert.equal(sources.DATABASE_URL, installFile);
  assert.deepEqual(ignored, { DATABASE_URL: projectFile });
  // Only the generic key is skipped; WayContext's own settings still apply.
  assert.equal(env.ORG_SLUG, "from-project");
});

test("WAYCONTEXT_DATABASE_URL in ./.env is honoured and wins over DATABASE_URL", async () => {
  const { loadDotenvFiles } = await import(`../src/config.js?case=${counter++}`);
  const projectFile = path.join(dir, `project-${counter}.env`);
  fs.writeFileSync(projectFile, "WAYCONTEXT_DATABASE_URL=postgres://wc@localhost:5432/wc\n");
  const env = {};
  loadDotenvFiles([projectFile, path.join(dir, "missing.env")], env);
  assert.equal(env.WAYCONTEXT_DATABASE_URL, "postgres://wc@localhost:5432/wc");

  const cfg = await loadConfig({
    WAYCONTEXT_DATABASE_URL: "postgres://wc@localhost:5432/wc",
    DATABASE_URL: "postgres://app@localhost:5432/app",
    WAYCONTEXT_CONFIG: undefined,
  });
  assert.equal(cfg.databaseUrl, "postgres://wc@localhost:5432/wc");
});

test("a DATABASE_URL already in the environment is still used as before", async () => {
  const cfg = await loadConfig({
    WAYCONTEXT_DATABASE_URL: undefined,
    DATABASE_URL: "postgres://env@localhost/envdb",
    WAYCONTEXT_CONFIG: undefined,
  });
  assert.equal(cfg.databaseUrl, "postgres://env@localhost/envdb");
});

test("every setting() key has a registry entry", async () => {
  const { readKeys, settingDef } = await loadConfig({ WAYCONTEXT_CONFIG: undefined }, { whole: true });
  assert.ok(readKeys.size > 0);
  const missing = [...readKeys].filter((k) => !settingDef(k));
  assert.deepEqual(missing, []);
});

test("registry marks secrets", async () => {
  const { settingDef } = await loadConfig({ WAYCONTEXT_CONFIG: undefined }, { whole: true });
  for (const k of ["VOYAGE_API_KEY", "OPENAI_API_KEY", "DATABASE_URL", "WAYCONTEXT_DATABASE_URL"]) {
    assert.equal(settingDef(k).secret, true, k);
  }
});

test("meta keys are envOnly", async () => {
  const { settingDef } = await loadConfig({ WAYCONTEXT_CONFIG: undefined }, { whole: true });
  for (const k of ["WAYCONTEXT_CONFIG", "WAYCONTEXT_IGNORE_DOTENV", "WAYCONTEXT_ALLOW_PUBLIC_BIND"]) {
    assert.equal(settingDef(k).envOnly, true, k);
  }
});

test("EMBEDDING_PROVIDER is an enum", async () => {
  const { settingDef } = await loadConfig({ WAYCONTEXT_CONFIG: undefined }, { whole: true });
  assert.deepEqual(settingDef("EMBEDDING_PROVIDER").options, ["none", "voyage", "openai"]);
});

test("config shape unchanged", async () => {
  const cfg = await loadConfig(
    { WAYCONTEXT_CONFIG: path.join(dir, "missing.json"), BROWSER_STATE_DIR: "/fixed/browser-state" },
    { clean: true },
  );
  assert.equal(JSON.stringify(cfg), SHAPE_SNAPSHOT);
});

test("JSON false disables a feature", async () => {
  const file = writeConfigFile({ HISTORY_ENABLED: false });
  const cfg = await loadConfig({ WAYCONTEXT_CONFIG: file, HISTORY_ENABLED: undefined });
  assert.equal(cfg.historyEnabled, false);
});

test("JSON true enables auto-open", async () => {
  const file = writeConfigFile({ REASONING_AUTO_OPEN: true });
  const cfg = await loadConfig({ WAYCONTEXT_CONFIG: file, REASONING_AUTO_OPEN: undefined });
  assert.equal(cfg.reasoningAutoOpen, true);
});

test("JSON false turns auto-open off", async () => {
  const file = writeConfigFile({ REASONING_AUTO_OPEN: false });
  const cfg = await loadConfig({ WAYCONTEXT_CONFIG: file, REASONING_AUTO_OPEN: undefined });
  assert.equal(cfg.reasoningAutoOpen, false);
});

test('string "false" disables a boolean', async () => {
  const cfg = await loadConfig({ DOCS_ENABLED: "false", WAYCONTEXT_CONFIG: undefined });
  assert.equal(cfg.docsEnabled, false);
});

test("normalizeFileValue maps booleans to 1/0 and stringifies the rest", async () => {
  const { normalizeFileValue } = await loadConfig({ WAYCONTEXT_CONFIG: undefined }, { whole: true });
  assert.equal(normalizeFileValue(true), "1");
  assert.equal(normalizeFileValue(false), "0");
  assert.equal(normalizeFileValue(42), "42");
  assert.equal(normalizeFileValue("x"), "x");
});

test("registry defaults agree with the defaults config actually falls back to", async () => {
  const mod = await loadConfig(
    { WAYCONTEXT_CONFIG: path.join(dir, "missing.json"), BROWSER_STATE_DIR: undefined },
    { whole: true, clean: true },
  );
  let compared = 0;
  for (const def of mod.SETTINGS) {
    if (def.secret || def.envOnly || def.default === null) continue;
    assert.ok(Object.hasOwn(mod.resolvedDefaults, def.key), `${def.key} never resolved a default`);
    const expected =
      def.type === "number" ? Number(def.default) : def.type === "boolean" ? def.default === "1" : def.default;
    assert.deepEqual(mod.resolvedDefaults[def.key], expected, def.key);
    compared++;
  }
  assert.ok(compared > 20);
});

process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
