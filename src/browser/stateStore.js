/**
 * Saved-state store (REQ-006, Q-004 A) and artifact references.
 *
 * Playwright storageState (cookies, localStorage) is written only here, under
 * `config.browserStateDir` (default ~/.local/state/waycontext/browser,
 * BROWSER_STATE_DIR overrides):
 *
 *   <root>/<org>/<project>/<profile>/storage-state.json
 *   <root>/<org>/<project>/<profile>/evidence/<sessionId>/<name>      (screenshots)
 *
 * Files are mode 0600, directories 0700, unencrypted. The root must be outside
 * every git working tree and outside any `forbiddenRoots` the caller passes
 * (P4 passes the project's indexed root_path). The database only ever holds a
 * `storage_ref`, an opaque `<kind>:<path relative to the root>` string, so
 * moving the root does not invalidate rows and no absolute path or content is
 * stored.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { pool } from "../db.js";
import { BrowserError } from "./errors.js";
import { registerSensitive } from "./secrets.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_FILE = "storage-state.json";
const ARTIFACT_TYPES = ["storage_state", "screenshot"];
const SEG_RE = /^[A-Za-z0-9._~%!*'()-]+$/; // encodeURIComponent output

export function defaultStateDir() {
  return config.browserStateDir;
}

function badRef(detail) {
  return new BrowserError("invalid_storage_ref", detail);
}

/** One path segment from a scope value: percent-encoded, never "", "." or "..". */
function seg(value, what) {
  const s = encodeURIComponent(String(value ?? ""));
  if (s === "" || s === "." || s === "..") throw badRef(`invalid ${what}`);
  return s;
}

function scopeSegs(scope) {
  return [seg(scope?.orgId, "org"), seg(scope?.project, "project"), seg(scope?.profileId, "profile")];
}

function plainName(value, what) {
  const s = String(value ?? "");
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..") throw badRef(`invalid ${what}`);
  return s;
}

/** `{ kind, rel }` for a well-formed ref, else throws invalid_storage_ref. */
function parseRef(ref) {
  const m = typeof ref === "string" ? /^([a-z_]+):(.+)$/.exec(ref) : null;
  if (!m || !ARTIFACT_TYPES.includes(m[1])) throw badRef("unrecognised storage_ref");
  const [, kind, rel] = m;
  const parts = rel.split("/");
  if (!parts.every((p) => SEG_RE.test(p) && p !== "." && p !== "..")) throw badRef("unrecognised storage_ref");
  const shapeOk = kind === "storage_state"
    ? parts.length === 4 && parts[3] === STATE_FILE
    : parts.length === 6 && parts[3] === "evidence";
  if (!shapeOk) throw badRef("unrecognised storage_ref");
  return { kind, parts };
}

/** Absolute file path for a ref. Pure: no filesystem access, no existence check. */
export function resolveStorageRef(ref, { baseDir = defaultStateDir() } = {}) {
  const { parts } = parseRef(ref);
  const root = path.resolve(baseDir);
  const file = path.join(root, ...parts);
  if (path.relative(root, file).startsWith("..")) throw badRef("unrecognised storage_ref");
  return file;
}

function realish(p) {
  // realpath of the deepest existing ancestor, so a symlink cannot smuggle the root into a tree.
  let cur = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...tail);
}

function inside(child, root) {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertOutsideTrees(baseDir, forbiddenRoots) {
  const root = realish(baseDir);
  for (const f of [REPO_ROOT, ...forbiddenRoots]) {
    if (f && inside(root, realish(f))) throw new BrowserError("invalid_state_dir", "state directory is inside a project tree");
  }
  for (let cur = root; ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, ".git"))) throw new BrowserError("invalid_state_dir", "state directory is inside a git working tree");
    if (path.dirname(cur) === cur) break;
  }
  return root;
}

function ensureDir(dir, root) {
  const rel = path.relative(root, dir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let cur = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    if (!fs.existsSync(cur)) fs.mkdirSync(cur, { mode: 0o700 });
    fs.chmodSync(cur, 0o700);
  }
}

/** Write atomically (temp file created 0600, then renamed over the target). */
function writeOwnerOnly(file, root, data) {
  ensureDir(path.dirname(file), root);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function target(ref, baseDir, forbiddenRoots) {
  const root = assertOutsideTrees(baseDir, forbiddenRoots);
  return { root, file: resolveStorageRef(ref, { baseDir: root }) };
}

/** Persist a storageState object for the scope. Returns its `storage_ref`. */
export async function saveStorageState(scope, state, { baseDir = defaultStateDir(), forbiddenRoots = [] } = {}) {
  const ref = `storage_state:${[...scopeSegs(scope), STATE_FILE].join("/")}`;
  const { root, file } = target(ref, baseDir, forbiddenRoots);
  writeOwnerOnly(file, root, JSON.stringify(state));
  return ref;
}

function stateFile(scope, baseDir) {
  return resolveStorageRef(`storage_state:${[...scopeSegs(scope), STATE_FILE].join("/")}`, { baseDir });
}

/** Whether a saved state exists for the scope. Never reads its content. */
export function hasSavedState(scope, { baseDir = defaultStateDir() } = {}) {
  try {
    return fs.statSync(stateFile(scope, baseDir)).isFile();
  } catch (err) {
    if (err instanceof BrowserError) throw err;
    return false;
  }
}

/**
 * The saved storageState object. Cookie values are registered for redaction.
 * Throws `state_missing` (REQ-006, spec § 9) when none exists.
 */
export function loadStorageState(scope, { baseDir = defaultStateDir() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(stateFile(scope, baseDir), "utf8");
  } catch (err) {
    if (err instanceof BrowserError) throw err;
    throw new BrowserError("state_missing", "no saved state for this profile; run `waycontext browser-login` or a fresh_login that saves state");
  }
  const state = JSON.parse(raw);
  for (const c of state.cookies ?? []) registerSensitive(c?.value);
  return state;
}

/** Remove the scope's saved state. Returns whether a file was removed. */
export function deleteSavedState(scope, { baseDir = defaultStateDir() } = {}) {
  const file = stateFile(scope, baseDir);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/** Store an evidence file (P5 screenshot bytes). Returns a `screenshot:` ref. */
export async function writeEvidenceFile(scope, sessionId, name, data, { baseDir = defaultStateDir(), forbiddenRoots = [] } = {}) {
  const parts = [...scopeSegs(scope), "evidence", plainName(sessionId, "session id"), plainName(name, "file name")];
  const ref = `screenshot:${parts.join("/")}`;
  const { root, file } = target(ref, baseDir, forbiddenRoots);
  writeOwnerOnly(file, root, data);
  return ref;
}

/** Insert a browser_session_artifacts row: a type and a ref, never content. */
export async function recordArtifact({ sessionId, artifactType, storageRef }, db = pool) {
  if (!ARTIFACT_TYPES.includes(artifactType)) throw badRef(`invalid artifact_type`);
  if (parseRef(storageRef).kind !== artifactType) throw badRef("storage_ref does not match artifact_type");
  const res = await db.query(
    `INSERT INTO browser_session_artifacts (session_id, artifact_type, storage_ref)
     VALUES ($1, $2, $3) RETURNING id, session_id, artifact_type, storage_ref, created_at`,
    [sessionId, artifactType, storageRef],
  );
  return res.rows[0];
}

export async function listArtifacts(sessionId, db = pool) {
  const res = await db.query(
    `SELECT id, session_id, artifact_type, storage_ref, created_at
       FROM browser_session_artifacts WHERE session_id = $1 ORDER BY id`,
    [sessionId],
  );
  return res.rows;
}
