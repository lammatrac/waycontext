import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { config } from "../src/config.js";
import { findOperation, operations } from "../src/operations.js";
import {
  resolveUiReferenceOp, findUiElementOp, getUiContextOp, traceUiActionOp, findUiSourceOp,
} from "../src/ui/uiQueries.js";
import { cleanupTestProject } from "./helpers/testProject.js";

// End-to-end proof that phase 1A-8's five MCP operations
// (resolve_ui_reference, find_ui_element, get_ui_context, trace_ui_action,
// find_ui_source -- REQ-012, § 6.2.3) correctly compose the graph 1A-1..1A-7
// already resolved. Real DB, real indexProject() run, no mocking -- same
// convention as test/indexer.uiRelations.test.js and
// test/ui.referenceResolver.test.js.

const PROJECT = "ui_ops_fixture";
let dir;

function writeFixture() {
  // boot() is itself registered on 'admin_menu' -- gives find_ui_source's
  // "entry hook" (LISTENS_TO) something real to resolve, distinct from the
  // FIRED_BY-based hook naming trace_ui_action/get_ui_context use.
  fs.writeFileSync(path.join(dir, "admin.php"), `<?php
class Admin_Page {
  public function register() {
    add_action( 'admin_menu', array( $this, 'boot' ) );
  }
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
  fs.writeFileSync(path.join(dir, "listener.php"), `<?php
class Save_Handler {
  public function boot() {
    add_action( 'my_plugin_saved', array( $this, 'handle_save' ) );
  }
  public function handle_save() {
    log_save_event();
  }
}
function log_save_event() {}
`);
  // An element whose owning function is never used as any screen's renderer
  // -- exercises get_ui_context/trace_ui_action on a component with no
  // HANDLED_BY/RENDERED_ON at all.
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
  <button>Core Widget</button>
  <?php
}
`);
}

async function elementIdFor(sourcePath, textLike) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT data->>'element_id' AS element_id FROM entities
      WHERE project_id = $1 AND kind = 'ui_element' AND data->>'source_path' = $2
        AND data->>'text' = $3 AND deleted_at IS NULL`,
    [project.id, sourcePath, textLike]
  );
  assert.ok(res.rows.length, `no ui_element found for ${sourcePath}/${textLike}`);
  return res.rows[0].element_id;
}

async function naturalKeyFor(kind, sourcePath, ownerLike) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT natural_key FROM entities
      WHERE project_id = $1 AND kind = $2 AND data->>'source_path' = $3
        AND ($4::text IS NULL OR data->>'owner' = $4) AND deleted_at IS NULL`,
    [project.id, kind, sourcePath, ownerLike ?? null]
  );
  assert.ok(res.rows.length, `no ${kind} found for ${sourcePath}/${ownerLike}`);
  return res.rows[0].natural_key;
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-ops-"));
  writeFixture();
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));
  assert.ok(stats.uiRelations && !stats.uiRelations.error, JSON.stringify(stats.uiRelations));
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

// ---------------------------------------------------------------------------
// registry wiring
// ---------------------------------------------------------------------------

test("all five UI operations are registered, read-only, and reachable by name", () => {
  for (const name of ["resolve_ui_reference", "find_ui_element", "get_ui_context", "trace_ui_action", "find_ui_source"]) {
    const op = findOperation(name);
    assert.ok(op, `${name} not registered`);
    assert.equal(op.readOnly, true, `${name} must be readOnly`);
  }
  const writers = operations.filter((op) => !op.readOnly).map((op) => op.name);
  assert.ok(!writers.some((n) => n.startsWith("resolve_ui") || n.startsWith("find_ui") || n.startsWith("get_ui") || n.startsWith("trace_ui")));
});

// ---------------------------------------------------------------------------
// resolve_ui_reference
// ---------------------------------------------------------------------------

test("resolve_ui_reference: task_text resolves to the submit_button element, echoes `understood`", async () => {
  const result = await resolveUiReferenceOp(PROJECT, { taskText: 'The "Save Changes" button on the My Page Title screen is broken' });
  assert.equal(result.enabled, true);
  assert.ok(result.understood, "understood should be present when task_text was parsed");
  assert.ok(result.candidates.length >= 1);
  const top = result.candidates[0];
  assert.equal(top.visible_text, "Save Changes");
  assert.equal(top.application_source.path, "admin.php");
  assert.equal(top.not_relevant, undefined);
  assert.ok(["ok", "partial_match"].includes(result.status));
});

test("resolve_ui_reference: requires task_text or a hint", async () => {
  await assert.rejects(() => resolveUiReferenceOp(PROJECT, {}), /task_text or at least one/);
});

test("resolve_ui_reference: unknown project throws, not a status field", async () => {
  await assert.rejects(() => resolveUiReferenceOp("no_such_project_xyz", { text: "Save" }), /not found/i);
});

test("resolve_ui_reference: framework-owned candidate carries not_relevant, not application_source", async () => {
  // text alone (0.40) can't clear the 0.45 floor on its own (1A-7's
  // documented floor/weight interaction) -- add role so the candidate
  // actually surfaces.
  const result = await resolveUiReferenceOp(PROJECT, { text: "Core Widget", role: "button" });
  assert.equal(result.enabled, true);
  assert.ok(result.candidates.length >= 1);
  const top = result.candidates[0];
  assert.equal(top.application_source, null);
  assert.ok(top.not_relevant, "framework-owned candidate should carry not_relevant");
  assert.match(top.not_relevant.reason, /WordPress core|framework/i);
});

test("resolve_ui_reference: no match returns status not_found, not an error", async () => {
  const result = await resolveUiReferenceOp(PROJECT, { text: "Something Totally Unrelated Nonexistent Xyzzy" });
  assert.equal(result.enabled, true);
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.candidates, []);
});

test("resolve_ui_reference: disabled feature surfaces enabled:false distinctly from not_found", async () => {
  const prev = config.uiEnabled;
  config.uiEnabled = false;
  try {
    const result = await resolveUiReferenceOp(PROJECT, { text: "Save Changes" });
    assert.equal(result.enabled, false);
    assert.equal(result.status, "not_found");
  } finally {
    config.uiEnabled = prev;
  }
});

// ---------------------------------------------------------------------------
// find_ui_element
// ---------------------------------------------------------------------------

test("find_ui_element: structured text/screen hints only, no free-text parsing", async () => {
  const result = await findUiElementOp(PROJECT, "Save Changes", "My Page Title");
  assert.equal(result.enabled, true);
  assert.ok(result.candidates.length >= 1);
  assert.equal(result.candidates[0].visible_text, "Save Changes");
});

test("find_ui_element: requires text", async () => {
  await assert.rejects(() => findUiElementOp(PROJECT, "", undefined), /requires text/);
});

// ---------------------------------------------------------------------------
// get_ui_context
// ---------------------------------------------------------------------------

test("get_ui_context: composes component, screen, and handled_by hook chain for the submit button", async () => {
  const elementId = await elementIdFor("admin.php", "Save Changes");
  const ctx = await getUiContextOp(PROJECT, elementId);

  assert.equal(ctx.element.element_id, elementId);
  assert.equal(ctx.element.text, "Save Changes");

  assert.ok(ctx.component, "should resolve the owning ui_component");
  assert.equal(ctx.component.owner, "Admin_Page::render_page");
  assert.equal(ctx.component.ownership, "application");

  assert.ok(ctx.screens.length >= 1, "should resolve at least one screen via RENDERED_ON");
  assert.equal(ctx.screens[0].menu_slug, "my-slug");

  assert.ok(ctx.handled_by.length >= 1, "render_page fires my_plugin_saved, handled by Save_Handler::handle_save");
  assert.equal(ctx.handled_by[0].symbol.name, "Save_Handler::handle_save");
  assert.equal(ctx.handled_by[0].hook, "my_plugin_saved");
});

test("get_ui_context: element with no handler still resolves cleanly (empty handled_by)", async () => {
  const elementId = await elementIdFor("orphan.php", "Orphan");
  const ctx = await getUiContextOp(PROJECT, elementId);
  assert.ok(ctx.component);
  assert.deepEqual(ctx.handled_by, []);
});

test("get_ui_context: unknown element_id throws", async () => {
  await assert.rejects(() => getUiContextOp(PROJECT, "ui:ui_ops_fixture:php:nope.php:@file:deadbeefcafe"), /No UI element/);
});

// ---------------------------------------------------------------------------
// trace_ui_action
// ---------------------------------------------------------------------------

test("trace_ui_action: element -> hook -> callback -> onward call graph", async () => {
  const elementId = await elementIdFor("admin.php", "Save Changes");
  const trace = await traceUiActionOp(PROJECT, elementId);

  assert.equal(trace.status, "resolved");
  assert.equal(trace.handler.via, "hook_handled_by");
  assert.equal(trace.handler.hook, "my_plugin_saved");
  assert.equal(trace.handler.symbol.name, "Save_Handler::handle_save");

  assert.ok(trace.call_graph, "should reuse getSubgraph to walk onward from the resolved callback");
  assert.equal(trace.call_graph.root, "Save_Handler::handle_save");
  assert.ok(
    trace.call_graph.edges.some((e) => e.to === "log_save_event"),
    "onward call graph should reach handle_save's own callee"
  );
});

test("trace_ui_action: settings field traces via RENDERED_BY, not the hook graph", async () => {
  const fieldId = await naturalKeyFor("ui_settings_field", "settings.php", null);
  const trace = await traceUiActionOp(PROJECT, fieldId);
  assert.equal(trace.status, "resolved");
  assert.equal(trace.handler.via, "settings_rendered_by");
  assert.equal(trace.handler.symbol.name, "Settings_Page::render_field");
});

test("trace_ui_action: no resolvable handler reports status no_handler_found, not an error", async () => {
  const elementId = await elementIdFor("orphan.php", "Orphan");
  const trace = await traceUiActionOp(PROJECT, elementId);
  assert.equal(trace.status, "no_handler_found");
  assert.equal(trace.handler, null);
  assert.equal(trace.call_graph, null);
});

// ---------------------------------------------------------------------------
// find_ui_source
// ---------------------------------------------------------------------------

test("find_ui_source: submit_button element reports created_via, registration, and entry hook", async () => {
  const elementId = await elementIdFor("admin.php", "Save Changes");
  const src = await findUiSourceOp(PROJECT, elementId);

  assert.equal(src.source.path, "admin.php");
  assert.equal(src.ownership, "application");
  assert.ok(src.application_source);
  assert.equal(src.not_relevant, null);
  assert.equal(src.created_via, "submit_button");
});

test("find_ui_source: ui_screen reports registration_fn as created_via and its entry hook via LISTENS_TO", async () => {
  const screenId = await naturalKeyFor("ui_screen", "admin.php", "Admin_Page::boot");
  const src = await findUiSourceOp(PROJECT, screenId);

  assert.equal(src.created_via, "add_menu_page");
  assert.ok(src.registered_at, "should resolve REGISTERED_AT to the boot() symbol");
  assert.equal(src.registered_at.symbol, "Admin_Page::boot");
  assert.deepEqual(src.entry_hooks, ["admin_menu"], "boot() is itself registered on admin_menu via LISTENS_TO");
});

test("find_ui_source: framework-owned element gets not_relevant, never application_source", async () => {
  const elementId = await elementIdFor("wp-includes/core-widgets.php", "Core Widget");
  const src = await findUiSourceOp(PROJECT, elementId);
  assert.equal(src.ownership, "framework");
  assert.equal(src.application_source, null);
  assert.ok(src.not_relevant);
  assert.equal(src.not_relevant.path, "wp-includes/core-widgets.php");
});

test("find_ui_source: unknown element_id throws", async () => {
  await assert.rejects(() => findUiSourceOp(PROJECT, "ui:ui_ops_fixture:php:nope.php:@file:deadbeefcafe"), /No UI element/);
});
