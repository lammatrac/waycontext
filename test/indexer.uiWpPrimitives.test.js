import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";

// End-to-end proof that a real indexProject run over a PHP fixture lands
// ui_screen / ui_settings_section / ui_settings_field entities (phase 1A-2:
// REQ-016/REQ-017/REQ-018), resolves REGISTERED_AT/RENDERED_BY entity_links
// for in-file owners/callbacks, and tombstones on re-index. Extraction logic
// itself is covered directly in test/ui.phpWpPrimitives.test.js.

const PROJECT = "ui_wp_primitives_fixture";
let dir;

async function entitiesOfKind(kind, rel) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, natural_key, title, data, deleted_at
       FROM entities
      WHERE project_id = $1 AND kind = $2 AND data->>'source_path' = $3
      ORDER BY (data->>'line')::int`,
    [project.id, kind, rel]
  );
  return res.rows;
}

async function linksFrom(entityId) {
  const res = await pool.query(
    `SELECT relation, dst_id FROM entity_links WHERE src_id = $1`,
    [entityId]
  );
  return res.rows;
}

function writeFixture() {
  fs.writeFileSync(path.join(dir, "admin.php"), `<?php
class Admin_Page {
  public function boot() {
    add_menu_page( 'My Page Title', 'My Menu', 'manage_options', 'my-slug', array( $this, 'render_page' ) );
    add_settings_section( 'sec_id', 'Section Title', array( $this, 'render_section' ), 'my-page' );
    add_settings_field( 'field_id', 'Field Title', array( $this, 'render_field' ), 'my-page', 'sec_id', array( 'label_for' => 'myfield' ) );
  }

  public function render_page() {
    do_settings_sections( 'my-page' );
    submit_button( 'Save Changes' );
  }

  public function render_section() {}
  public function render_field() {}
}
`);
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-wp-primitives-"));
  writeFixture();
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("REQ-016/017/018: a php admin file indexes ui_screen/ui_settings_section/ui_settings_field with resolved relations", async () => {
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));

  const screens = await entitiesOfKind("ui_screen", "admin.php");
  assert.equal(screens.length, 1, JSON.stringify(screens));
  const screen = screens[0];
  assert.equal(screen.data.registration_fn, "add_menu_page");
  assert.equal(screen.data.menu_title, "My Menu");
  assert.equal(screen.data.page_title, "My Page Title");
  assert.equal(screen.data.menu_slug, "my-slug");
  assert.equal(screen.data.route, "admin.php?page=my-slug");
  assert.equal(screen.data.renderer, "Admin_Page::render_page");
  assert.equal(screen.data.owner, "Admin_Page::boot");
  assert.equal(screen.natural_key, screen.data.screen_id);

  const screenLinks = await linksFrom(screen.id);
  assert.ok(screenLinks.find((l) => l.relation === "REGISTERED_AT"), "screen should link to its registering method");
  assert.ok(screenLinks.find((l) => l.relation === "RENDERED_BY"), "screen should link to its renderer method");

  const sections = await entitiesOfKind("ui_settings_section", "admin.php");
  assert.equal(sections.length, 1);
  const section = sections[0];
  assert.equal(section.data.section_id, "sec_id");
  assert.equal(section.data.page, "my-page");
  assert.equal(section.data.callback, "Admin_Page::render_section");
  assert.deepEqual(section.data.rendered_at, { owner: "Admin_Page::render_page", line: 10 });

  const sectionLinks = await linksFrom(section.id);
  assert.ok(sectionLinks.find((l) => l.relation === "REGISTERED_AT"));
  assert.ok(sectionLinks.find((l) => l.relation === "RENDERED_BY"));

  const fields = await entitiesOfKind("ui_settings_field", "admin.php");
  assert.equal(fields.length, 1);
  const field = fields[0];
  assert.equal(field.data.field_id, "field_id");
  assert.equal(field.data.section, "sec_id");
  assert.equal(field.data.label_for, "myfield");
  assert.equal(field.data.callback, "Admin_Page::render_field");

  const fieldLinks = await linksFrom(field.id);
  assert.ok(fieldLinks.find((l) => l.relation === "REGISTERED_AT"));
  assert.ok(fieldLinks.find((l) => l.relation === "RENDERED_BY"));

  // REQ-016: submit_button() lands as a plain ui_element, same table/kind as
  // literal-HTML elements (phase 1A-1), tagged with extraction "wp_primitive".
  const project = await getProject(PROJECT);
  const btnRes = await pool.query(
    `SELECT data FROM entities
      WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = 'admin.php'
        AND data->>'extraction' = 'wp_primitive'`,
    [project.id]
  );
  assert.equal(btnRes.rows.length, 1);
  assert.equal(btnRes.rows[0].data.text, "Save Changes");
  assert.equal(btnRes.rows[0].data.owner, "Admin_Page::render_page");

  // Storage plane: entities/entity_links only.
  const symbolRows = await pool.query(
    `SELECT count(*)::int AS n FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND f.path = 'admin.php' AND s.kind LIKE 'ui%'`,
    [project.id]
  );
  assert.equal(symbolRows.rows[0].n, 0);
});

test("editing the file to remove the settings field tombstones it, keeps the screen/section live", async () => {
  fs.writeFileSync(path.join(dir, "admin.php"), `<?php
class Admin_Page {
  public function boot() {
    add_menu_page( 'My Page Title', 'My Menu', 'manage_options', 'my-slug', array( $this, 'render_page' ) );
    add_settings_section( 'sec_id', 'Section Title', array( $this, 'render_section' ), 'my-page' );
  }
  public function render_page() {}
  public function render_section() {}
}
`);
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));

  const project = await getProject(PROJECT);
  const all = await pool.query(
    `SELECT kind, deleted_at FROM entities
      WHERE project_id = $1 AND kind = 'ui_settings_field' AND data->>'source_path' = 'admin.php'`,
    [project.id]
  );
  assert.equal(all.rows.length, 1);
  assert.ok(all.rows[0].deleted_at !== null, "removed settings field should be tombstoned");

  const liveScreens = await entitiesOfKind("ui_screen", "admin.php");
  assert.equal(liveScreens.filter((r) => r.deleted_at === null).length, 1);

  // restore the fixture for later tests
  writeFixture();
  await indexProject(PROJECT, dir);
});
