// Installs a PreToolUse hook into ~/.claude/settings.json that makes the
// code-context MCP the primary search tool: Grep-tool calls and grep/rg/ag
// Bash commands are denied (with a redirect to code-context's search tools)
// whenever the cwd is a project this MCP has indexed, and left alone
// otherwise. See hooks/codectx-primary-search.sh for the enforcement logic.
const MATCHER = "Bash|Grep";
const SCRIPT_BASENAME = "codectx-primary-search.sh";

export function buildHookEntry(scriptPath) {
  return {
    matcher: MATCHER,
    hooks: [{ type: "command", command: scriptPath, timeout: 10 }],
  };
}

function isOurEntry(entry) {
  return (
    entry.matcher === MATCHER &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(
      (h) => h.type === "command" && typeof h.command === "string" && h.command.endsWith(SCRIPT_BASENAME)
    )
  );
}

export function upsertHook(settings, scriptPath) {
  const result = structuredClone(settings ?? {});
  result.hooks ??= {};
  result.hooks.PreToolUse ??= [];

  const preToolUse = result.hooks.PreToolUse;
  const existingIndex = preToolUse.findIndex(isOurEntry);

  if (existingIndex === -1) {
    preToolUse.push(buildHookEntry(scriptPath));
    return { settings: result, mode: preToolUse.length === 1 ? "created" : "appended" };
  }

  const existing = preToolUse[existingIndex];
  const alreadyCorrect =
    existing.matcher === MATCHER &&
    existing.hooks.length === 1 &&
    existing.hooks[0].type === "command" &&
    existing.hooks[0].command === scriptPath &&
    existing.hooks[0].timeout === 10;

  if (alreadyCorrect) {
    return { settings: result, mode: "unchanged" };
  }

  preToolUse[existingIndex] = buildHookEntry(scriptPath);
  return { settings: result, mode: "updated" };
}
