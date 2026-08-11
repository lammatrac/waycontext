/**
 * Which files `waycontext init` writes, and the pure transforms for each.
 *
 * `init` used to write only ./CLAUDE.md, which meant everything it said was
 * invisible to Copilot and Cursor -- the two clients most likely to fall back
 * to their own search. The section body is identical across the markdown
 * targets (they are all just markdown an agent reads at session start), so the
 * only thing that varies is the path and which client honours it.
 *
 * Kept separate from src/cli.js so the decisions here -- what to write, when to
 * skip -- are testable without a readline prompt or a real filesystem.
 */
import fs from "node:fs";
import path from "node:path";

import { upsertSection } from "./claudeMdInit.js";

/**
 * `dependsOnDir` means: only write this file if that directory already exists.
 *
 * Creating a .github/ in a repo that has none is a bigger imposition than
 * dropping a markdown file at the root -- it is a directory with meaning to
 * GitHub, and a user who has deliberately not got one will not thank us. So it
 * is written when the repo already uses .github/, and offered behind a flag
 * otherwise. Same reasoning as the hook being opt-in.
 */
export const MARKDOWN_TARGETS = [
  { path: "CLAUDE.md", readBy: "Claude Code" },
  { path: "AGENTS.md", readBy: "Copilot, Cursor, Codex, Gemini CLI, Amp" },
  { path: path.join(".github", "copilot-instructions.md"), readBy: "GitHub Copilot", dependsOnDir: ".github" },
];

export const VSCODE_MCP_PATH = path.join(".vscode", "mcp.json");

/** Targets to write in `cwd`, honouring dependsOnDir unless `all` forces them. */
export function selectTargets(cwd, { all = false } = {}) {
  return MARKDOWN_TARGETS.filter(
    (t) => all || !t.dependsOnDir || fs.existsSync(path.join(cwd, t.dependsOnDir))
  );
}

/** Targets skipped only because their directory is missing — worth telling the user about. */
export function skippedTargets(cwd) {
  return MARKDOWN_TARGETS.filter(
    (t) => t.dependsOnDir && !fs.existsSync(path.join(cwd, t.dependsOnDir))
  );
}

/**
 * Merge our server into a VS Code mcp.json, preserving everything else.
 *
 * Registering the server is the step with no substitute: instructions and
 * agent-file text are both worthless to Copilot if the server was never
 * connected, and that failure is indistinguishable from "the agent ignored it".
 * install.sh only runs `claude mcp add`, so nothing in the setup path has ever
 * registered WayContext with Copilot.
 *
 * Returns `mode: "unchanged"` when an entry for this server is already present
 * and correct, so a re-run is a no-op rather than a reformatted file.
 */
export function mergeVscodeMcp(existingJson, mcpName = "waycontext") {
  let parsed = {};
  if (existingJson && existingJson.trim()) {
    try {
      parsed = JSON.parse(existingJson);
    } catch {
      // A hand-written mcp.json with a trailing comma or a comment (both of
      // which VS Code tolerates) must not be silently rewritten -- we would
      // destroy whatever else is registered in it.
      return { content: existingJson, mode: "unparseable" };
    }
  }

  const next = { ...parsed, servers: { ...(parsed.servers ?? {}) } };
  const desired = { command: "waycontext-mcp" };
  const current = next.servers[mcpName];

  if (current && current.command === desired.command) {
    return { content: existingJson, mode: "unchanged" };
  }

  const mode = current ? "updated" : Object.keys(parsed).length ? "appended" : "created";
  next.servers[mcpName] = { ...current, ...desired };
  return { content: JSON.stringify(next, null, 2) + "\n", mode };
}

/** Read a target, upsert the section, and report what changed. Pure except the read. */
export function planMarkdownWrite(cwd, target, name, rootPath) {
  const abs = path.join(cwd, target.path);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const { content, mode } = upsertSection(existing, name, rootPath);
  return { abs, existing, content, mode, changed: content !== existing };
}
