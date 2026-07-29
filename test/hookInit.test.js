import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHookEntry, upsertHook } from "../src/hookInit.js";

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
