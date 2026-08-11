import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSection, extractExistingName, extractExistingPath, upsertSection, removeGlobalSection,
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
  assert.match(section, /waycontext-review\.html/);
  assert.match(section, /review_url/);
  assert.match(section, /before (?:presenting|a) .*(?:spec|plan)/i);
  // Neither reasoning-graph call auto-opens a browser/IDE panel -- the
  // convention must say so, or a future session will falsely claim it did.
  assert.match(section, /no tool to (?:auto-open|automatically open)/i);
  assert.doesNotMatch(section, /REASONING_AUTO_OPEN/, "the flag is inert now that neither call auto-opens");
});

test("buildSection omits the indexed-directory sentence when no path is given", () => {
  const section = buildSection("my-app");
  assert.doesNotMatch(section, /indexed directory, relative to this file/);
});

// CLAUDE.md/AGENTS.md are committed and cloned onto other machines, so an
// absolute, machine-specific path baked into the section would be wrong the
// moment anyone else checks the repo out somewhere else.
test("buildSection embeds a relative indexed directory and tells the agent how to resolve it", () => {
  const section = buildSection("my-app", "./");
  assert.match(section, /indexed directory, relative to this file, is \*\*`\.\/`\*\*/);
  assert.match(section, /resolve\s+that\s+against this file's own directory/);
  assert.match(section, /`path` argument to `index_project`/);
});

test("buildSection embeds a relative indexed directory pointing at a different directory as-is", () => {
  const section = buildSection("my-app", "../sibling");
  assert.match(section, /indexed directory, relative to this file, is \*\*`\.\.\/sibling`\*\*/);
});

// "Project root" is ambiguous (git root vs. the directory WayContext indexes,
// which can be a subdirectory of it) -- buildSection now says "indexed
// directory" instead, but extractExistingPath must keep parsing CLAUDE.md
// files an older version already wrote with the old phrasing.
test("extractExistingPath still parses the old 'project root' phrasing for backward compat", () => {
  const legacy =
    "# Project Notes\n\n## WayContext\n\n" +
    "This repo is indexed by the `waycontext` MCP server as project\n" +
    "**`my-app`** — pass that as the `project` argument. Its project root, " +
    "relative to this file, is **`./old-sub`** — resolve that against this " +
    "file's own directory.\n";
  assert.equal(extractExistingPath(legacy), "./old-sub");
});

test("extractExistingName returns null when there is no section", () => {
  assert.equal(extractExistingName(""), null);
  assert.equal(extractExistingName("# Some Doc\n\nJust text.\n"), null);
});

test("extractExistingName returns the name from a section built by buildSection", () => {
  const content = `# Project Notes\n\n${buildSection("computer-bild-casino")}\n`;
  assert.equal(extractExistingName(content), "computer-bild-casino");
});

test("extractExistingPath returns null when the section has no stored path", () => {
  const content = `# Project Notes\n\n${buildSection("my-app")}\n`;
  assert.equal(extractExistingPath(content), null);
});

test("extractExistingPath returns the path from a section built by buildSection", () => {
  const content = `# Project Notes\n\n${buildSection("my-app", "./")}\n`;
  assert.equal(extractExistingPath(content), "./");
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

test("upsertSection updates a previously stored path without corrupting the rest of the section", () => {
  const original = `# Project Notes\n\n${buildSection("my-app", "./old-sub")}\n`;
  const { content, mode } = upsertSection(original, "my-app", "./new-sub");
  assert.equal(mode, "updated");
  assert.equal(extractExistingPath(content), "./new-sub");
  assert.equal(extractExistingName(content), "my-app");
  assert.ok(!content.includes("old-sub"));
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
