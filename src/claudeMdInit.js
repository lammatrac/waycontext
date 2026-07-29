// Stops only at a `#`/`##` heading or EOF — a `###`+ subheading placed
// directly under this section is treated as part of its body and is
// replaced/lost on update.
const SECTION_RE = /## Code Context MCP\n[\s\S]*?(?=\n#{1,2} |\n*$)/;
const NAME_RE = /\*\*`([^`]+)`\*\*/;

export function buildSection(name) {
  return (
    `## Code Context MCP\n\n` +
    `This project is indexed by the \`code-context\` MCP server under the project\n` +
    `name **\`${name}\`**. When using \`code-context\` tools\n` +
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
// section above, this one takes no project name — the MCP server always
// exposes its tools under the fixed name "code-context" regardless of what
// alias `claude mcp add --scope user <alias>` registered it under, so the
// same fixed block applies to every project once the server is registered
// at user scope.
const GLOBAL_SECTION_RE = /## Code Context MCP Workflow\n[\s\S]*?(?=\n#{1,2} |\n*$)/;

export function buildGlobalSection() {
  return (
    `## Code Context MCP Workflow\n\n` +
    `\`code-context\` is a globally-registered MCP server (registered via\n` +
    `\`claude mcp add --scope user <name> -- node /path/to/code-context-mcp/src/server.js\`,\n` +
    `see \`install.sh\`) — it is available in every project's session, not just\n` +
    `this one. Whenever it's available, it is the **mandatory, primary way to\n` +
    `find code for a task** — not an optional aid. This overrides the default\n` +
    `instinct to \`Grep\`/\`Glob\`/dispatch an \`Explore\` agent to scan the repo.\n` +
    `To find the right project name for the current repo, check the project's\n` +
    `own \`CLAUDE.md\` first (it should document the indexed project name — see\n` +
    `\`codecontext init\`), otherwise call \`list_projects\` and match by root\n` +
    `path (or \`index_project\` with a new name if none exists):\n\n` +
    `1. \`project_overview\` → orient\n` +
    `2. \`search_code\` with the task description → candidate symbols\n` +
    `3. \`get_graph\` / \`get_callers\` on the target → impact analysis\n` +
    `4. \`get_symbol\` → read actual source (or \`get_file_outline\` for a whole file)\n\n` +
    `Only fall back to \`Grep\`/\`Glob\`/\`Explore\` when \`search_code\`/\`get_graph\`\n` +
    `genuinely can't answer the question (e.g. searching non-indexed file types,\n` +
    `config files, or docs) — and say so before doing it.`
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
