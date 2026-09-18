import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";

// End-to-end proof that a real indexProject run resolves the WordPress hook
// graph project-wide (phase 1A-3: REQ-014, REQ-026, EDGE-012): `hook`
// entities, LISTENS_TO/FIRED_BY entity_links across file boundaries, and no
// fabricated relation target when the firer/listener isn't part of the
// indexed project. Extraction logic itself is covered directly in
// test/ui.phpHooks.test.js.

const PROJECT = "ui_hooks_fixture";
let dir;

async function hookEntity(hookName) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, natural_key, title, data, deleted_at
       FROM entities
      WHERE project_id = $1 AND kind = 'hook' AND data->>'name' = $2`,
    [project.id, hookName]
  );
  return res.rows[0] || null;
}

async function linksOf(entityId) {
  const res = await pool.query(
    `SELECT relation, src_id, dst_id FROM entity_links WHERE src_id = $1 OR dst_id = $1`,
    [entityId]
  );
  return res.rows;
}

async function symbolEntity(name, filePath) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT s.entity_id FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND f.path = $2 AND s.name = $3`,
    [project.id, filePath, name]
  );
  return res.rows[0]?.entity_id || null;
}

function writeFixture() {
  // EDGE-012: a theme fires `do_action('woocommerce_before_cart')` in one
  // file; a different plugin file (WooCommerce) supplies the callback
  // registered via add_action, in a THIRD file entirely. Project-wide
  // resolution must connect all three despite no two of them sharing a file.
  fs.writeFileSync(path.join(dir, "theme-template.php"), `<?php
function render_cart_page() {
  do_action( 'woocommerce_before_cart' );
}
`);
  fs.writeFileSync(path.join(dir, "woocommerce-cart.php"), `<?php
class WC_Cart {
  public function boot() {
    add_action( 'woocommerce_before_cart', array( $this, 'render_notice' ) );
  }
  public function render_notice() {}
}
`);
  // A hook fired only by WordPress core (never indexed) must get no
  // FIRED_BY at all -- REQ-026/Q-018's no-fabrication rule.
  fs.writeFileSync(path.join(dir, "plugin-init.php"), `<?php
function my_plugin_boot() {
  add_action( 'init', 'my_plugin_init' );
}
function my_plugin_init() {}
`);
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-hooks-"));
  writeFixture();
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("EDGE-012: hook fired by one file and listened to by a callback in a different file resolves project-wide", async () => {
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));
  assert.ok(stats.hooks && !stats.hooks.error, JSON.stringify(stats.hooks));

  const hook = await hookEntity("woocommerce_before_cart");
  assert.ok(hook, "hook entity should exist");
  assert.equal(hook.data.framework, "php");
  assert.equal(hook.natural_key, hook.data.hook_id);

  const links = await linksOf(hook.id);
  const firedBy = links.find((l) => l.relation === "FIRED_BY");
  const listensTo = links.find((l) => l.relation === "LISTENS_TO");
  assert.ok(firedBy, "hook should be FIRED_BY the theme's render_cart_page");
  assert.ok(listensTo, "hook should be LISTENS_TO WC_Cart::render_notice");

  const firingSymbol = await symbolEntity("render_cart_page", "theme-template.php");
  assert.equal(firedBy.dst_id, firingSymbol);

  const listeningSymbol = await symbolEntity("WC_Cart::render_notice", "woocommerce-cart.php");
  assert.equal(listensTo.src_id, listeningSymbol);
});

test("REQ-026/Q-018: a hook fired only by unindexed WordPress core gets no FIRED_BY, never a placeholder entity", async () => {
  const hook = await hookEntity("init");
  assert.ok(hook, "hook entity should still exist (it IS listened to, in-project)");

  const links = await linksOf(hook.id);
  assert.equal(links.filter((l) => l.relation === "FIRED_BY").length, 0);
  assert.ok(links.find((l) => l.relation === "LISTENS_TO"), "listen side should still resolve");
});

test("storage plane: only entities/entity_links are touched for hook wiring, symbols/edges untouched", async () => {
  const project = await getProject(PROJECT);
  const symbolRows = await pool.query(
    `SELECT count(*)::int AS n FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND s.kind LIKE 'hook%'`,
    [project.id]
  );
  assert.equal(symbolRows.rows[0].n, 0);
});

test("removing a hook's only listen/fire site tombstones it, and re-adding it un-tombstones on next index", async () => {
  fs.writeFileSync(path.join(dir, "plugin-init.php"), `<?php
function my_plugin_boot() {}
`);
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));

  const hook = await hookEntity("init");
  assert.ok(hook, "hook entity row should still exist");
  assert.ok(hook.deleted_at !== null, "hook with no remaining live site should be tombstoned");

  // restore the fixture for repeatability
  writeFixture();
  const stats2 = await indexProject(PROJECT, dir);
  assert.equal(stats2.failed, 0, JSON.stringify(stats2));
  const hookAgain = await hookEntity("init");
  assert.equal(hookAgain.deleted_at, null, "hook should un-tombstone once its site returns");
});
