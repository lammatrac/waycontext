import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";
import { config } from "../src/config.js";

// End-to-end proof that a real indexProject run resolves the Gutenberg
// static block-registration graph (phase 1B-2: REQ-024, AC-016): a generic
// `block` entity keyed project-wide by namespace, a `block_manifest` entity
// representing block.json itself, DEFINED_IN (block -> block_manifest) and
// RENDERED_BY (block -> render callback symbol, same-file-only scope,
// mirroring shortcode's own RENDERED_BY), and no fabricated relation/entity
// when block.json is missing, unparseable, or the resolved path would
// escape the project root. Extraction logic itself is covered directly in
// test/ui.phpBlocks.test.js.

const PROJECT = "ui_blocks_fixture";
let dir;
let decoyDir;

async function blockEntity(namespace) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, natural_key, title, data, deleted_at
       FROM entities
      WHERE project_id = $1 AND kind = 'block' AND data->>'namespace' = $2`,
    [project.id, namespace]
  );
  return res.rows[0] || null;
}

async function blockManifestEntity(blockJsonPath) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, natural_key, title, data, deleted_at
       FROM entities
      WHERE project_id = $1 AND kind = 'block_manifest' AND data->>'path' = $2`,
    [project.id, blockJsonPath]
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
  // AC-016's own worked example, almost verbatim: register_block_type with
  // a block.json declaring namespace "waycontext/pricing", render_callback
  // resolving in the same file.
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.writeFileSync(path.join(dir, "build", "block.json"), JSON.stringify({
    name: "waycontext/pricing", title: "Pricing", category: "widgets", textdomain: "waycontext",
  }));
  fs.writeFileSync(path.join(dir, "blocks.php"), `<?php
function waycontext_register_blocks() {
  register_block_type( __DIR__ . '/build', array( 'render_callback' => 'render_pricing_block' ) );
}
function render_pricing_block( $attributes ) {
  return '<div class="wc-pricing"></div>';
}
`);

  // A block whose render callback is defined in a DIFFERENT file: DEFINED_IN
  // must still resolve (block.json is found in-file, right where the call
  // site says it is) but RENDERED_BY must NOT (same-file-only scope
  // decision, mirroring shortcode's own RENDERED_BY).
  fs.mkdirSync(path.join(dir, "cross-build"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cross-build", "block.json"), JSON.stringify({ name: "waycontext/cross-file" }));
  fs.writeFileSync(path.join(dir, "cross-file-block.php"), `<?php
function register_cross_file_block() {
  register_block_type( __DIR__ . '/cross-build', array( 'render_callback' => 'render_cross_file_block' ) );
}
`);
  fs.writeFileSync(path.join(dir, "cross-file-callback.php"), `<?php
function render_cross_file_block() {
  return '<div></div>';
}
`);

  // A registration whose resolved directory names a block.json that simply
  // doesn't exist on disk -- no entity of any kind should be produced
  // (REQ-026/Q-018's no-fabrication rule; there is no namespace to key one
  // on).
  fs.writeFileSync(path.join(dir, "missing-block.php"), `<?php
function register_missing_block() {
  register_block_type( __DIR__ . '/does-not-exist', array( 'render_callback' => 'render_missing_block' ) );
}
function render_missing_block() {
  return '<div></div>';
}
`);

  // A resolved path pointing DIRECTLY at a block.json file (not a
  // directory) -- the ".json"-suffix branch of the path resolution.
  fs.mkdirSync(path.join(dir, "direct"), { recursive: true });
  fs.writeFileSync(path.join(dir, "direct", "block.json"), JSON.stringify({ name: "waycontext/direct" }));
  fs.writeFileSync(path.join(dir, "direct-block.php"), `<?php
function register_direct_block() {
  register_block_type( __DIR__ . '/direct/block.json', array( 'render_callback' => 'render_direct_block' ) );
}
function render_direct_block() {
  return '<div></div>';
}
`);

  // A root-boundary escape attempt: a block.json genuinely exists at the
  // resolved filesystem target, but that target sits OUTSIDE the project
  // root -- the root-boundary check must refuse to read it regardless (see
  // contracts.md "Phase 1B-2" / plan.md "Security note"). Computed
  // dynamically since decoyDir's path is only known at test time.
  const escapeRel = path.posix.join(
    path.relative(dir, decoyDir).split(path.sep).join("/"),
  );
  fs.writeFileSync(path.join(dir, "escaping-block.php"), `<?php
function register_escaping_block() {
  register_block_type( __DIR__ . '/${escapeRel}', array( 'render_callback' => 'render_escaping_block' ) );
}
function render_escaping_block() {
  return '<div></div>';
}
`);
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-blocks-"));
  decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-blocks-decoy-"));
  fs.writeFileSync(path.join(decoyDir, "block.json"), JSON.stringify({ name: "evil/escaped" }));
  writeFixture();
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (decoyDir) fs.rmSync(decoyDir, { recursive: true, force: true });
  await pool.end();
});

test("AC-016/REQ-024: register_block_type + block.json declaring a namespace produces a generic block entity with DEFINED_IN and RENDERED_BY", async () => {
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));
  assert.ok(stats.blocks && !stats.blocks.error, JSON.stringify(stats.blocks));

  const block = await blockEntity("waycontext/pricing");
  assert.ok(block, "block entity should exist");
  assert.equal(block.data.namespace, "waycontext/pricing");
  assert.equal(block.data.title, "Pricing");
  assert.equal(block.data.category, "widgets");
  assert.equal(block.data.textdomain, "waycontext");
  assert.equal(block.data.framework, "php");
  assert.equal(block.natural_key, block.data.block_id);
  // REQ-024/REQ-025: generic kind, never "ui_block".
  const kindRes = await pool.query(`SELECT kind FROM entities WHERE id = $1`, [block.id]);
  assert.equal(kindRes.rows[0].kind, "block");

  const manifest = await blockManifestEntity("build/block.json");
  assert.ok(manifest, "block_manifest entity should exist for build/block.json");
  assert.equal(manifest.data.path, "build/block.json");

  const links = await linksOf(block.id);
  const definedIn = links.find((l) => l.relation === "DEFINED_IN");
  const renderedBy = links.find((l) => l.relation === "RENDERED_BY");
  assert.ok(definedIn, "block should have a DEFINED_IN link to block_manifest");
  assert.equal(definedIn.dst_id, manifest.id);
  assert.ok(renderedBy, "block should have a RENDERED_BY link");

  const renderingSymbol = await symbolEntity("render_pricing_block", "blocks.php");
  assert.equal(renderedBy.dst_id, renderingSymbol);

  // AC-016: no persisted-instance entity/data of any kind is produced.
  assert.equal(block.data.resolution_status, undefined,
    "resolution_status ('data_owned') is never written for a static block registration");
});

test("DEFINED_IN resolves even when RENDERED_BY doesn't (cross-file render_callback, same-file-only scope decision)", async () => {
  const block = await blockEntity("waycontext/cross-file");
  assert.ok(block, "block entity should exist");

  const links = await linksOf(block.id);
  assert.ok(links.find((l) => l.relation === "DEFINED_IN"), "block.json was found in-file, DEFINED_IN should resolve");
  assert.equal(links.filter((l) => l.relation === "RENDERED_BY").length, 0,
    "render_callback is defined in a different file -- must NOT resolve (same-file-only scope decision)");
});

test("REQ-026/Q-018: a registration whose block.json doesn't exist on disk produces no entity at all", async () => {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM entities
      WHERE project_id = $1 AND kind = 'block_site' AND data->>'source_path' = 'missing-block.php'`,
    [project.id]
  );
  assert.equal(res.rows[0].n, 0, "no block_site row for a call site whose block.json is missing");
});

test("a resolved path already naming block.json directly (not just a directory) is read correctly", async () => {
  const block = await blockEntity("waycontext/direct");
  assert.ok(block, "block entity should exist for the direct block.json path form");
  const manifest = await blockManifestEntity("direct/block.json");
  assert.ok(manifest);
  const links = await linksOf(block.id);
  assert.ok(links.find((l) => l.relation === "DEFINED_IN" && l.dst_id === manifest.id));
});

test("root-boundary check: a resolved path escaping the project root is never read, even though a real block.json exists there", async () => {
  const escaped = await blockEntity("evil/escaped");
  assert.equal(escaped, null, "a block.json outside the project root must never be read, regardless of dirArg content");

  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM entities
      WHERE project_id = $1 AND kind = 'block_site' AND data->>'source_path' = 'escaping-block.php'`,
    [project.id]
  );
  assert.equal(res.rows[0].n, 0);
});

test("storage plane: only entities/entity_links are touched for block wiring, symbols/edges untouched", async () => {
  const project = await getProject(PROJECT);
  const symbolRows = await pool.query(
    `SELECT count(*)::int AS n FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND s.kind LIKE 'block%'`,
    [project.id]
  );
  assert.equal(symbolRows.rows[0].n, 0);
});

test("removing a block's only registration site tombstones both block and block_manifest, and re-adding it un-tombstones on next index", async () => {
  fs.rmSync(path.join(dir, "blocks.php"));
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));

  const block = await blockEntity("waycontext/pricing");
  assert.ok(block, "block entity row should still exist");
  assert.ok(block.deleted_at !== null, "block with no remaining live site should be tombstoned");

  const manifest = await blockManifestEntity("build/block.json");
  assert.ok(manifest.deleted_at !== null, "block_manifest with no remaining live reference should be tombstoned too");

  // restore the fixture for repeatability
  writeFixture();
  const stats2 = await indexProject(PROJECT, dir);
  assert.equal(stats2.failed, 0, JSON.stringify(stats2));
  const blockAgain = await blockEntity("waycontext/pricing");
  assert.equal(blockAgain.deleted_at, null, "block should un-tombstone once its site returns");
});

test("config.uiEnabled = false: no block extraction/resolution runs at all", async () => {
  const DISABLED_PROJECT = "ui_blocks_disabled_fixture";
  await cleanupTestProject(DISABLED_PROJECT);
  const disabledDir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-blocks-off-"));
  const prev = config.uiEnabled;
  config.uiEnabled = false;
  try {
    fs.mkdirSync(path.join(disabledDir, "build"), { recursive: true });
    fs.writeFileSync(path.join(disabledDir, "build", "block.json"), JSON.stringify({ name: "waycontext/pricing" }));
    fs.writeFileSync(path.join(disabledDir, "blocks.php"), `<?php
function waycontext_register_blocks() {
  register_block_type( __DIR__ . '/build', array( 'render_callback' => 'render_pricing_block' ) );
}
function render_pricing_block() {
  return '<div></div>';
}
`);
    const stats = await indexProject(DISABLED_PROJECT, disabledDir);
    assert.equal(stats.failed, 0, JSON.stringify(stats));
    assert.equal(stats.blocks, null);

    const project = await getProject(DISABLED_PROJECT);
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM entities WHERE project_id = $1 AND kind IN ('block', 'block_manifest', 'block_site') AND deleted_at IS NULL`,
      [project.id]
    );
    assert.equal(count.rows[0].n, 0);
  } finally {
    config.uiEnabled = prev;
    await cleanupTestProject(DISABLED_PROJECT);
    fs.rmSync(disabledDir, { recursive: true, force: true });
  }
});
