import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeGateSettings, removeGateSettings, mergeGitignore } from "../src/gateInit.js";

const GATE_SETTINGS = {
  _comment: "ignored on purpose -- only env/hooks are merged",
  env: { CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1" },
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "python3 $HOME/.claude/hooks/waycontext_gate.py" }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "python3 $HOME/.claude/hooks/waycontext_gate.py" }] }],
    PreToolUse: [{
      matcher: "Grep|Glob|Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: "python3 $HOME/.claude/hooks/waycontext_gate.py" }],
    }],
    PostToolUse: [{
      matcher: "mcp__waycontext__.*",
      hooks: [{ type: "command", command: "python3 $HOME/.claude/hooks/waycontext_gate.py" }],
    }],
  },
};

// The pre-existing search hook (waycontext hook install) lives under the same
// PreToolUse event with a different matcher -- both must survive together.
const SEARCH_HOOK_ENTRY = { matcher: "Bash|Grep", hooks: [{ type: "command", command: "/repo/hooks/codectx-primary-search.sh" }] };

test("mergeGateSettings creates env/hooks from nothing", () => {
  const { settings, mode } = mergeGateSettings({}, GATE_SETTINGS);
  assert.equal(mode, "created");
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS, "1");
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "python3 $HOME/.claude/hooks/waycontext_gate.py");
  assert.ok(!("_comment" in settings), "_comment must not be merged");
});

test("mergeGateSettings is a no-op when re-run on its own output", () => {
  const first = mergeGateSettings({}, GATE_SETTINGS);
  const second = mergeGateSettings(first.settings, GATE_SETTINGS);
  assert.equal(second.mode, "unchanged");
  assert.deepEqual(second.settings, first.settings);
});

test("mergeGateSettings preserves unrelated env keys and the search hook's PreToolUse entry", () => {
  const existing = {
    env: { SOME_OTHER_VAR: "keep-me" },
    hooks: { PreToolUse: [SEARCH_HOOK_ENTRY] },
  };
  const { settings, mode } = mergeGateSettings(existing, GATE_SETTINGS);
  assert.equal(mode, "updated");
  assert.equal(settings.env.SOME_OTHER_VAR, "keep-me");
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS, "1");
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.deepEqual(settings.hooks.PreToolUse[0], SEARCH_HOOK_ENTRY);
  assert.match(settings.hooks.PreToolUse[1].hooks[0].command, /waycontext_gate\.py$/);
});

test("mergeGateSettings updates in place when the gate's own entry changed", () => {
  const first = mergeGateSettings({}, GATE_SETTINGS);
  const changed = {
    ...GATE_SETTINGS,
    hooks: { ...GATE_SETTINGS.hooks, PreToolUse: [{ matcher: "Grep|Glob", hooks: [{ type: "command", command: "python3 $HOME/.claude/hooks/waycontext_gate.py" }] }] },
  };
  const { settings, mode } = mergeGateSettings(first.settings, changed);
  assert.equal(mode, "updated");
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].matcher, "Grep|Glob");
});

test("mergeGateSettings does not mutate its input", () => {
  const existing = { hooks: { PreToolUse: [] } };
  mergeGateSettings(existing, GATE_SETTINGS);
  assert.deepEqual(existing, { hooks: { PreToolUse: [] } });
});

test("removeGateSettings reports absent when there is nothing to remove", () => {
  assert.equal(removeGateSettings({}).mode, "absent");
  assert.equal(removeGateSettings({ hooks: { PreToolUse: [SEARCH_HOOK_ENTRY] } }).mode, "absent");
});

test("removeGateSettings round-trips with mergeGateSettings, leaving unrelated content intact", () => {
  const original = {
    env: { SOME_OTHER_VAR: "keep-me" },
    hooks: { PreToolUse: [SEARCH_HOOK_ENTRY] },
  };
  const { settings: installed } = mergeGateSettings(original, GATE_SETTINGS);
  const { settings, mode } = removeGateSettings(installed);
  assert.equal(mode, "removed");
  assert.deepEqual(settings, original);
});

test("removeGateSettings deletes containers it emptied, leaving no trace", () => {
  const { settings: installed } = mergeGateSettings({}, GATE_SETTINGS);
  const { settings, mode } = removeGateSettings(installed);
  assert.equal(mode, "removed");
  assert.deepEqual(settings, {});
});

test("mergeGitignore is unchanged when every sample line is already covered in some anchored form", () => {
  const existing = "node_modules/\n/.vscode/\n.claude/\n/tasks/\n";
  const sample = ".vscode/\n.claude/\n/tasks/\n";
  const { content, mode, added } = mergeGitignore(existing, sample);
  assert.equal(mode, "unchanged");
  assert.deepEqual(added, []);
  assert.equal(content, existing);
});

test("mergeGitignore appends only the genuinely-missing lines", () => {
  const existing = "node_modules/\n/tasks/\n";
  const sample = "/tasks/\nwaycontext-tasks/\n";
  const { content, mode, added } = mergeGitignore(existing, sample);
  assert.equal(mode, "appended");
  assert.deepEqual(added, ["waycontext-tasks/"]);
  assert.match(content, /waycontext-tasks\/\n$/);
  assert.ok(content.startsWith(existing));
});

test("mergeGitignore is a no-op on the second call against its own output", () => {
  const existing = "node_modules/\n";
  const sample = "waycontext-tasks/\n";
  const first = mergeGitignore(existing, sample);
  const second = mergeGitignore(first.content, sample);
  assert.equal(second.mode, "unchanged");
  assert.equal(second.content, first.content);
});

test("mergeGitignore creates content from an empty file", () => {
  const { content, mode } = mergeGitignore("", ".claude/\n");
  assert.equal(mode, "created");
  assert.match(content, /^# WayContext gate hook\n\.claude\/\n$/);
});
