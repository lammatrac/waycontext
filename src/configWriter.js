import fs from "node:fs";
import path from "node:path";
import { settingDef } from "./config.js";
import { currentConfigPath } from "./settingsInspect.js";

const BROWSER_SECRET_PREFIX = "WAYCONTEXT_BROWSER_SECRET_";

/** A refused change; `status` is the HTTP status the service should answer with. */
export class ConfigWriteError extends Error {
  constructor(status, key, message) {
    super(message);
    this.name = "ConfigWriteError";
    this.status = status;
    this.key = key;
  }
}

/**
 * Resolve a key to its registry entry or throw. Browser secrets are not in the
 * registry but get 403 (not 400) so the caller learns secrets are refused.
 * Messages name the key only, never a value.
 */
function writableDef(key) {
  if (key.startsWith(BROWSER_SECRET_PREFIX)) {
    throw new ConfigWriteError(403, key, `${key} is a secret and cannot be changed here`);
  }
  const def = settingDef(key);
  if (!def) throw new ConfigWriteError(400, key, `${key} is not a known setting`);
  if (def.secret || def.envOnly) {
    throw new ConfigWriteError(403, key, `${key} cannot be changed here`);
  }
  return def;
}

/** Validate `value` for `def` and return the string stored in config.json. */
function coerce(def, value) {
  const key = def.key;
  const bad = (msg) => new ConfigWriteError(400, key, `${key}: ${msg}`);
  switch (def.type) {
    case "number": {
      if (typeof value === "string" ? value.trim() === "" : typeof value !== "number") {
        throw bad("expected a number");
      }
      const n = Number(value);
      if (!Number.isFinite(n)) throw bad("expected a finite number");
      return String(n);
    }
    case "boolean": {
      if (value === true || value === "1" || value === "true") return "1";
      if (value === false || value === "0" || value === "false") return "0";
      throw bad("expected true or false");
    }
    case "enum": {
      if (typeof value !== "string" || !def.options.includes(value)) {
        throw bad(`expected one of ${def.options.join(", ")}`);
      }
      return value;
    }
    case "list": {
      const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
      if (!items || !items.every((v) => typeof v === "string")) throw bad("expected a list of strings");
      return items.map((v) => v.trim()).filter(Boolean).join(",");
    }
    default: {
      if (typeof value !== "string") throw bad("expected a string");
      if (value === "") throw bad("empty value; use unset to remove the setting");
      return value;
    }
  }
}

/** A missing file starts from {}; one that is unreadable as an object is left alone (409). */
function readExisting(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigWriteError(409, null, "config file exists but is not valid JSON; fix or remove it by hand");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigWriteError(409, null, "config file exists but is not a JSON object; fix or remove it by hand");
  }
  return parsed;
}

/**
 * Apply validated set/unset changes to config.json. Everything is validated
 * before any disk write, and the file is replaced atomically (temp + rename)
 * with mode 0600 because the service maps errors straight to HTTP statuses.
 */
export function applyConfigChanges({ set = {}, unset = [] } = {}, { configPath = currentConfigPath() } = {}) {
  const toWrite = {};
  for (const [key, value] of Object.entries(set)) toWrite[key] = coerce(writableDef(key), value);
  for (const key of unset) writableDef(key);

  const current = readExisting(configPath);
  for (const key of unset) delete current[key];
  Object.assign(current, toWrite);

  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, configPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.chmodSync(configPath, 0o600);
  return { written: Object.keys(toWrite), removed: [...unset] };
}
