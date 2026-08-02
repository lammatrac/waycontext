import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHookEntry, upsertHook, removeHook } from "../src/hookInit.js";

const SCRIPT = "/repo/hooks/codectx-primary-search.sh";

test("removeHook reports absent when there is nothing to remove", () => {
  assert.equal(removeHook({}).mode, "absent");
  assert.equal(removeHook({ hooks: {} }).mode, "absent");
  assert.equal(removeHook({ hooks: { PreToolUse: [] } }).mode, "absent");
});

test("removeHook deletes containers it emptied, leaving no trace", () => {
  const { settings: installed } = upsertHook({}, SCRIPT);
  const { settings, mode } = removeHook(installed);
  assert.equal(mode, "removed");
  assert.deepEqual(settings, {});
});

test("removeHook keeps unrelated hooks and settings intact", () => {
  const original = {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "/other.sh" }] }],
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "/fmt.sh" }] }],
    },
  };
  const { settings: installed } = upsertHook(original, SCRIPT);
  const { settings, mode } = removeHook(installed);
  assert.equal(mode, "removed");
  assert.deepEqual(settings, original);
});

test("removeHook does not mutate its input", () => {
  const { settings: installed } = upsertHook({}, SCRIPT);
  const snapshot = JSON.parse(JSON.stringify(installed));
  removeHook(installed);
  assert.deepEqual(installed, snapshot);
});

test("install then remove is a round trip for an arbitrary settings file", () => {
  const original = { model: "opus", hooks: { SessionStart: [{ hooks: [] }] } };
  const { settings: installed } = upsertHook(original, SCRIPT);
  assert.deepEqual(removeHook(installed).settings, original);
});

test("buildHookEntry targets Bash and Grep with the given script path", () => {
  const entry = buildHookEntry("/path/to/codectx-primary-search.sh");
  assert.equal(entry.matcher, "Bash|Grep");
  assert.equal(entry.hooks.length, 1);
  assert.equal(entry.hooks[0].type, "command");
  assert.equal(entry.hooks[0].command, "/path/to/codectx-primary-search.sh");
});

test("upsertHook creates hooks.PreToolUse when settings has no hooks at all", () => {
  const { settings, mode } = upsertHook({}, "/repo/hooks/codectx-primary-search.sh");
  assert.equal(mode, "created");
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "/repo/hooks/codectx-primary-search.sh");
});

test("upsertHook appends to an existing PreToolUse array without touching other entries", () => {
  const existing = {
    permissions: { allow: ["Bash(git *)"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "touch /tmp/marker" }] }],
      PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "prettier --write" }] }],
    },
  };
  const { settings, mode } = upsertHook(existing, "/repo/hooks/codectx-primary-search.sh");
  assert.equal(mode, "appended");
  assert.equal(settings.permissions.allow[0], "Bash(git *)");
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "touch /tmp/marker");
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[0].matcher, "Write|Edit");
  assert.equal(settings.hooks.PreToolUse[1].matcher, "Bash|Grep");
});

test("upsertHook is a no-op when the exact same entry already exists", () => {
  const scriptPath = "/repo/hooks/codectx-primary-search.sh";
  const first = upsertHook({}, scriptPath);
  const second = upsertHook(first.settings, scriptPath);
  assert.equal(second.mode, "unchanged");
  assert.deepEqual(second.settings, first.settings);
});

test("upsertHook updates in place when the script path changed (e.g. repo moved)", () => {
  const existing = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash|Grep", hooks: [{ type: "command", command: "/old/location/codectx-primary-search.sh", timeout: 10 }] },
      ],
    },
  };
  const { settings, mode } = upsertHook(existing, "/new/location/codectx-primary-search.sh");
  assert.equal(mode, "updated");
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "/new/location/codectx-primary-search.sh");
});

test("upsertHook does not mutate the input settings object", () => {
  const existing = { hooks: { PreToolUse: [] } };
  upsertHook(existing, "/repo/hooks/codectx-primary-search.sh");
  assert.deepEqual(existing, { hooks: { PreToolUse: [] } });
});
