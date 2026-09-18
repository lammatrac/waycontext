import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";
import { config } from "../src/config.js";

// End-to-end proof that a real indexProject run resolves the WordPress
// shortcode graph (phase 1B-1: REQ-023, AC-015): a generic `shortcode`
// entity, REGISTERED_AT/RENDERED_BY entity_links, same-file-only relation
// scope (deliberately NOT project-wide, unlike hook's LISTENS_TO), and no
// fabricated relation target when the callback isn't in the indexed
// project. Extraction logic itself is covered directly in
// test/ui.phpShortcodes.test.js.

const PROJECT = "ui_shortcodes_fixture";
let dir;

async function shortcodeEntity(tag) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, natural_key, title, data, deleted_at
       FROM entities
      WHERE project_id = $1 AND kind = 'shortcode' AND data->>'tag' = $2`,
    [project.id, tag]
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
  // AC-015's own worked example, almost verbatim: add_shortcode('members',
  // 'render_members'), registered from a named function so REGISTERED_AT
  // resolves to a real symbol rather than the "@file" sentinel.
  fs.writeFileSync(path.join(dir, "members.php"), `<?php
function register_members_shortcode() {
  add_shortcode( 'members', 'render_members' );
}
function render_members() {
  return '[members]';
}
`);
  // A shortcode whose callback is only defined outside the indexed project
  // (WordPress core, or simply never indexed) must get no RENDERED_BY at
  // all -- REQ-026/Q-018's no-fabrication rule.
  fs.writeFileSync(path.join(dir, "orphan.php"), `<?php
function register_orphan_shortcode() {
  add_shortcode( 'orphan', 'render_orphan_elsewhere' );
}
`);
  // A shortcode whose render callback is defined in a DIFFERENT file: this
  // phase's own design decision is same-file-only resolution for
  // REGISTERED_AT/RENDERED_BY (unlike hook's project-wide LISTENS_TO) -- so
  // this must resolve REGISTERED_AT (same file as the add_shortcode() call)
  // but NOT RENDERED_BY (callback lives in another file).
  fs.writeFileSync(path.join(dir, "cross-file.php"), `<?php
function register_cross_file_shortcode() {
  add_shortcode( 'cross_file', 'render_cross_file' );
}
`);
  fs.writeFileSync(path.join(dir, "cross-file-callback.php"), `<?php
function render_cross_file() {
  return '[cross file]';
}
`);
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-shortcodes-"));
  writeFixture();
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("AC-015/REQ-023: add_shortcode('members', 'render_members') produces a generic shortcode entity with REGISTERED_AT and RENDERED_BY", async () => {
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));
  assert.ok(stats.shortcodes && !stats.shortcodes.error, JSON.stringify(stats.shortcodes));

  const shortcode = await shortcodeEntity("members");
  assert.ok(shortcode, "shortcode entity should exist");
  assert.equal(shortcode.data.tag, "members");
  assert.equal(shortcode.data.framework, "php");
  assert.equal(shortcode.natural_key, shortcode.data.shortcode_id);
  // REQ-023/REQ-025: generic kind, never "ui_shortcode".
  const kindRes = await pool.query(`SELECT kind FROM entities WHERE id = $1`, [shortcode.id]);
  assert.equal(kindRes.rows[0].kind, "shortcode");

  const links = await linksOf(shortcode.id);
  const registeredAt = links.find((l) => l.relation === "REGISTERED_AT");
  const renderedBy = links.find((l) => l.relation === "RENDERED_BY");
  assert.ok(registeredAt, "shortcode should have a REGISTERED_AT link");
  assert.ok(renderedBy, "shortcode should have a RENDERED_BY link");

  const registeringSymbol = await symbolEntity("register_members_shortcode", "members.php");
  assert.equal(registeredAt.dst_id, registeringSymbol);

  const renderingSymbol = await symbolEntity("render_members", "members.php");
  assert.equal(renderedBy.dst_id, renderingSymbol);
});

test("REQ-026/Q-018: a shortcode whose callback isn't defined anywhere in the indexed project gets no RENDERED_BY, never a placeholder", async () => {
  const shortcode = await shortcodeEntity("orphan");
  assert.ok(shortcode, "shortcode entity should still exist (it IS registered)");

  const links = await linksOf(shortcode.id);
  assert.equal(links.filter((l) => l.relation === "RENDERED_BY").length, 0);
  assert.ok(links.find((l) => l.relation === "REGISTERED_AT"), "registration side should still resolve");
});

test("REGISTERED_AT/RENDERED_BY resolve same-file only, not project-wide (deliberate divergence from hook's LISTENS_TO)", async () => {
  const shortcode = await shortcodeEntity("cross_file");
  assert.ok(shortcode, "shortcode entity should exist");

  const links = await linksOf(shortcode.id);
  assert.ok(links.find((l) => l.relation === "REGISTERED_AT"), "registration is in the same file as the call, should resolve");
  assert.equal(links.filter((l) => l.relation === "RENDERED_BY").length, 0,
    "callback is defined in a different file -- must NOT resolve (same-file-only scope decision)");
});

test("storage plane: only entities/entity_links are touched for shortcode wiring, symbols/edges untouched", async () => {
  const project = await getProject(PROJECT);
  const symbolRows = await pool.query(
    `SELECT count(*)::int AS n FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND s.kind LIKE 'shortcode%'`,
    [project.id]
  );
  assert.equal(symbolRows.rows[0].n, 0);
});

test("removing a shortcode's only registration site tombstones it, and re-adding it un-tombstones on next index", async () => {
  fs.writeFileSync(path.join(dir, "members.php"), `<?php
function render_members() {
  return '[members]';
}
`);
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));

  const shortcode = await shortcodeEntity("members");
  assert.ok(shortcode, "shortcode entity row should still exist");
  assert.ok(shortcode.deleted_at !== null, "shortcode with no remaining live site should be tombstoned");

  // restore the fixture for repeatability
  writeFixture();
  const stats2 = await indexProject(PROJECT, dir);
  assert.equal(stats2.failed, 0, JSON.stringify(stats2));
  const shortcodeAgain = await shortcodeEntity("members");
  assert.equal(shortcodeAgain.deleted_at, null, "shortcode should un-tombstone once its site returns");
});

test("config.uiEnabled = false: no shortcode extraction/resolution runs at all", async () => {
  const DISABLED_PROJECT = "ui_shortcodes_disabled_fixture";
  await cleanupTestProject(DISABLED_PROJECT);
  const disabledDir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-shortcodes-off-"));
  const prev = config.uiEnabled;
  config.uiEnabled = false;
  try {
    fs.writeFileSync(path.join(disabledDir, "members.php"), `<?php
function register_members_shortcode() {
  add_shortcode( 'members', 'render_members' );
}
function render_members() {
  return '[members]';
}
`);
    const stats = await indexProject(DISABLED_PROJECT, disabledDir);
    assert.equal(stats.failed, 0, JSON.stringify(stats));
    assert.equal(stats.shortcodes, null);

    const project = await getProject(DISABLED_PROJECT);
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM entities WHERE project_id = $1 AND kind IN ('shortcode', 'shortcode_site') AND deleted_at IS NULL`,
      [project.id]
    );
    assert.equal(count.rows[0].n, 0);
  } finally {
    config.uiEnabled = prev;
    await cleanupTestProject(DISABLED_PROJECT);
    fs.rmSync(disabledDir, { recursive: true, force: true });
  }
});
