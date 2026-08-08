/**
 * The server-level `instructions` string sent in the MCP `initialize` response.
 *
 * This is the only channel that reaches every client identically. Claude Code,
 * Copilot and Cursor all inject it into the agent's system prompt at connect
 * time, so unlike `waycontext init` (one repo, one file, one client) and unlike
 * the PreToolUse hook (Claude Code only, opt-in), it needs no per-repo setup
 * and no client-specific plumbing to work. Before this existed, an agent's only
 * hint that these tools were worth reaching for was 24 individual tool
 * descriptions -- which is why agents kept falling back to grep.
 *
 * Two halves:
 *
 *   static   the workflow, and the honest statement of when NOT to use these
 *            tools. Without the second part the guidance reads as marketing and
 *            an agent that follows it wastes calls searching for a YAML key.
 *   dynamic  the indexed project list. Every tool takes a required `project`
 *            argument, so without this an agent must spend a `list_projects`
 *            round-trip before its first real query -- and a tool that costs
 *            two calls loses to a grep that costs one.
 *
 * The project list comes from the projects.json cache rather than the database
 * for the same reason hooks/codectx-primary-search.sh reads it: this runs on
 * the startup path of every client connection, and neither a slow query nor an
 * unreachable database may delay or break a handshake. A stale list is fine --
 * being one project behind costs the agent one `list_projects` call, whereas a
 * failed handshake costs it every tool.
 */
import path from "node:path";

import { readProjectCache } from "./projectCache.js";

/**
 * Every project whose root contains `cwd`, deepest first, keeping ties.
 *
 * projectForCwd() answers the hook's question ("which one project?") and breaks
 * a tie arbitrarily, which is fine when the answer only picks the wording of an
 * advisory note. Here it would put a specific project name in the agent's
 * system prompt as "almost certainly the one to pass" -- and two names for one
 * root is common in practice, since an abandoned trial index of a repo stays in
 * the cache alongside the real one. Naming both is honest; guessing is not.
 */
function matchesForCwd(cwd, projects) {
  const matched = projects
    .filter((p) => p.root_path)
    .map((p) => ({ ...p, root_path: p.root_path.replace(/[/\\]$/, "") }))
    .filter((p) => cwd === p.root_path || cwd.startsWith(p.root_path + path.sep));
  if (!matched.length) return [];

  const deepest = Math.max(...matched.map((p) => p.root_path.length));
  return matched
    .filter((p) => p.root_path.length === deepest)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const WORKFLOW = `WayContext indexes whole codebases into a symbol graph (calls, imports, inheritance, WordPress hooks), full-text and vector embeddings, plus git history, docs and confirmed rules.

For questions about code in an indexed project -- where something is defined, what it does, who calls it, what a change would break -- use these tools BEFORE grep/glob/file-listing or dispatching a search subagent. They match on meaning and on real graph edges, so they find code whose names share no words with the query, and they answer "what else does this touch?" which a text search cannot.

Typical sequence:
1. project_overview -- orient in an unfamiliar codebase
2. search_code -- describe the behaviour you are looking for, in plain language
3. get_callers / get_graph -- blast radius before you change anything
4. get_symbol -- read the actual source (get_file_outline for a whole file)

Other entry points: compose_context assembles rules + code + docs + past fixes for a task in one call, and is the better opening move when starting real work rather than answering a lookup. search_knowledge covers "why is it this way" (ADRs, guides). get_history and who_owns answer what changed here before and who to ask.

Do NOT reach for these tools for content that is not indexed: config files, lockfiles, logs, test output, build artifacts, or languages outside JavaScript/TypeScript/JSX/TSX/PHP/Python/Go. Grep is the right tool there, and for exact-string questions ("where is this literal?") it is the right tool even in an indexed project. Results are only as fresh as the last index_project run.`;

/**
 * Render the indexed-project list, marking the one containing `cwd`.
 *
 * The server inherits the client's working directory, so in the common case
 * (an editor or CLI opened at a repo root) this resolves the exact project name
 * the agent needs and it never has to guess or ask.
 */
function projectSection(projects, cwd) {
  if (!projects.length) {
    return `No projects are indexed yet on this machine. Run \`index_project <name> <absolute-path>\` (or the \`waycontext index_project\` CLI) before the other tools will return anything.`;
  }

  const matches = matchesForCwd(cwd, projects);
  const lines = projects
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `- ${p.name} -- ${p.root_path}`);

  const header = `Indexed projects on this machine (pass one of these names as the \`project\` argument):`;

  let footer;
  if (matches.length === 1) {
    footer = `The current working directory is inside "${matches[0].name}", so that is almost certainly the project to pass. If a file you are asked about lies outside ${matches[0].root_path}, match it against the roots above instead.`;
  } else if (matches.length > 1) {
    const names = matches.map((p) => `"${p.name}"`).join(", ");
    footer = `The current working directory matches more than one indexed project (${names}) — they share the root ${matches[0].root_path}. Ask which one to use rather than guessing; one is likely a stale index that should be removed with \`delete_project\`.`;
  } else {
    footer = `The current working directory is not inside any indexed root, so match the file you are working on against the roots above. If none match, that project is not indexed and grep is the correct fallback -- or offer to run index_project.`;
  }

  return `${header}\n${lines.join("\n")}\n\n${footer}`;
}

/**
 * Build the full instructions string.
 *
 * Never throws: a corrupt cache degrades to the static half (readProjectCache
 * already swallows parse errors and returns an empty list), and anything
 * unexpected past that still returns usable guidance rather than failing the
 * handshake.
 */
export function buildInstructions({ cwd = process.cwd(), cacheFile } = {}) {
  let projects = [];
  try {
    projects = readProjectCache(...(cacheFile ? [cacheFile] : [])).projects;
  } catch {
    // Unreachable via readProjectCache's own try/catch, but this function is on
    // the handshake path -- it does not get to be the reason a client fails to
    // connect.
  }
  return `${WORKFLOW}\n\n${projectSection(projects, cwd)}`;
}
