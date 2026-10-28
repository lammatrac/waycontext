import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SETTINGS,
  installDotenvPath,
  normalizeFileValue,
  PROJECT_DOTENV_IGNORED,
} from "./config.js";

const BROWSER_SECRET_PREFIX = "WAYCONTEXT_BROWSER_SECRET_";

/**
 * The config.json path for `env`, the way config.js picks it. Recomputed per call
 * because the module-level constant is frozen at import time.
 */
export function currentConfigPath(env = process.env) {
  return env.WAYCONTEXT_CONFIG || path.join(os.homedir(), ".config", "waycontext", "config.json");
}

function readDotenv(file) {
  try {
    return dotenv.parse(fs.readFileSync(file));
  } catch {
    return {};
  }
}

/**
 * Resolve every setting from the layers on disk, fresh on each call, so the
 * dashboard shows what a new process would see rather than what this one booted
 * with. Layers, highest first: `env`, the install .env, config.json, the default
 * (the service's cwd .env is deliberately not a layer; see scanProjectOverrides).
 * Secret rows carry only `isSet` and `source` -- value, fileValue and default are
 * null -- because the report is served over HTTP. Keys listed in `injected` were
 * put in env by the service itself, so they are not treated as user-set.
 */
export function inspectSettings({
  env = process.env,
  configPath = currentConfigPath(env),
  injected = (env.WAYCONTEXT_SERVICE_INJECTED ?? "").split(",").filter(Boolean),
  installDotenv = installDotenvPath,
} = {}) {
  let file = {};
  let configError = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) file = parsed;
  } catch (e) {
    if (e.code !== "ENOENT") configError = e.message;
  }

  // config.js skips every .env file under WAYCONTEXT_IGNORE_DOTENV=1; so must we.
  const dotenvVals = env.WAYCONTEXT_IGNORE_DOTENV === "1" ? {} : readDotenv(installDotenv);
  const skip = new Set(injected);
  const set = (v) => v !== undefined && v !== null && v !== "";

  // Winning non-file layer for a key, honouring dotenv's never-overwrite rule.
  const upper = (key, envOnly = false) => {
    if (!skip.has(key) && set(env[key])) return { value: env[key], source: "environment" };
    if (!envOnly && !(key in env) && set(dotenvVals[key])) return { value: dotenvVals[key], source: installDotenv };
    return null;
  };

  const rows = SETTINGS.map((def) => {
    const top = upper(def.key, def.envOnly);
    const fromFile =
      def.envOnly || file[def.key] === undefined || file[def.key] === null
        ? null
        : normalizeFileValue(file[def.key]);
    let value;
    let source;
    if (top) {
      ({ value, source } = top);
    } else if (fromFile !== null) {
      value = fromFile;
      source = configPath;
    } else {
      value = def.default;
      source = "built-in default";
    }
    const isSet = source !== "built-in default" || value !== null;
    const shadowedBy = !def.envOnly && top && fromFile !== null ? top.source : null;
    const row = {
      key: def.key,
      group: def.group,
      type: def.type,
      description: def.description,
      default: def.secret ? null : def.default,
      secret: !!def.secret,
      envOnly: !!def.envOnly,
      appliesOn: def.appliesOn,
      ...(def.options ? { options: def.options } : {}),
      value: def.secret ? null : value,
      isSet: def.secret ? source !== "built-in default" : isSet,
      source,
      fileValue: def.secret ? null : fromFile,
      shadowedBy,
    };
    return row;
  });

  const browserKeys = new Set(
    [...Object.keys(env), ...Object.keys(dotenvVals)].filter((k) => k.startsWith(BROWSER_SECRET_PREFIX)),
  );
  for (const key of [...browserKeys].sort()) {
    const top = upper(key);
    rows.push({
      key,
      group: "Browser",
      type: "string",
      description: "Browser login secret referenced by a profile. Only whether it is set is shown.",
      default: null,
      secret: true,
      envOnly: true,
      appliesOn: "next-session",
      value: null,
      isSet: !!top,
      source: top ? top.source : "built-in default",
      fileValue: null,
      shadowedBy: null,
    });
  }

  return { configFile: configPath, configError, settings: rows };
}

/**
 * Which registered settings each project's own `./.env` sets. A service started
 * from home never loads those files, but a CLI run from the project does, so a
 * dashboard edit can be silently overridden there. Keys outside the registry and
 * the ignored project keys (DATABASE_URL) are skipped; missing roots are too.
 */
export function scanProjectOverrides(projects) {
  const known = new Set(SETTINGS.filter((s) => !s.envOnly).map((s) => s.key));
  const out = [];
  for (const { name, root_path } of projects) {
    if (!root_path) continue;
    const envFile = path.join(root_path, ".env");
    let parsed;
    try {
      parsed = dotenv.parse(fs.readFileSync(envFile));
    } catch {
      continue;
    }
    const keys = Object.keys(parsed).filter((k) => known.has(k) && !PROJECT_DOTENV_IGNORED.has(k));
    if (keys.length) out.push({ project: name, envFile, keys });
  }
  return out;
}
