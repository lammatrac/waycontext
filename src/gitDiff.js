import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function tryGit(args) {
  try {
    const { stdout } = await execFileAsync("git", args);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Current HEAD commit SHA for the repo containing `root`, or null if `root`
 * isn't inside a git repo (or the repo has no commits yet).
 */
export async function getHeadSha(root) {
  return tryGit(["-C", root, "rev-parse", "HEAD"]);
}

/**
 * @param {string} root absolute path previously indexed (may be a
 *   subdirectory of the actual git repo root).
 * @param {string|null} lastSha the project's stored last_indexed_sha.
 * @returns {Promise<{changed: string[], deleted: string[], headSha: string} | null>}
 *   null means "caller should fall back to a full scan": lastSha wasn't
 *   provided (first-ever index), root isn't inside a git repo, or lastSha
 *   is no longer an ancestor of HEAD (history was rewritten).
 */
export async function getChangedFiles(root, lastSha) {
  if (!lastSha) return null;

  const toplevel = await tryGit(["-C", root, "rev-parse", "--show-toplevel"]);
  if (!toplevel) return null;

  const headSha = await getHeadSha(root);
  if (!headSha) return null;

  try {
    await execFileAsync("git", ["-C", root, "merge-base", "--is-ancestor", lastSha, "HEAD"]);
  } catch {
    return null;
  }

  const prefixRaw = await tryGit(["-C", root, "rev-parse", "--show-prefix"]);
  const prefix = prefixRaw || ""; // e.g. "sub/project/" when root is a subdir, else ""
  // Only pass a pathspec when there's an actual prefix to scope to: some git
  // versions (e.g. 2.34) treat `-- ""` as a fatal invalid pathspec rather
  // than "match everything", so omit the pathspec entirely at repo root.
  const pathspecArgs = prefix ? ["--", prefix] : [];

  const diffOut = await tryGit([
    "-C", toplevel, "diff", "--no-renames", "--name-status", lastSha, ...pathspecArgs,
  ]);
  const untrackedOut = await tryGit([
    "-C", toplevel, "ls-files", "--others", "--exclude-standard", ...pathspecArgs,
  ]);

  const changed = [];
  const deleted = [];
  for (const line of (diffOut || "").split("\n").filter(Boolean)) {
    const [status, rawPath] = line.split("\t");
    const relPath = rawPath.slice(prefix.length);
    if (status === "D") deleted.push(relPath);
    else changed.push(relPath); // A or M ("--no-renames" guarantees no R/C status)
  }
  for (const rawPath of (untrackedOut || "").split("\n").filter(Boolean)) {
    changed.push(rawPath.slice(prefix.length));
  }

  return { changed, deleted, headSha };
}

/**
 * Paths changed in the working tree relative to HEAD, including untracked
 * files, relative to `root`.
 *
 * `review_context` asks "what am I about to commit", and a file that exists only
 * in the working tree is the most likely thing a reviewer wants the rules for --
 * so untracked files are included even though nothing in the index knows about
 * them yet. Returns [] for a non-git directory, matching how the rest of this
 * module treats absent git, and strips the repo-subdirectory prefix so the
 * paths line up with `files.path`.
 */
export async function getWorkingTreeChanges(root) {
  const toplevel = await tryGit(["-C", root, "rev-parse", "--show-toplevel"]);
  if (!toplevel) return [];

  const prefix = (await tryGit(["-C", root, "rev-parse", "--show-prefix"])) || "";
  const pathspecArgs = prefix ? ["--", prefix] : [];

  const [tracked, untracked] = await Promise.all([
    tryGit(["-C", toplevel, "diff", "--no-renames", "--name-only", "HEAD", ...pathspecArgs]),
    tryGit(["-C", toplevel, "ls-files", "--others", "--exclude-standard", ...pathspecArgs]),
  ]);

  const paths = `${tracked || ""}\n${untracked || ""}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => p.slice(prefix.length));
  return [...new Set(paths)];
}
