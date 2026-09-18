import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { config } from "../src/config.js";
import { cleanupTestProject } from "./helpers/testProject.js";

// End-to-end proof that a real indexProject run over a PHP fixture lands
// ui_element entities (never symbols/edges), tombstones elements edited out
// of a file on re-index, and is fully skippable via UI_ENABLED=0. Extraction
// logic itself is covered directly in test/ui.phpElements.test.js.

const PROJECT = "ui_elements_fixture";
let dir;

async function uiElements(rel) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT natural_key, title, data, deleted_at
       FROM entities
      WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = $2
      ORDER BY (data->>'line')::int`,
    [project.id, rel]
  );
  return res.rows;
}

function writeFixture() {
  fs.writeFileSync(path.join(dir, "widget.php"), `<?php
class Widget {
  public function render() {
    ?>
    <div class="widget">
      <h2>Section title</h2>
      <button aria-label="Save item" title="Save">Save</button>
      <input type="text" placeholder="Search" name="q" data-testid="search-input" />
    </div>
    <?php
  }
}
`);
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-elements-"));
  writeFixture();
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("a php file with literal HTML indexes as ui_element entities, never symbols/edges", async () => {
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));

  const rows = await uiElements("widget.php");
  assert.equal(rows.length, 3, JSON.stringify(rows));

  const heading = rows.find((r) => r.data.tag === "h2");
  const button = rows.find((r) => r.data.tag === "button");
  const input = rows.find((r) => r.data.tag === "input");

  assert.equal(heading.data.type, "heading");
  assert.equal(heading.data.text, "Section title");
  assert.equal(heading.data.owner, "Widget::render");
  assert.equal(heading.data.source_path, "widget.php");
  assert.equal(heading.data.framework, "php");

  assert.equal(button.data.type, "button");
  assert.equal(button.data.text, "Save");
  assert.equal(button.data.text_source, "child_text");
  assert.equal(button.data.aria_label, "Save item");

  assert.equal(input.data.type, "textbox");
  assert.equal(input.data.text, "Search");
  assert.equal(input.data.text_source, "placeholder");
  assert.equal(input.data.data_testid, "search-input");

  // REQ-020: element_id is a composed string, never a raw entities.id.
  for (const r of rows) {
    assert.match(r.natural_key, /^ui:ui_elements_fixture:php:widget\.php:Widget::render:/);
    assert.equal(r.data.element_id, r.natural_key);
  }

  // Storage plane: entities/entity_links only (contracts.md "Fixed by the spec").
  const project = await getProject(PROJECT);
  const symbolRows = await pool.query(
    `SELECT count(*)::int AS n FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND f.path = 'widget.php' AND s.kind LIKE 'ui%'`,
    [project.id]
  );
  assert.equal(symbolRows.rows[0].n, 0);
});

test("editing an element out of the file tombstones it instead of leaving it live", async () => {
  // Drop the <input> from the fixture, keep the heading and button.
  fs.writeFileSync(path.join(dir, "widget.php"), `<?php
class Widget {
  public function render() {
    ?>
    <div class="widget">
      <h2>Section title</h2>
      <button aria-label="Save item" title="Save">Save</button>
    </div>
    <?php
  }
}
`);
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));

  const project = await getProject(PROJECT);
  const all = await pool.query(
    `SELECT data->>'tag' AS tag, deleted_at FROM entities
      WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = 'widget.php'`,
    [project.id]
  );
  const input = all.rows.find((r) => r.tag === "input");
  const live = all.rows.filter((r) => r.deleted_at === null);

  assert.ok(input, "the removed element's entity should still exist, tombstoned");
  assert.ok(input.deleted_at !== null, "removed element should be tombstoned");
  assert.equal(live.length, 2);
  assert.deepEqual(live.map((r) => r.tag).sort(), ["button", "h2"]);

  // restore the fixture for later tests in this file
  writeFixture();
  await indexProject(PROJECT, dir);
});

test("UI_ENABLED=0 skips extraction entirely (additive-only gate)", async () => {
  await cleanupTestProject(PROJECT + "_disabled");
  const disabledDir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-disabled-"));
  fs.writeFileSync(path.join(disabledDir, "widget.php"), `<?php
?>
<button aria-label="Save item">Save</button>
`);

  const prevEnabled = config.uiEnabled;
  config.uiEnabled = false;
  try {
    const stats = await indexProject(PROJECT + "_disabled", disabledDir);
    assert.equal(stats.failed, 0, JSON.stringify(stats));
  } finally {
    config.uiEnabled = prevEnabled;
    fs.rmSync(disabledDir, { recursive: true, force: true });
  }

  const project = await getProject(PROJECT + "_disabled");
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM entities WHERE project_id = $1 AND kind = 'ui_element'`,
    [project.id]
  );
  assert.equal(res.rows[0].n, 0);
  await cleanupTestProject(PROJECT + "_disabled");
});
