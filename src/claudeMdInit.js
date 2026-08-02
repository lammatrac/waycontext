// Stops only at a `#`/`##` heading or EOF — a `###`+ subheading placed
// directly under this section is treated as part of its body and is
// replaced/lost on update.
// Matches both the current "## WayContext" heading and the "## Code Context
// MCP" one earlier versions wrote, so upserting migrates an existing section
// in place instead of appending a second, contradictory one.
const SECTION_RE = /## (?:WayContext|Code Context MCP)\n[\s\S]*?(?=\n#{1,2} |\n*$)/;
const NAME_RE = /\*\*`([^`]+)`\*\*/;

export function buildSection(name) {
  return (
    `## WayContext\n\n` +
    `This project is indexed by the \`waycontext\` MCP server under the project\n` +
    `name **\`${name}\`**. When using \`waycontext\` tools\n` +
    `(\`project_overview\`, \`search_code\`, \`get_graph\`, \`get_callers\`, \`get_symbol\`,\n` +
    `\`index_project\`, etc.) for this repo, use/target project \`${name}\`.`
  );
}

export function extractExistingName(content) {
  const match = content.match(SECTION_RE);
  if (!match) return null;
  const nameMatch = match[0].match(NAME_RE);
  return nameMatch ? nameMatch[1] : null;
}

export function upsertSection(content, name) {
  const section = buildSection(name);
  if (!content.trim()) {
    return { content: `# Project Notes\n\n${section}\n`, mode: "created" };
  }
  if (SECTION_RE.test(content)) {
    return { content: content.replace(SECTION_RE, section + "\n"), mode: "updated" };
  }
  const sep = content.endsWith("\n") ? "\n" : "\n\n";
  return {
    content: `${content}${sep}# Project Notes\n\n${section}\n`,
    mode: "appended",
  };
}

// Global (user-level ~/.claude/CLAUDE.md) counterpart: unlike the per-project
// section above, this one takes no project name, so the same fixed block
// applies to every project once the server is registered at user scope.
//
// No longer written by install.sh -- kept so `waycontext uninstall` can remove
// what older versions left behind, and for anyone who wants it deliberately.
const GLOBAL_SECTION_RE = /## (?:WayContext Workflow|Code Context MCP Workflow)\n[\s\S]*?(?=\n#{1,2} |\n*$)/;

export function buildGlobalSection() {
  return (
    `## WayContext Workflow\n\n` +
    `\`waycontext\` is a globally-registered MCP server (registered via\n` +
    `\`claude mcp add --scope user waycontext -- node /path/to/waycontext/src/server.js\`,\n` +
    `see \`install.sh\`) — it is available in every project's session, not just\n` +
    `this one. When the current repo is indexed, prefer it over \`Grep\`/\`Glob\`/an\n` +
    `\`Explore\` agent for code questions: it searches semantically and by call\n` +
    `graph rather than by string match.\n` +
    `To find the right project name for the current repo, check the project's\n` +
    `own \`CLAUDE.md\` first (it should document the indexed project name — see\n` +
    `\`waycontext init\`), otherwise call \`list_projects\` and match by root\n` +
    `path (or \`index_project\` with a new name if none exists):\n\n` +
    `1. \`project_overview\` → orient\n` +
    `2. \`search_code\` with the task description → candidate symbols\n` +
    `3. \`get_graph\` / \`get_callers\` on the target → impact analysis\n` +
    `4. \`get_symbol\` → read actual source (or \`get_file_outline\` for a whole file)\n\n` +
    `\`Grep\`/\`Glob\` remain the right tools for non-indexed content — docs,\n` +
    `config, logs, test output, and file types the parser doesn't cover.`
  );
}

export function upsertGlobalSection(content) {
  const section = buildGlobalSection();
  if (!content.trim()) {
    return { content: `${section}\n`, mode: "created" };
  }
  const match = content.match(GLOBAL_SECTION_RE);
  if (match) {
    if (match[0] === section) return { content, mode: "unchanged" };
    return { content: content.replace(GLOBAL_SECTION_RE, section + "\n"), mode: "updated" };
  }
  const sep = content.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${content}${sep}${section}\n`, mode: "appended" };
}

/**
 * Strip the global section, leaving the rest of the file untouched.
 *
 * Earlier versions wrote this section into ~/.claude/CLAUDE.md unattended from
 * install.sh, so `codecontext uninstall` needs to be able to take it back out
 * of machines that were set up that way.
 */
export function removeGlobalSection(content) {
  if (!GLOBAL_SECTION_RE.test(content)) return content;
  return content.replace(GLOBAL_SECTION_RE, "").replace(/\n{3,}/g, "\n\n").trimStart();
}
