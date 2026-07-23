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
