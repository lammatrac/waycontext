import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { config } from "../src/config.js";
import { cleanupTestProject } from "./helpers/testProject.js";

// End-to-end proof that a real indexProject run resolves the UI relation
// post-pass project-wide (phase 1A-6: REQ-006/013/015/019/020/021/022) --
// ui_component materialization, DEFINED_BY/HANDLED_BY, CONTAINS/RENDERS/
// RENDERED_ON (including cross-file do_settings_sections() completion),
// ownership classification, and additive-failure isolation. Each producer's
// own extraction/relations (ui_element, ui_screen, ui_settings_*, hooks,
// i18n, identity preflight) are covered by their own phase's test file --
// this one covers only what 1A-6 itself adds.

const PROJECT = "ui_relations_fixture";
let dir;

async function entity(kind, sourcePath, ownerLike) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, natural_key, title, data, deleted_at
       FROM entities
      WHERE project_id = $1 AND kind = $2 AND data->>'source_path' = $3
        AND ($4::text IS NULL OR data->>'owner' = $4)
      ORDER BY id`,
    [project.id, kind, sourcePath, ownerLike ?? null]
  );
  return res.rows;
}

async function linksFrom(entityId, relation) {
  const res = await pool.query(
    `SELECT relation, dst_id, data FROM entity_links WHERE src_id = $1 AND ($2::text IS NULL OR relation = $2)`,
    [entityId, relation ?? null]
  );
  return res.rows;
}

async function linksTo(entityId, relation) {
  const res = await pool.query(
    `SELECT relation, src_id, data FROM entity_links WHERE dst_id = $1 AND ($2::text IS NULL OR relation = $2)`,
    [entityId, relation ?? null]
  );
  return res.rows;
}

function writeFixture() {
  fs.writeFileSync(path.join(dir, "admin.php"), `<?php
class Admin_Page {
  public function boot() {
    add_menu_page( 'My Page Title', 'My Menu', 'manage_options', 'my-slug', array( $this, 'render_page' ) );
  }
  public function render_page() {
    do_settings_sections( 'my-page' );
    submit_button( 'Save Changes' );
    do_action( 'my_plugin_saved' );
  }
}
`);
  // Settings registered in a DIFFERENT file than the one that calls
  // do_settings_sections() -- the dominant real-world WP pattern 1A-2 left
  // unresolved cross-file (contracts.md "Phase 1A-2"), and the specific gap
  // this phase's settings_render_site staging entity closes.
  fs.writeFileSync(path.join(dir, "settings.php"), `<?php
class Settings_Page {
  public function register() {
    add_settings_section( 'sec_id', 'Section Title', array( $this, 'render_section' ), 'my-page' );
    add_settings_field( 'field_id', 'Field Title', array( $this, 'render_field' ), 'my-page', 'sec_id' );
  }
  public function render_section() {}
  public function render_field() {}
}
`);
  // A hook fired from the screen's renderer, listened to by a symbol in a
  // third file -- HANDLED_BY should reuse 1A-3's already-resolved
  // LISTENS_TO graph, not reimplement hook resolution.
  fs.writeFileSync(path.join(dir, "listener.php"), `<?php
class Save_Handler {
  public function boot() {
    add_action( 'my_plugin_saved', array( $this, 'handle_save' ) );
  }
  public function handle_save() {}
}
`);
  // An element whose owning function is never used as any screen's
  // renderer -- exercises the "unknown_render" resolution_status.
  fs.writeFileSync(path.join(dir, "orphan.php"), `<?php
function render_widget() {
  ?>
  <button>Orphan</button>
  <?php
}
`);
  // REQ-013: wp-includes/ is framework-owned, not application source.
  fs.mkdirSync(path.join(dir, "wp-includes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "wp-includes", "core-widgets.php"), `<?php
function core_widget_render() {
  ?>
  <button>Core</button>
  <?php
}
`);
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-relations-"));
  writeFixture();
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("REQ-019/020: ui_component is materialized per (source_path, owner), excluding the @file sentinel", async () => {
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));
  assert.ok(stats.uiRelations && !stats.uiRelations.error, JSON.stringify(stats.uiRelations));
  assert.ok(stats.uiRelations.componentCount >= 4, JSON.stringify(stats.uiRelations));

  const comps = await entity("ui_component", "admin.php", "Admin_Page::render_page");
  assert.equal(comps.length, 1);
  assert.equal(comps[0].natural_key, "ui:ui_relations_fixture:php:admin.php:Admin_Page::render_page:component");
  assert.equal(comps[0].data.component_id, comps[0].natural_key);
  assert.equal(comps[0].data.ownership, "application");

  // boot() only registers a screen (no element/settings row references it
  // directly other than the registration itself) -- still gets a component,
  // since ui_screen's own `owner` also counts.
  const bootComp = await entity("ui_component", "admin.php", "Admin_Page::boot");
  assert.equal(bootComp.length, 1);
});

test("RENDERS + DEFINED_BY: component -> element, element -> owning symbol's entity", async () => {
  const project = await getProject(PROJECT);
  const comps = await entity("ui_component", "admin.php", "Admin_Page::render_page");
  const component = comps[0];

  const renders = await linksFrom(component.id, "RENDERS");
  assert.equal(renders.length, 1, "component should RENDER exactly the submit_button element");

  const elRes = await pool.query(
    `SELECT id, data FROM entities WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = 'admin.php'`,
    [project.id]
  );
  assert.equal(elRes.rows.length, 1);
  const element = elRes.rows[0];
  assert.equal(renders[0].dst_id, element.id);

  const elDefinedBy = await linksFrom(element.id, "DEFINED_BY");
  assert.equal(elDefinedBy.length, 1);
  assert.equal(elDefinedBy[0].data.resolution_status, "resolved");
  assert.equal(elDefinedBy[0].data.ownership, "application");

  const symRes = await pool.query(
    `SELECT s.entity_id FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND f.path = 'admin.php' AND s.name = 'Admin_Page::render_page'`,
    [project.id]
  );
  assert.equal(elDefinedBy[0].dst_id, symRes.rows[0].entity_id);

  const compDefinedBy = await linksFrom(component.id, "DEFINED_BY");
  assert.equal(compDefinedBy.length, 1);
  assert.equal(compDefinedBy[0].dst_id, symRes.rows[0].entity_id);
});

test("CONTAINS: ui_screen -> ui_component via shared RENDERED_BY/DEFINED_BY target symbol", async () => {
  const screens = await entity("ui_screen", "admin.php", null);
  assert.equal(screens.length, 1);
  const screen = screens[0];

  const comps = await entity("ui_component", "admin.php", "Admin_Page::render_page");
  const contains = await linksFrom(screen.id, "CONTAINS");
  assert.ok(contains.find((l) => l.dst_id === comps[0].id), "screen should CONTAIN the render_page component");
});

test("RENDERED_ON: element gets a direct link to its screen, flattened from screen CONTAINS component RENDERS element (REQ-006)", async () => {
  const project = await getProject(PROJECT);
  const elRes = await pool.query(
    `SELECT id, data FROM entities WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = 'admin.php'`,
    [project.id]
  );
  const element = elRes.rows[0];
  assert.equal(element.data.render_status, "resolved");

  const screens = await entity("ui_screen", "admin.php", null);
  const renderedOn = await linksFrom(element.id, "RENDERED_ON");
  assert.equal(renderedOn.length, 1);
  assert.equal(renderedOn[0].dst_id, screens[0].id);
  assert.equal(renderedOn[0].data.resolution_status, "resolved");
});

test("cross-file do_settings_sections() completion: ui_component CONTAINS the section/field registered in a different file, flattened onto the screen too", async () => {
  const comps = await entity("ui_component", "admin.php", "Admin_Page::render_page");
  const component = comps[0];

  const sections = await entity("ui_settings_section", "settings.php", null);
  assert.equal(sections.length, 1);
  const fields = await entity("ui_settings_field", "settings.php", null);
  assert.equal(fields.length, 1);

  const compContains = await linksFrom(component.id, "CONTAINS");
  assert.ok(compContains.find((l) => l.dst_id === sections[0].id), "component should CONTAIN the cross-file settings section");

  const screens = await entity("ui_screen", "admin.php", null);
  const screenContains = await linksFrom(screens[0].id, "CONTAINS");
  assert.ok(screenContains.find((l) => l.dst_id === sections[0].id), "screen should transitively CONTAIN the section (flattened)");
  assert.ok(screenContains.find((l) => l.dst_id === fields[0].id), "screen should transitively CONTAIN the field (flattened)");

  const sectionContains = await linksFrom(sections[0].id, "CONTAINS");
  assert.ok(sectionContains.find((l) => l.dst_id === fields[0].id), "section should CONTAIN its field");
});

test("HANDLED_BY: component -> the symbol that LISTENS_TO a hook this component FIRES (reuses 1A-3's graph, no reimplementation)", async () => {
  const comps = await entity("ui_component", "admin.php", "Admin_Page::render_page");
  const component = comps[0];

  const handledBy = await linksFrom(component.id, "HANDLED_BY");
  assert.equal(handledBy.length, 1);

  const project = await getProject(PROJECT);
  const symRes = await pool.query(
    `SELECT s.entity_id FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND f.path = 'listener.php' AND s.name = 'Save_Handler::handle_save'`,
    [project.id]
  );
  assert.equal(handledBy[0].dst_id, symRes.rows[0].entity_id);
});

test("REQ-013: framework-owned source (wp-includes/) is classified separately from application source", async () => {
  const project = await getProject(PROJECT);
  const coreEl = await pool.query(
    `SELECT data FROM entities WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = 'wp-includes/core-widgets.php'`,
    [project.id]
  );
  assert.equal(coreEl.rows.length, 1);
  assert.equal(coreEl.rows[0].data.ownership, "framework");

  const appEl = await pool.query(
    `SELECT data FROM entities WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = 'orphan.php'`,
    [project.id]
  );
  assert.equal(appEl.rows[0].data.ownership, "application");
});

test("unknown_render: an element whose owner is never used as any screen's renderer gets no RENDERED_ON and an explicit status", async () => {
  const project = await getProject(PROJECT);
  const orphanEl = await pool.query(
    `SELECT id, data FROM entities WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = 'orphan.php'`,
    [project.id]
  );
  assert.equal(orphanEl.rows.length, 1);
  assert.equal(orphanEl.rows[0].data.render_status, "unknown_render");

  const renderedOn = await linksFrom(orphanEl.rows[0].id, "RENDERED_ON");
  assert.equal(renderedOn.length, 0, "no fabricated RENDERED_ON target -- REQ-026's spirit");
});

test("REQ-027: identity incomplete -> DEFINED_BY/RENDERED_ON misses are marked 'unresolved' (never a fabricated link, entity_links.dst_id is NOT NULL)", async () => {
  const UNRES_PROJECT = "ui_relations_unresolved_fixture";
  await cleanupTestProject(UNRES_PROJECT);
  const unresDir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-rel-unres-"));
  try {
    fs.writeFileSync(path.join(unresDir, "admin.php"), `<?php
class Admin_Page {
  public function boot() {
    add_menu_page( 'My Page Title', 'My Menu', 'manage_options', 'my-slug', array( $this, 'render_page' ) );
  }
  public function render_page() {
    submit_button( 'Save Changes' );
  }
}
`);
    const stats1 = await indexProject(UNRES_PROJECT, unresDir);
    assert.equal(stats1.failed, 0, JSON.stringify(stats1));
    assert.equal(stats1.identityPreflight.complete, true);

    // Force a genuine backfill failure on Admin_Page::render_page specifically
    // -- same collision trick test/identity.preflight.test.js uses: two
    // symbol rows sharing one pre-set symbol_key, so backfillProjectIdentity's
    // single-statement upsert throws for real (not mocked) and both stay
    // entity_id IS NULL. The file's content is left unchanged, so the normal
    // per-file hash-skip means this corruption survives into the next run's
    // identity preflight untouched.
    const project = await getProject(UNRES_PROJECT);
    const syms = await pool.query(
      `SELECT s.id, s.name FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.project_id = $1 AND f.path = 'admin.php' AND s.name IN ('Admin_Page::render_page', 'Admin_Page::boot')`,
      [project.id]
    );
    assert.equal(syms.rows.length, 2);
    const ids = syms.rows.map((r) => r.id);
    await pool.query(
      `UPDATE symbols SET entity_id = NULL, symbol_key = 'admin.php#collision' WHERE id = ANY($1)`,
      [ids]
    );

    const stats2 = await indexProject(UNRES_PROJECT, unresDir);
    assert.equal(stats2.failed, 0, JSON.stringify(stats2), "the overall index_project job must still complete");
    assert.equal(stats2.identityPreflight.complete, false, "backfill should genuinely fail on the collision");
    assert.ok(stats2.uiRelations && !stats2.uiRelations.error, JSON.stringify(stats2.uiRelations));

    const els = await pool.query(
      `SELECT id, data FROM entities WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = 'admin.php'`,
      [project.id]
    );
    assert.equal(els.rows.length, 1);
    assert.equal(els.rows[0].data.defined_by_status, "unresolved");
    assert.equal(els.rows[0].data.render_status, "unresolved");

    const definedBy = await linksFrom(els.rows[0].id, "DEFINED_BY");
    assert.equal(definedBy.length, 0, "no DEFINED_BY row when the target symbol has no entity_id -- entity_links.dst_id is NOT NULL");
    const renderedOn = await linksFrom(els.rows[0].id, "RENDERED_ON");
    assert.equal(renderedOn.length, 0);
  } finally {
    await cleanupTestProject(UNRES_PROJECT);
    fs.rmSync(unresDir, { recursive: true, force: true });
  }
});

test("storage plane: only entities/entity_links are touched, symbols/edges untouched", async () => {
  const project = await getProject(PROJECT);
  const symbolRows = await pool.query(
    `SELECT count(*)::int AS n FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND (s.kind LIKE 'ui%' OR s.kind = 'component')`,
    [project.id]
  );
  assert.equal(symbolRows.rows[0].n, 0);
});

test("REQ-022: config.uiEnabled = false leaves uiRelations null and skips the whole post-pass", async () => {
  const prev = config.uiEnabled;
  config.uiEnabled = false;
  try {
    const stats = await indexProject(PROJECT, dir);
    assert.equal(stats.failed, 0, JSON.stringify(stats));
    assert.equal(stats.uiRelations, null);
  } finally {
    config.uiEnabled = prev;
  }
});

test("recompute in full: removing the hook fire drops HANDLED_BY on the next index, re-adding it restores it", async () => {
  fs.writeFileSync(path.join(dir, "admin.php"), `<?php
class Admin_Page {
  public function boot() {
    add_menu_page( 'My Page Title', 'My Menu', 'manage_options', 'my-slug', array( $this, 'render_page' ) );
  }
  public function render_page() {
    do_settings_sections( 'my-page' );
    submit_button( 'Save Changes' );
  }
}
`);
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));

  const comps = await entity("ui_component", "admin.php", "Admin_Page::render_page");
  const handledBy = await linksFrom(comps[0].id, "HANDLED_BY");
  assert.equal(handledBy.length, 0, "HANDLED_BY should be gone once the firing call site is removed");

  // restore the fixture for repeatability
  writeFixture();
  const stats2 = await indexProject(PROJECT, dir);
  assert.equal(stats2.failed, 0, JSON.stringify(stats2));
  const comps2 = await entity("ui_component", "admin.php", "Admin_Page::render_page");
  const handledBy2 = await linksFrom(comps2[0].id, "HANDLED_BY");
  assert.equal(handledBy2.length, 1, "HANDLED_BY should be restored once the fire call site returns");
});
