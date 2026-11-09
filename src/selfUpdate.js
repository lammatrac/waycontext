/**
 * `waycontext update`: work out how this copy was installed, check whether a
 * newer one exists, and upgrade it the way that kind of install upgrades.
 *
 * There are two supported install kinds and they upgrade differently:
 *   - git: a clone set up by install.sh. update.sh pulls and re-runs
 *     install.sh, which refreshes deps, schema, the CLI link and the service.
 *   - npm: `npm install -g waycontext`. Reinstall at the registry's latest,
 *     then migrate; the package's postinstall restarts the service.
 * Both work the same on Linux and macOS. The one platform difference that
 * matters is who owns npm's global prefix (see npmGlobalWritable).
 *
 * Every external command goes through an injected `run`, so the decisions are
 * tested without git, npm or a network.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NAME, VERSION } from "./version.js";

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Run a command to completion: { status, stdout, stderr }, trimmed. */
export function defaultRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return {
    status: r.error ? null : r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || r.error?.message || "").trim(),
  };
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** -1, 0 or 1. Numeric per dotted part; a leading "v" and any -pre/+build suffix are ignored. */
export function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/, "").split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * "git" only when the package root is the top of its own work tree. A copy
 * that merely sits inside another repo (an app's node_modules, say) must never
 * be "updated" by pulling that unrelated repo.
 */
export function detectInstall({ root = PKG_ROOT, run = defaultRun, name = NAME } = {}) {
  const top = run("git", ["-C", root, "rev-parse", "--show-toplevel"]);
  if (top.status === 0 && realpath(top.stdout) === realpath(root)) return { kind: "git", root };

  const globalRoot = run("npm", ["root", "-g"]);
  if (globalRoot.status === 0 && globalRoot.stdout
      && realpath(root) === realpath(path.join(globalRoot.stdout, name))) {
    return { kind: "npm", root };
  }
  return { kind: "unknown", root };
}

function checkGit(root, run, current) {
  const git = (...a) => run("git", ["-C", root, ...a]);
  const base = { kind: "git", root, current };

  const upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (upstream.status !== 0) {
    return { ...base, error: `the branch in ${root} has no upstream tracking branch; set one with: git -C ${root} branch -u origin/main` };
  }
  const fetch = git("fetch", "--quiet");
  if (fetch.status !== 0) {
    return { ...base, error: `git fetch failed: ${fetch.stderr || "unknown error"} (offline?)` };
  }

  const behind = parseInt(git("rev-list", "--count", "HEAD..@{u}").stdout, 10) || 0;
  let latest = current;
  try {
    latest = JSON.parse(git("show", "@{u}:package.json").stdout).version || current;
  } catch {
    // Upstream package.json unreadable: the commit count still answers the question.
  }
  const dirty = git("status", "--porcelain").stdout !== "";
  const commits = behind
    ? git("log", "--oneline", "HEAD..@{u}").stdout.split("\n").filter(Boolean)
    : [];
  return { ...base, latest, behind, upstream: upstream.stdout, dirty, commits, available: behind > 0 };
}

function checkNpm(root, run, current, name) {
  const base = { kind: "npm", root, current };
  const view = run("npm", ["view", name, "version"]);
  if (view.status !== 0 || !view.stdout) {
    return { ...base, error: `could not read the latest version from the npm registry: ${view.stderr || "no output"}` };
  }
  const latest = view.stdout.split("\n").pop().trim();
  return { ...base, latest, available: compareVersions(latest, current) > 0 };
}

/** What is installed, what is available, and whether there is anything to do. */
export function checkForUpdate(install, { run = defaultRun, current = VERSION, name = NAME } = {}) {
  if (install.kind === "git") return checkGit(install.root, run, current);
  if (install.kind === "npm") return checkNpm(install.root, run, current, name);
  return {
    kind: "unknown", root: install.root, current,
    error: `${install.root} is neither a git clone nor a global npm install; update it with whatever installed it`,
  };
}

/**
 * Whether `npm install -g` can write without sudo. With Node from apt (Ubuntu,
 * Debian) the global root is /usr/lib/node_modules, owned by root; Homebrew,
 * nvm and fnm prefixes are owned by the user.
 */
export function npmGlobalWritable({ run = defaultRun } = {}) {
  const r = run("npm", ["root", "-g"]);
  if (r.status !== 0 || !r.stdout) return false;
  try {
    fs.accessSync(r.stdout, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commands that perform the update, or `blocked` with what to do instead.
 * A step marked `optional` warns on failure rather than failing the update.
 */
export function updatePlan(check, {
  platform = process.platform, npmWritable = true, nodePath = process.execPath, name = NAME,
} = {}) {
  if (check.error) return { blocked: check.error };
  if (!check.available) return { steps: [] };

  if (check.kind === "git") {
    if (platform === "win32") {
      return { blocked: `update.sh needs bash; run it from Git Bash or WSL: ${path.join(check.root, "update.sh")}` };
    }
    // update.sh refuses too, but only after the user has watched it start.
    if (check.dirty) {
      return { blocked: `${check.root} has uncommitted changes; commit or stash them, then run: waycontext update` };
    }
    return { steps: [{ label: "Pulling and re-running install.sh", cmd: "bash", args: [path.join(check.root, "update.sh")], cwd: check.root }] };
  }

  // Pin the version the check reported, so what installs is what was announced.
  const spec = `${name}@${check.latest}`;
  if (!npmWritable) {
    return {
      blocked: `npm's global folder is not writable by you (Node installed from apt?). Run:\n`
        + `  sudo npm install -g ${spec} && waycontext migrate`,
    };
  }
  return {
    steps: [
      { label: `Installing ${spec}`, cmd: "npm", args: ["install", "-g", spec] },
      // Run the freshly installed files, not this process's already-loaded copy.
      { label: "Applying database migrations", cmd: nodePath, args: [path.join(check.root, "src", "cli.js"), "migrate"], optional: true },
    ],
  };
}

const KIND_LABEL = { git: "git clone", npm: "global npm install", unknown: "unrecognised install" };

/** Human-readable lines for a check result. */
export function describeCheck(check, { name = NAME } = {}) {
  const where = `${KIND_LABEL[check.kind]}${check.kind === "git" ? ` at ${check.root}` : ""}`;
  if (check.error) return [`${name} ${check.current} (${where})`, `Could not check for updates: ${check.error}`];
  if (!check.available) return [`${name} ${check.current} is up to date (${where})`];

  if (check.kind === "npm") return [`${name} ${check.current} -> ${check.latest} available on npm (${where})`];

  const versions = compareVersions(check.latest, check.current) > 0
    ? `${check.current} -> ${check.latest}`
    : `still ${check.current}`;
  const lines = [`${name} ${versions}: ${check.behind} new commit(s) on ${check.upstream} (${where})`];
  const shown = check.commits.slice(0, 10);
  for (const c of shown) lines.push(`  ${c}`);
  if (check.commits.length > shown.length) lines.push(`  ... and ${check.commits.length - shown.length} more`);
  return lines;
}
