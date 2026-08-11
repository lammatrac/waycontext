// Pure helpers for merging the CLAUDE.md-pipeline gate hook (waycontext_gate.py)
// into a Claude Code settings object, and its companion .gitignore entries.
// Mirrors src/hookInit.js's shape: the caller decides which settings.json /
// .gitignore to read and write; these functions only transform content and
// never mutate their input.
const GATE_COMMAND_SUFFIX = "waycontext_gate.py";
const GATE_ENV_KEYS = ["CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS"];

function isGateHookEntry(entry) {
  return (
    Array.isArray(entry?.hooks) &&
    entry.hooks.some(
      (h) => h?.type === "command" && typeof h.command === "string" && h.command.endsWith(GATE_COMMAND_SUFFIX)
    )
  );
}

/** Upsert the gate's entries for one hook event, identified by command basename (not matcher) — the gate's own PreToolUse matcher must coexist with the unrelated search hook's PreToolUse matcher in the same array. */
function mergeHookEvent(existingEvent, incomingEntries) {
  const arr = Array.isArray(existingEvent) ? [...existingEvent] : [];
  let changed = !Array.isArray(existingEvent);

  for (const incoming of incomingEntries) {
    const idx = arr.findIndex(isGateHookEntry);
    if (idx === -1) {
      arr.push(incoming);
      changed = true;
    } else if (JSON.stringify(arr[idx]) !== JSON.stringify(incoming)) {
      arr[idx] = incoming;
      changed = true;
    }
  }

  return { arr, changed };
}

/**
 * Merge only the `env` and `hooks` keys of `gateSettings` (this repo's own
 * settings.json) into `existing` (~/.claude/settings.json, typically),
 * leaving every other key and every unrelated hook entry untouched.
 */
export function mergeGateSettings(existing, gateSettings) {
  const hadNothing = !existing || (!existing.env && !existing.hooks);
  const result = structuredClone(existing ?? {});
  let changed = false;

  const incomingEnv = gateSettings.env ?? {};
  if (Object.keys(incomingEnv).length) result.env ??= {};
  for (const [key, value] of Object.entries(incomingEnv)) {
    if (result.env[key] !== value) {
      result.env[key] = value;
      changed = true;
    }
  }

  const incomingHooks = gateSettings.hooks ?? {};
  if (Object.keys(incomingHooks).length) result.hooks ??= {};
  for (const [event, entries] of Object.entries(incomingHooks)) {
    const { arr, changed: eventChanged } = mergeHookEvent(result.hooks[event], entries);
    result.hooks[event] = arr;
    if (eventChanged) changed = true;
  }

  return { settings: result, mode: !changed ? "unchanged" : hadNothing ? "created" : "updated" };
}

/** Remove everything mergeGateSettings added, leaving unrelated settings/hooks/env untouched. */
export function removeGateSettings(existing) {
  const result = structuredClone(existing ?? {});
  let changed = false;

  if (result.hooks) {
    for (const event of Object.keys(result.hooks)) {
      const before = result.hooks[event];
      if (!Array.isArray(before)) continue;
      const after = before.filter((entry) => !isGateHookEntry(entry));
      if (after.length === before.length) continue;
      changed = true;
      if (after.length) result.hooks[event] = after;
      else delete result.hooks[event];
    }
    if (Object.keys(result.hooks).length === 0) delete result.hooks;
  }

  if (result.env) {
    for (const key of GATE_ENV_KEYS) {
      if (!(key in result.env)) continue;
      delete result.env[key];
      changed = true;
    }
    if (Object.keys(result.env).length === 0) delete result.env;
  }

  return { settings: result, mode: changed ? "removed" : "absent" };
}

/** A pattern with any leading/trailing slashes stripped, for anchoring-insensitive comparison. */
function normalizePattern(line) {
  return line.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Merge .gitignore.sample's lines into an existing .gitignore, adding only
 * lines whose pattern (ignoring `/` anchoring) isn't already covered.
 */
export function mergeGitignore(existingContent, sampleContent) {
  const base = existingContent ?? "";
  const existing = new Set(
    base
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map(normalizePattern)
  );

  const sampleLines = (sampleContent ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const added = sampleLines.filter((l) => !existing.has(normalizePattern(l)));

  if (added.length === 0) {
    return { content: base, mode: "unchanged", added: [] };
  }

  const created = !base.trim();
  const sep = created || base.endsWith("\n") ? "" : "\n";
  const content = `${base}${sep}\n# WayContext gate hook\n${added.join("\n")}\n`;
  return { content: created ? content.trimStart() : content, mode: created ? "created" : "appended", added };
}
