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
 *   2. ./.env                               (the project you're working in;
 *                                            its plain DATABASE_URL is ignored)
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
// Keys that a project's own .env routinely sets for its *own* app. Run from such
// a project, `./.env` would otherwise hand WayContext the app's database -- a
// plain Postgres without pgvector, or a SQLAlchemy-style URL pg can't parse --
// and every command fails against a server that was never WayContext's. These
// are skipped from `./.env` only; the namespaced WAYCONTEXT_DATABASE_URL is the
// way to point WayContext at a database from a project .env.
export const PROJECT_DOTENV_IGNORED = new Set(["DATABASE_URL"]);

/**
 * Fold the .env files into `env`, earlier files winning (dotenv never overwrites).
 *
 * `files[0]` is the project's `./.env`, where PROJECT_DOTENV_IGNORED keys are
 * skipped. Returns which file set each key -- dotenv folds them into process.env
 * indistinguishably, and "check your environment" is unhelpful advice when the
 * value actually came from a .env two directories away that the user forgot
 * existed -- plus which project keys were skipped, so an error can say so.
 */
export function loadDotenvFiles(files, env = process.env) {
  const sources = {};
  const ignored = {};
  files.forEach((file, i) => {
    let parsed;
    try {
      parsed = dotenv.parse(fs.readFileSync(file));
    } catch {
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (i === 0 && PROJECT_DOTENV_IGNORED.has(key)) {
        ignored[key] = file;
        continue;
      }
      if (Object.hasOwn(env, key)) continue;
      env[key] = value;
      sources[key] = file;
    }
  });
  return { sources, ignored };
}

/** The install directory's .env (a git clone's original layout). */
export const installDotenvPath = path.join(__dirname, "..", ".env");

const { sources: dotenvSources, ignored: ignoredDotenv } =
  process.env.WAYCONTEXT_IGNORE_DOTENV === "1"
    ? { sources: {}, ignored: {} }
    : loadDotenvFiles([path.join(process.cwd(), ".env"), installDotenvPath]);

/**
 * Keys the .env files folded into process.env. They are indistinguishable from
 * real environment variables once folded, so a settings view needs this list to
 * say which file a value came from.
 */
export const dotenvKeys = Object.keys(dotenvSources);

/** Project `./.env` keys that were deliberately not applied, keyed by name. */
export { ignoredDotenv };

export const configFilePath =
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

/**
 * Every key passed to `setting()`. The registry below must describe each one, and
 * a test asserts it -- a setting read here but missing there would be invisible
 * to the settings dashboard.
 */
export const readKeys = new Set();

/**
 * The built-in default each key actually fell back to when nothing set it. The
 * defaults live twice -- in the registry and in the `config` literals -- and a
 * test compares the two sides through this map so they cannot drift apart.
 */
export const resolvedDefaults = {};

/**
 * A config.json value as the string `setting()` returns. JSON booleans become
 * "1"/"0" so they agree with the env-var convention; String(false) would give
 * "false", which the old `!== "0"` checks read as enabled. Exported so the
 * settings inspector resolves a file value exactly the way `config` does.
 */
export function normalizeFileValue(v) {
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v);
}

/** process.env wins, then the JSON config file, then the built-in default. */
function setting(envKey, fallback) {
  readKeys.add(envKey);
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined && fromEnv !== "") {
    sources[envKey] = dotenvSources[envKey] ?? "environment";
    return fromEnv;
  }
  const fromFile = fileConfig[envKey];
  if (fromFile !== undefined && fromFile !== null) {
    sources[envKey] = configFilePath;
    return normalizeFileValue(fromFile);
  }
  sources[envKey] = "built-in default";
  resolvedDefaults[envKey] = fallback;
  return fallback;
}

/** Env var holding a browser secret; `name` is the suffix a profile names. */
export function browserSecretEnvName(name) {
  return `WAYCONTEXT_BROWSER_SECRET_${name}`;
}

/**
 * The value of one browser secret, or undefined. Read live from process.env
 * (which already holds the folded-in .env files) and deliberately NOT from the
 * JSON config file or the `sources` map, so a secret is never recorded or
 * echoed by the config diagnostics. Only the prefixed variable is reachable.
 */
export function browserSecret(name) {
  const v = process.env[browserSecretEnvName(name)];
  return v === undefined || v === "" ? undefined : v;
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
  if (raw === null) {
    resolvedDefaults[envKey] = fallback;
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNumber(envKey) {
  const raw = setting(envKey, null);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * WAYCONTEXT_DATABASE_URL first, then DATABASE_URL. The namespaced key exists so
 * a project .env can configure WayContext without colliding with the app's own
 * DATABASE_URL; the winner's source is recorded under DATABASE_URL, which is the
 * key every error message asks about.
 */
function databaseUrl() {
  const namespaced = setting("WAYCONTEXT_DATABASE_URL", null);
  if (namespaced !== null) {
    sources.DATABASE_URL = `WAYCONTEXT_DATABASE_URL, ${describeSource("WAYCONTEXT_DATABASE_URL")}`;
    return namespaced;
  }
  return setting("DATABASE_URL", "postgres://codectx:codectx@localhost:5432/codectx");
}

/**
 * Every setting, declared once: type, default, group, description and when a
 * change takes effect. `config` below reads the same keys through `setting()`;
 * this table is what the settings dashboard renders and validates against.
 *
 * `default` is the string form a user would write (null = no default). `secret`
 * values are never shown or logged; `envOnly` keys are read before config.json
 * can be loaded (or only from the environment), so the file cannot set them.
 * `appliesOn` says what a change needs: "next-session" (the next MCP session or
 * CLI run), "next-index" (the next index run) or "service-restart" (the managed
 * HTTP service must be restarted).
 */
export const SETTINGS = [
  // Database
  { key: "DATABASE_URL", type: "string", default: null, group: "Database", secret: true, appliesOn: "next-session",
    description: "Postgres connection string. A built-in local default exists but is not listed here, since it carries credentials. A project's plain DATABASE_URL in ./.env is ignored; use WAYCONTEXT_DATABASE_URL there." },
  { key: "WAYCONTEXT_DATABASE_URL", type: "string", default: null, group: "Database", secret: true, appliesOn: "next-session",
    description: "Namespaced database URL; wins over DATABASE_URL so a project .env can configure WayContext without colliding with the app's own." },
  { key: "ORG_SLUG", type: "string", default: "default", group: "Database", appliesOn: "next-session",
    description: "Every project belongs to an org. A local install has exactly one; the column exists so adding tenants later isn't a data migration." },
  { key: "WAYCONTEXT_CONFIG", type: "path", default: null, group: "Database", envOnly: true, appliesOn: "next-session",
    description: "Path of the JSON config file (default ~/.config/waycontext/config.json). Read before the file exists, so it can only come from the environment." },
  { key: "WAYCONTEXT_IGNORE_DOTENV", type: "boolean", default: "0", group: "Database", envOnly: true, appliesOn: "next-session",
    description: "Skip the .env files and take configuration only from the environment and the JSON file. Useful in containers and CI." },

  // Embeddings
  { key: "EMBEDDING_PROVIDER", type: "enum", default: "none", group: "Embeddings", options: ["none", "voyage", "openai"], appliesOn: "next-index",
    description: "Which provider embeds code and docs for semantic search; none keeps full-text search only." },
  { key: "VOYAGE_API_KEY", type: "string", default: null, group: "Embeddings", secret: true, appliesOn: "next-index",
    description: "Voyage AI API key." },
  { key: "VOYAGE_MODEL", type: "string", default: "voyage-code-3", group: "Embeddings", appliesOn: "next-index",
    description: "Voyage embedding model." },
  { key: "VOYAGE_PRICE_PER_1M_TOKENS", type: "number", default: null, group: "Embeddings", appliesOn: "next-index",
    description: "Price per million tokens, used only to report indexing cost. Unset reports no cost." },
  { key: "OPENAI_API_KEY", type: "string", default: null, group: "Embeddings", secret: true, appliesOn: "next-index",
    description: "OpenAI API key." },
  { key: "OPENAI_EMBEDDING_MODEL", type: "string", default: "text-embedding-3-small", group: "Embeddings", appliesOn: "next-index",
    description: "OpenAI embedding model." },
  { key: "OPENAI_PRICE_PER_1M_TOKENS", type: "number", default: null, group: "Embeddings", appliesOn: "next-index",
    description: "Price per million tokens, used only to report indexing cost. Unset reports no cost." },
  { key: "EMBEDDING_DIM", type: "number", default: "1024", group: "Embeddings", appliesOn: "next-index",
    description: "Embedding vector dimension; must match the provider model and the database column." },
  { key: "EMBED_CONCURRENCY", type: "number", default: "4", group: "Embeddings", appliesOn: "next-index",
    description: "Embedding batches in flight at once during indexing. Raise it on a paid tier, lower it on a 429-prone one." },

  // Indexing
  { key: "MAX_FILE_SIZE", type: "number", default: "1048576", group: "Indexing", appliesOn: "next-index",
    description: "Files larger than this many bytes are not indexed." },

  // History
  { key: "HISTORY_ENABLED", type: "boolean", default: "1", group: "History", appliesOn: "next-index",
    description: "Ingest git history (commits, ownership, co-change inputs)." },
  { key: "HISTORY_WINDOW_MONTHS", type: "number", default: "24", group: "History", appliesOn: "next-index",
    description: "How far back the first pass over a repository reads. 0 removes the bound; later runs read only sha..HEAD." },
  { key: "HISTORY_MAX_COMMITS", type: "number", default: "20000", group: "History", appliesOn: "next-index",
    description: "Commit cap for the first pass over a repository. 0 removes the bound." },
  { key: "OWNERSHIP_HALF_LIFE_DAYS", type: "number", default: "180", group: "History", appliesOn: "next-index",
    description: "Ownership decays: someone who owned a file long ago and hasn't touched it since is not who to ask today." },

  // Docs
  { key: "DOCS_ENABLED", type: "boolean", default: "1", group: "Docs", appliesOn: "next-index",
    description: "Ingest docs and ADRs alongside code." },
  { key: "DOCS_GLOBS", type: "list", default: "**/*.md,**/*.mdx", group: "Docs", appliesOn: "next-index",
    description: "Comma-separated globs of doc files. Narrowing is about relevance, not cost: unchanged files are hash-skipped either way." },
  { key: "DOCS_CHUNK_CHARS", type: "number", default: "4800", group: "Docs", appliesOn: "next-index",
    description: "Target size of a doc chunk, in characters." },

  // Rules & knowledge
  { key: "RULES_ENABLED", type: "boolean", default: "1", group: "Rules & knowledge", appliesOn: "next-session",
    description: "Propose and inject engineering rules. Nothing is injected unless a human set its state to active." },
  { key: "RULE_CANDIDATE_MIN_CONFIDENCE", type: "number", default: "0.4", group: "Rules & knowledge", appliesOn: "next-session",
    description: "Minimum confidence for a rule to be worth proposing at all." },
  { key: "KNOWLEDGE_DIR", type: "path", default: ".waycontext/knowledge", group: "Rules & knowledge", appliesOn: "next-session",
    description: "Project-relative directory holding knowledge notes." },

  // Reasoning graphs
  { key: "REASONING_DIR", type: "path", default: "docs/waycontext", group: "Reasoning graphs", appliesOn: "next-session",
    description: "Project-relative directory for <slug>/graph.json and waycontext-review.html." },
  { key: "REASONING_AUTO_OPEN", type: "boolean", default: "1", group: "Reasoning graphs", appliesOn: "next-session",
    description: "Open the generated review HTML with the OS default app when a graph is created or updated." },

  // Service
  { key: "WAYCONTEXT_AUTO_SERVICE", type: "boolean", default: "1", group: "Service", appliesOn: "service-restart",
    description: "Start the managed local HTTP service automatically so review URLs work without a manual `waycontext serve`." },
  { key: "WAYCONTEXT_SERVICE_HOST", type: "string", default: "127.0.0.1", group: "Service", appliesOn: "service-restart",
    description: "Host the HTTP service binds to. Anything but loopback also needs WAYCONTEXT_ALLOW_PUBLIC_BIND." },
  { key: "WAYCONTEXT_SERVICE_PORT", type: "number", default: "4747", group: "Service", appliesOn: "service-restart",
    description: "Port the HTTP service listens on." },
  { key: "WAYCONTEXT_ALLOW_PUBLIC_BIND", type: "boolean", default: null, group: "Service", envOnly: true, appliesOn: "service-restart",
    description: "Permit binding the service to a non-loopback host. Any non-empty value (even 0) enables it. Set it only if you have put your own auth in front." },

  // UI intelligence
  { key: "UI_ENABLED", type: "boolean", default: "1", group: "UI intelligence", appliesOn: "next-index",
    description: "Extract UI elements into entities/entity_links. Off skips the pass entirely." },
  { key: "UI_I18N_LOCALE", type: "string", default: null, group: "UI intelligence", appliesOn: "next-index",
    description: "Locale whose catalog translation backs a UI element's text when a key resolves in several. Unset picks the lexicographically smallest." },

  // Browser
  { key: "BROWSER_ENABLED", type: "boolean", default: "1", group: "Browser", appliesOn: "next-session",
    description: "Kill switch for the Browser Session Manager. Off makes browser_* operations refuse with browser_disabled." },
  { key: "BROWSER_STATE_DIR", type: "path", default: null, group: "Browser", appliesOn: "next-session",
    description: "Root of the saved-state / evidence store, always outside any project tree. Default ~/.local/state/waycontext/browser; a leading ~ is expanded." },
  { key: "BROWSER_IDLE_TIMEOUT_SECONDS", type: "number", default: "900", group: "Browser", appliesOn: "next-session",
    description: "Close a READY browser session after this many seconds without a browser_* call; also the session lease. 0 or less disables it." },

  // Derived intelligence
  { key: "DERIVE_ENABLED", type: "boolean", default: "1", group: "Derived intelligence", appliesOn: "next-index",
    description: "Recompute modules, metrics, co-change and bug clusters. Skipped when inputs haven't moved." },
  { key: "MODULE_DEPTH", type: "number", default: "2", group: "Derived intelligence", appliesOn: "next-index",
    description: "A module is a directory this many levels deep: 2 gives src/knowledge, 1 gives src." },
  { key: "METRICS_WINDOW_DAYS", type: "number", default: "90", group: "Derived intelligence", appliesOn: "next-index",
    description: "Trailing window for metrics such as churn." },
  { key: "COCHANGE_MAX_FILES", type: "number", default: "50", group: "Derived intelligence", appliesOn: "next-index",
    description: "Commits touching more files than this are skipped for co-change (reformats and bumps mean nothing about coupling). 0 disables the cap." },
  { key: "COCHANGE_MIN_PAIR_COMMITS", type: "number", default: "2", group: "Derived intelligence", appliesOn: "next-index",
    description: "Minimum commits a file pair must share to count as coupled." },
  { key: "BUG_CLUSTER_THRESHOLD", type: "number", default: "0.82", group: "Derived intelligence", appliesOn: "next-index",
    description: "Cosine threshold for clustering fix-commit messages. Below about 0.75 unrelated fixes start merging." },
  { key: "BUG_CLUSTER_MIN_SIZE", type: "number", default: "2", group: "Derived intelligence", appliesOn: "next-index",
    description: "Smallest cluster of fixes worth reporting." },
];

const settingsByKey = new Map(SETTINGS.map((def) => [def.key, def]));

/** The registry entry for an env var name, or undefined. */
export function settingDef(key) {
  return settingsByKey.get(key);
}

const FLAG_OFF = new Set(["0", "false", "no", "off"]);
const FLAG_ON = new Set(["1", "true", "yes", "on"]);

/**
 * A boolean setting. "0"/"false"/"no"/"off" is off and "1"/"true"/"yes"/"on" is
 * on, in any case; anything else (unset, or a typo) takes the registry default,
 * so each flag keeps its own on-by-default or off-by-default behaviour.
 */
function flag(envKey) {
  const raw = setting(envKey, null);
  const norm = raw === null ? null : raw.trim().toLowerCase();
  if (FLAG_OFF.has(norm)) return false;
  if (FLAG_ON.has(norm)) return true;
  const on = settingDef(envKey).default === "1";
  resolvedDefaults[envKey] = on;
  return on;
}

export const config = {
  databaseUrl: databaseUrl(),
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
  // Embedding batches in flight at once during indexing. Provider round trips
  // dominate a first index; raise it on a paid tier, lower it on a 429-prone one.
  embedConcurrency: numeric("EMBED_CONCURRENCY", 4),
  maxFileSize: numeric("MAX_FILE_SIZE", 1048576),

  // Git history ingestion (Phase 1). Bounds apply to the FIRST pass over a
  // repository only -- later runs read the sha..HEAD range and are naturally
  // small. Set either to 0 to remove that bound.
  historyEnabled: flag("HISTORY_ENABLED"),
  historyWindowMonths: numeric("HISTORY_WINDOW_MONTHS", 24),
  historyMaxCommits: numeric("HISTORY_MAX_COMMITS", 20000),
  // Ownership decays: someone who owned a file two years ago and hasn't
  // touched it since is not who you should ask about it today.
  ownershipHalfLifeDays: numeric("OWNERSHIP_HALF_LIFE_DAYS", 180),

  // Docs / ADR ingestion (Phase 2). Docs ride the same incremental pipeline as
  // code, so narrowing DOCS_GLOBS is about relevance, not cost -- an unchanged
  // file is hash-skipped either way.
  docsEnabled: flag("DOCS_ENABLED"),
  docsGlobs: setting("DOCS_GLOBS", "**/*.md,**/*.mdx")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean),
  docsChunkChars: numeric("DOCS_CHUNK_CHARS", 4800),

  // Rules + engineering memory (Phase 3). One threshold, not two: nothing is
  // injected into context unless a human set state='active', whatever its
  // confidence, so this only decides what is worth proposing at all.
  rulesEnabled: flag("RULES_ENABLED"),
  ruleCandidateMinConfidence: numeric("RULE_CANDIDATE_MIN_CONFIDENCE", 0.4),
  knowledgeDir: setting("KNOWLEDGE_DIR", ".waycontext/knowledge"),

  // Reasoning graphs: a Claude-authored decision tree per feature, written into
  // the target project as git-trackable JSON + a self-contained HTML viewer.
  // One dir per feature: <reasoningDir>/<slug>/{graph.json,waycontext-review.html}.
  reasoningDir: setting("REASONING_DIR", "docs/waycontext"),
  // Optional UX helper for local CLI usage: when enabled, create/update opens
  // the generated review HTML with the OS default app. On by default.
  reasoningAutoOpen: flag("REASONING_AUTO_OPEN"),

  // Managed local HTTP service settings. Auto-start is on by default so
  // review URLs work without requiring a manual `waycontext serve` command.
  serviceAutoStart: flag("WAYCONTEXT_AUTO_SERVICE"),
  serviceHost: setting("WAYCONTEXT_SERVICE_HOST", "127.0.0.1"),
  servicePort: numeric("WAYCONTEXT_SERVICE_PORT", 4747),

  // UI intelligence (Increment 1A). Static extraction of UI elements (PHP
  // literal HTML today; JSX/TSX is a later increment) into entities/entity_links.
  // Additive-only: a project with no UI artifacts indexes ui_elements=0, not
  // a warning. Off entirely costs nothing -- the extraction pass is skipped.
  uiEnabled: flag("UI_ENABLED"),
  // Phase 1A-4 (REQ-003/REQ-004): which locale's catalog translation backs
  // ui_element.data.text when a key resolves in more than one locale. Unset
  // by default -- pickPrimaryLocale() then falls back to the
  // lexicographically smallest available locale (a deterministic but
  // arbitrary tiebreak; see src/ui/i18nCatalog.js doc comment). The full
  // per-locale map is always kept on the i18n_key entity regardless of this
  // setting, so it only affects which single value is surfaced as "the"
  // element text at index time.
  uiI18nLocale: setting("UI_I18N_LOCALE", "") || null,

  // Browser Session Manager kill switch. Off makes the browser_* operations
  // refuse with `browser_disabled`; it never hides them from the registry.
  // Profile import/remove stay available to the human CLI either way.
  browserEnabled: flag("BROWSER_ENABLED"),

  // Root of the saved-state / evidence store. Always outside any project tree
  // (see src/browser/stateStore.js). Override with BROWSER_STATE_DIR.
  browserStateDir: setting("BROWSER_STATE_DIR", "").replace(/^~(?=\/|$)/, os.homedir()) || path.join(os.homedir(), ".local", "state", "waycontext", "browser"),

  // Idle timeout for a browser session: with no browser_* call for this many
  // seconds a READY session is closed (reason idle_timeout). It is also the
  // lease written to browser_sessions.expires_at. 0 or less disables it.
  browserIdleTimeoutSeconds: numeric("BROWSER_IDLE_TIMEOUT_SECONDS", 900),

  // Derived intelligence (Phase 4). Everything here is recomputed from the
  // planes below it and skipped entirely when its inputs haven't moved, so the
  // cost of leaving it on is a watermark comparison per index run.
  deriveEnabled: flag("DERIVE_ENABLED"),
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
