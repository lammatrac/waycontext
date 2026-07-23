import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSection, extractExistingName, upsertSection } from "../src/claudeMdInit.js";

test("buildSection embeds the project name in the expected format", () => {
  const section = buildSection("my-app");
  assert.match(section, /^## Code Context MCP\n/);
  assert.match(section, /\*\*`my-app`\*\*/);
  assert.match(section, /use\/target project `my-app`/);
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
  assert.match(content, /^# Project Notes\n\n## Code Context MCP\n/);
  assert.match(content, /\*\*`my-app`\*\*/);
});

test("upsertSection appends the section when content exists but has no section", () => {
  const original = "# My Project\n\nSome existing notes here.\n";
  const { content, mode } = upsertSection(original, "my-app");
  assert.equal(mode, "appended");
  assert.ok(content.startsWith(original));
  assert.match(content, /# Project Notes\n\n## Code Context MCP\n/);
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
