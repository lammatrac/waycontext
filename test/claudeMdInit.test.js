import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSection, extractExistingName, upsertSection, removeGlobalSection,
} from "../src/claudeMdInit.js";

// Nothing writes the global section any more -- the workflow it carried now
// lives in the MCP server's `instructions`, which reaches every client instead
// of only Claude Code. But older versions did write it, unattended, into
// ~/.claude/CLAUDE.md, so uninstall must still recognise and remove it. These
// fixtures are what those versions actually left on disk; they cannot be
// regenerated from a builder, which is the point.
const LEGACY_GLOBAL = [
  "## WayContext Workflow",
  "",
  "`waycontext` is a globally-registered MCP server — it is available in every",
  "project's session, not just this one.",
  "",
  "1. `project_overview` → orient",
].join("\n");

test("removeGlobalSection is a no-op when the section was never installed", () => {
  const content = "# My rules\n\nSome guidance.\n";
  assert.equal(removeGlobalSection(content), content);
});

test("removeGlobalSection strips a section an older version left behind, preserving the rest", () => {
  const content = `# My rules\n\nSome guidance.\n\n${LEGACY_GLOBAL}\n\n## Git Commit\n\nUse conventional commits.\n`;

  const cleaned = removeGlobalSection(content);
  assert.doesNotMatch(cleaned, /WayContext Workflow/);
  assert.match(cleaned, /# My rules/);
  assert.match(cleaned, /## Git Commit/);
  assert.match(cleaned, /Use conventional commits\./);
});

test("removeGlobalSection does not leave a run of blank lines behind", () => {
  const content = `# Rules\n\nA.\n\n${LEGACY_GLOBAL}\n\n## Later\n\nB.\n`;
  assert.doesNotMatch(removeGlobalSection(content), /\n{3,}/);
});

test("buildSection embeds the project name in the expected format", () => {
  const section = buildSection("my-app");
  assert.match(section, /^## WayContext\n/);
  assert.match(section, /\*\*`my-app`\*\*/);
});

// The whole reason init exists is to change which tool the agent reaches for
// first. A section that only announces the project name -- which is what this
// used to be -- leaves the agent no reason to prefer WayContext over grep.
test("buildSection tells the agent to use WayContext before its built-in search", () => {
  const section = buildSection("my-app");
  assert.match(section, /BEFORE `Grep`\/`Glob`/);
  for (const tool of ["project_overview", "search_code", "get_callers", "get_symbol"]) {
    assert.match(section, new RegExp(tool), `the workflow must name ${tool}`);
  }
});

// ...and it has to say where grep is still correct. Without the counterweight
// an agent follows the instruction past the point of usefulness and burns calls
// searching a symbol index for config keys and log lines.
test("buildSection says what WayContext is not for", () => {
  const section = buildSection("my-app");
  assert.match(section, /`Grep`\/`Glob` stay correct/);
  assert.match(section, /config|logs/);
});

test("buildSection instructs Claude to render a reasoning graph before a spec/plan review", () => {
  const section = buildSection("my-app");
  assert.match(section, /create_reasoning_graph/);
  assert.match(section, /update_reasoning_graph/);
  assert.match(section, /docs\/waycontext/);
  assert.match(section, /before (?:presenting|a) .*(?:spec|plan)/i);
  // Claude has no tool to open a browser/IDE panel automatically -- the
  // convention must say so, or a future session will falsely claim it did.
  assert.match(section, /no tool to (?:auto-open|automatically open)/i);
});

test("extractExistingName returns null when there is no section", () => {
  assert.equal(extractExistingName(""), null);
  assert.equal(extractExistingName("# Some Doc\n\nJust text.\n"), null);
});

test("extractExistingName returns the name from a section built by buildSection", () => {
  const content = `# Project Notes\n\n${buildSection("computer-bild-casino")}\n`;
  assert.equal(extractExistingName(content), "computer-bild-casino");
});

test("upsertSection creates a new file when content is empty", () => {
  const { content, mode } = upsertSection("", "my-app");
  assert.equal(mode, "created");
  assert.match(content, /^# Project Notes\n\n## WayContext\n/);
  assert.match(content, /\*\*`my-app`\*\*/);
});

test("upsertSection appends the section when content exists but has no section", () => {
  const original = "# My Project\n\nSome existing notes here.\n";
  const { content, mode } = upsertSection(original, "my-app");
  assert.equal(mode, "appended");
  assert.ok(content.startsWith(original));
  assert.match(content, /# Project Notes\n\n## WayContext\n/);
  assert.match(content, /\*\*`my-app`\*\*/);
});

test("upsertSection replaces only the section when one already exists, preserving surrounding content", () => {
  const before = "# My Project\n\nIntro text.\n\n";
  const after = "\n\n## Other Section\n\nUnrelated trailing content.\n";
  const original = `${before}# Project Notes\n\n${buildSection("old-name")}\n${after}`;
  const { content, mode } = upsertSection(original, "new-name");
  assert.equal(mode, "updated");
  assert.ok(content.startsWith(before));
  assert.ok(content.endsWith(after));
  assert.match(content, /\*\*`new-name`\*\*/);
  assert.ok(!content.includes("old-name"));
});

test("an existing pre-v0.2.0 section is migrated in place, not duplicated", () => {
  const legacy = [
    "# Project Notes",
    "",
    "## Code Context MCP",
    "",
    "This project is indexed by the `code-context` MCP server under the project",
    "name **`old-name`**.",
    "",
    "## Something Else",
    "",
    "Keep me.",
    "",
  ].join("\n");

  assert.equal(extractExistingName(legacy), "old-name",
    "the old heading must still be recognised, or init would append a second section");

  const { content, mode } = upsertSection(legacy, "new-name");
  assert.equal(mode, "updated");
  assert.doesNotMatch(content, /## Code Context MCP/);
  assert.equal((content.match(/## WayContext/g) || []).length, 1);
  assert.match(content, /\*\*`new-name`\*\*/);
  assert.match(content, /## Something Else/);
  assert.match(content, /Keep me\./);
});

test("the pre-v0.2.0 global heading is still removable", () => {
  const legacy = "# Rules\n\n## Code Context MCP Workflow\n\nOld body.\n\n## Other\n\nKeep.\n";
  const cleaned = removeGlobalSection(legacy);
  assert.doesNotMatch(cleaned, /Code Context MCP Workflow/,
    "uninstall must still be able to remove the old heading");
  assert.match(cleaned, /## Other/);
  assert.match(cleaned, /Keep\./);
});
