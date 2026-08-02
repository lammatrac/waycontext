/**
 * A small JSON cache of indexed projects, read by the PreToolUse hook.
 *
 * The hook used to shell out to `psql` on every Bash command containing the
 * substring "grep", putting a database round-trip on the agent's hottest
 * path and making the hook fail toward blocking when the DB was unreachable.
 * It now reads this file instead: no psql, no .env parsing, no DB dependency.
 *
 * Config (mcpName, mode) and data (projects) live in the same file but are
 * written by different commands, so every write merges rather than replaces.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CACHE_VERSION = 1;
export const HOOK_MODES = ["advise", "ask", "deny"];
export const DEFAULT_MODE = "advise";
export const DEFAULT_MCP_NAME = "waycontext";

export function cacheDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "waycontext");
}

export function cachePath() {
  return path.join(cacheDir(), "projects.json");
}

/** Read the cache, or a default shell if it's missing or unparseable. */
export function readProjectCache(file = cachePath()) {
  const fallback = {
    version: CACHE_VERSION,
    mcpName: DEFAULT_MCP_NAME,
    mode: DEFAULT_MODE,
    projects: [],
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: CACHE_VERSION,
      mcpName: parsed.mcpName || DEFAULT_MCP_NAME,
      mode: HOOK_MODES.includes(parsed.mode) ? parsed.mode : DEFAULT_MODE,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return fallback;
  }
}

/**
 * Merge `patch` into the cache and write it atomically.
 * @param {{mcpName?: string, mode?: string, projects?: Array<{name: string, root_path: string}>}} patch
 */
export function writeProjectCache(patch, file = cachePath()) {
  const current = readProjectCache(file);
  const next = {
    version: CACHE_VERSION,
    mcpName: patch.mcpName ?? current.mcpName,
    mode: patch.mode ?? current.mode,
    projects: (patch.projects ?? current.projects).map((p) => ({
      name: p.name,
      root_path: p.root_path,
    })),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return next;
}

/**
 * The deepest indexed project containing `cwd`, or null.
 *
 * Deepest wins so that a project nested inside another indexed root resolves
 * to the inner one rather than whichever happened to be listed first.
 */
export function projectForCwd(cwd, projects) {
  let best = null;
  for (const project of projects) {
    const root = project.root_path;
    if (!root) continue;
    const normalized = root.endsWith(path.sep) ? root.slice(0, -1) : root;
    if (cwd === normalized || cwd.startsWith(normalized + path.sep)) {
      if (!best || normalized.length > best.root_path.length) {
        best = { ...project, root_path: normalized };
      }
    }
  }
  return best;
}
