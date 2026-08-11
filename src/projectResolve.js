/**
 * Which project a CLI invocation means when the argument was left out.
 *
 * `waycontext init` already writes the project name into CLAUDE.md, AGENTS.md
 * and .github/copilot-instructions.md, and claudeMdInit.js can parse it back
 * out -- but nothing read it at command time, so every invocation from inside
 * an initialized repo restated a name that was sitting on disk two directories
 * up.
 *
 * Everything here is pure apart from the filesystem reads, because src/cli.js
 * is the one file in this repo with no unit test (see friendlyError.js). The
 * readline prompt and the stderr reporting stay there; the decisions live here.
 */
import fs from "node:fs";
import path from "node:path";

import { MARKDOWN_TARGETS } from "./initTargets.js";
import { extractExistingName, extractExistingPath } from "./claudeMdInit.js";
import { requiredArgs } from "./operations.js";

/**
 * `startDir` and every ancestor up to the git root, inclusive.
 *
 * Climbing matters: running the CLI from src/ or a subpackage is normal.
 * Stopping at .git matters more -- without it the walk escapes into a parent
 * checkout or the user's home directory and resolves a name belonging to a
 * completely different tree.
 */
export function searchDirs(startDir) {
  const dirs = [];
  let dir = path.resolve(startDir);
  for (;;) {
    dirs.push(dir);
    if (fs.existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * The nearest agent-instruction file carrying a WayContext project name.
 *
 * Target order is MARKDOWN_TARGETS' own, so CLAUDE.md wins over AGENTS.md when
 * a repo has drifted between the two. A section whose bolded name has been
 * hand-removed returns null rather than an empty string: the caller must fall
 * through to the prompt, not index a project called "".
 *
 * `root` prefers a path stored in the section by a recent `init` over the
 * marker file's own directory -- the two usually coincide, but a stored path
 * wins when they don't (e.g. a monorepo subpackage). The stored value is
 * relative to the marker file's own directory (CLAUDE.md is committed and
 * cloned onto other machines, so an absolute path baked in there would be
 * wrong the moment anyone else checks the repo out somewhere else) and is
 * resolved against `dir` here to hand callers an absolute path regardless.
 * Older sections written before `init` asked for a path have none, so `root`
 * falls back to the marker's directory exactly as it always has.
 */
export function findProjectMarker(startDir) {
  for (const dir of searchDirs(startDir)) {
    for (const target of MARKDOWN_TARGETS) {
      const abs = path.join(dir, target.path);
      let content;
      try {
        content = fs.readFileSync(abs, "utf8");
      } catch {
        continue; // missing file, or a directory in its place
      }
      const name = extractExistingName(content);
      if (!name) continue;
      const storedPath = extractExistingPath(content);
      return { name, file: abs, root: storedPath ? path.resolve(dir, storedPath) : dir };
    }
  }
  return null;
}

/** argv minus flags. Registry operations take positionals only. */
export function positionals(argv) {
  return argv.filter((a) => !a.startsWith("-"));
}

/** How many required positionals the caller left off. */
function deficitOf(op, argv) {
  return requiredArgs(op).length - positionals(argv).length;
}

/**
 * Does this invocation need a project name resolved before it can run?
 *
 * The CLI checks this before touching the database or opening a prompt, so a
 * fully specified command keeps costing exactly what it costs today.
 */
export function needsProjectName(op, argv) {
  if (op.cli?.args?.[0] !== "project") return false;
  let deficit = deficitOf(op, argv);
  if (deficit > 0 && op.cli?.rootDefault) deficit--;
  return deficit > 0;
}

/**
 * The positional list to hand to parseCliArgs, with omitted arguments filled.
 *
 * Deficits are taken from the right first (the rootDefault slot) and only then
 * from the left (the project name). That ordering is the whole trick: with one
 * argument, `waycontext index my-app` means project "my-app" in this repo --
 * reading it as a *path* called "my-app" is never what anybody meant.
 *
 * `usedProject` / `usedRoot` report which defaults actually fired, so the CLI
 * announces only what it decided rather than narrating arguments the user typed.
 */
export function fillArgs(op, argv, { name, root }) {
  const next = positionals(argv);
  let deficit = deficitOf(op, argv);
  let usedProject = false;
  let usedRoot = false;

  if (deficit > 0 && op.cli?.rootDefault) {
    next.push(root);
    usedRoot = true;
    deficit--;
  }
  if (deficit > 0 && op.cli?.args?.[0] === "project") {
    next.unshift(name);
    usedProject = true;
    deficit--;
  }
  return { argv: next, usedProject, usedRoot };
}
