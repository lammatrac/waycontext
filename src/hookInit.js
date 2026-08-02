// Pure helpers for adding/removing the PreToolUse hook entry in a Claude Code
// settings object. The hook nudges the agent toward the WayContext MCP's
// search tools when the cwd is an indexed project; see
// hooks/codectx-primary-search.sh for the behavior and its modes.
//
// These functions only transform a settings object -- the caller decides which
// settings.json to read and write (project-scoped by default, global on
// request) and never mutates the input.
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

/**
 * Remove our hook entry, leaving every other hook and setting untouched.
 * Empty containers we created are cleaned up so uninstalling leaves no trace.
 */
export function removeHook(settings) {
  const result = structuredClone(settings ?? {});
  const preToolUse = result.hooks?.PreToolUse;
  if (!Array.isArray(preToolUse)) return { settings: result, mode: "absent" };

  const remaining = preToolUse.filter((entry) => !isOurEntry(entry));
  if (remaining.length === preToolUse.length) return { settings: result, mode: "absent" };

  if (remaining.length) {
    result.hooks.PreToolUse = remaining;
  } else {
    delete result.hooks.PreToolUse;
    if (Object.keys(result.hooks).length === 0) delete result.hooks;
  }
  return { settings: result, mode: "removed" };
}
