// Stops only at a `#`/`##` heading or EOF — a `###`+ subheading placed
// directly under this section is treated as part of its body and is
// replaced/lost on update.
// Matches both the current "## WayContext" heading and the "## Code Context
// MCP" one earlier versions wrote, so upserting migrates an existing section
// in place instead of appending a second, contradictory one.
const SECTION_RE = /## (?:WayContext|Code Context MCP)\n[\s\S]*?(?=\n#{1,2} |\n*$)/;
const NAME_RE = /\*\*`([^`]+)`\*\*/;
const PATH_RE = /(?:project root|indexed directory), relative to this file, is \*\*`([^`]+)`\*\*/;

// The section is deliberately directive rather than descriptive. Earlier
// versions only announced the project name, which left an agent with no reason
// to prefer these tools over its built-in search -- and agents overwhelmingly
// did not. The counterweight (what grep is still right for) is not politeness:
// without it an agent follows the instruction too far and burns calls searching
// a symbol index for a YAML key.
//
// This is scoped to one repo and only written by an explicit `waycontext init`,
// unlike the global ~/.claude/CLAUDE.md rewrite older versions did unattended --
// see docs/installation.md on why that was walked back.
export function buildSection(name, rootPath) {
  const pathSentence = rootPath
    ? `Its indexed directory, relative to this file, is **\`${rootPath}\`** — resolve ` +
      `that against this file's own directory to get an absolute path, then pass it as ` +
      `the \`path\` argument to \`index_project\` when no path is otherwise known (an ` +
      `MCP tool call has no working directory of its own). This can be a subdirectory ` +
      `of the repo's actual root, i.e. where \`.git\` lives — don't confuse the two. `
    : "";
  return (
    `## WayContext\n\n` +
    `This repo is indexed by the \`waycontext\` MCP server as project\n` +
    `**\`${name}\`** — pass that as the \`project\` argument. ${pathSentence}For questions about\n` +
    `code in this repo, use these tools BEFORE \`Grep\`/\`Glob\` or dispatching a\n` +
    `search subagent:\n\n` +
    `1. \`project_overview\` → orient in unfamiliar areas\n` +
    `2. \`search_code\` with the task description → candidate symbols\n` +
    `3. \`get_callers\` / \`get_graph\` on the target → blast radius\n` +
    `4. \`get_symbol\` → read the source (\`get_file_outline\` for a whole file)\n\n` +
    `\`compose_context\` is the better opening move when starting real work: it\n` +
    `fuses rules, code, docs and past fixes for a task in one call.\n\n` +
    `\`Grep\`/\`Glob\` stay correct for what isn't indexed — config, lockfiles, logs,\n` +
    `test output — and for exact-string lookups. Re-run \`index_project\` after\n` +
    `committing so the graph doesn't go stale.\n\n` +
    `### Reasoning graphs before a spec or plan review\n\n` +
    `Before presenting a specification or implementation plan for review, in addition to\n` +
    `any required plan text, render it as a visual reasoning graph: call\n` +
    `\`create_reasoning_graph\` for a new feature or \`update_reasoning_graph\` for an\n` +
    `existing one, using \`search_code\`, \`get_graph\` and \`get_modules\` to fill in\n` +
    `\`affected_files\` and risk. Tell the developer the path to the generated\n` +
    `\`waycontext-review.html\` under \`docs/waycontext/<slug>/\` instead of asking them to read the\n` +
    `plan as markdown. There is no tool to auto-open a browser or IDE panel, and\n` +
    `neither reasoning-graph call does so on its own -- open the returned\n` +
    `\`review_url\` yourself, or open the file once via VS Code's Simple Browser\n` +
    `(Command Palette -> "Simple Browser: Show") or a live-preview extension --\n` +
    `refreshing after each update shows the latest state.`
  );
}

export function extractExistingName(content) {
  const match = content.match(SECTION_RE);
  if (!match) return null;
  const nameMatch = match[0].match(NAME_RE);
  return nameMatch ? nameMatch[1] : null;
}

export function extractExistingPath(content) {
  const match = content.match(SECTION_RE);
  if (!match) return null;
  const pathMatch = match[0].match(PATH_RE);
  return pathMatch ? pathMatch[1] : null;
}

export function upsertSection(content, name, rootPath) {
  const section = buildSection(name, rootPath);
  if (!content.trim()) {
    return { content: `# Project Notes\n\n${section}\n`, mode: "created" };
  }
  if (SECTION_RE.test(content)) {
    // How many newlines the match swallows depends on what follows the
    // section: at EOF the lookahead consumes none, before another heading it
    // consumes the blank line. Re-emitting exactly what was matched keeps both
    // shapes intact. Appending a fixed "\n" instead -- as this used to -- grew
    // the file by one newline on every re-run, which only became visible once
    // init started rewriting several files and had to report "already up to
    // date" honestly.
    const replaced = content.replace(SECTION_RE, (match) => section + match.match(/\n*$/)[0]);
    return {
      content: replaced.endsWith("\n") ? replaced : `${replaced}\n`,
      mode: "updated",
    };
  }
  const sep = content.endsWith("\n") ? "\n" : "\n\n";
  return {
    content: `${content}${sep}# Project Notes\n\n${section}\n`,
    mode: "appended",
  };
}

// Global (user-level ~/.claude/CLAUDE.md) counterpart.
//
// The builder is gone: nothing wrote it any more once install.sh stopped
// rewriting ~/.claude/CLAUDE.md unattended, and the workflow it described now
// lives in the MCP server's `instructions` (src/mcpInstructions.js), which
// reaches every client rather than only Claude Code. Two copies of that text
// would drift, and the stale one would be the one users read.
//
// The regex and the remover stay: machines set up by older versions still have
// the section, and `waycontext uninstall` has to be able to take it back out.
const GLOBAL_SECTION_RE = /## (?:WayContext Workflow|Code Context MCP Workflow)\n[\s\S]*?(?=\n#{1,2} |\n*$)/;

/**
 * Strip the global section, leaving the rest of the file untouched.
 */
export function removeGlobalSection(content) {
  if (!GLOBAL_SECTION_RE.test(content)) return content;
  return content.replace(GLOBAL_SECTION_RE, "").replace(/\n{3,}/g, "\n\n").trimStart();
}
