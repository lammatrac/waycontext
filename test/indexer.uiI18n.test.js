import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, initDb, getProject } from "../src/db.js";
import { indexProject } from "../src/indexer.js";
import { cleanupTestProject } from "./helpers/testProject.js";

// End-to-end proof that a real indexProject run resolves WordPress gettext
// i18n keys against the project's .po catalogs (phase 1A-4: REQ-003,
// REQ-004, EDGE-004, EDGE-005): `i18n_key` entities, TRANSLATION_OF/
// TRANSLATION_USED_AT entity_links, and the consuming `ui_element`'s
// text/text_source update. Extraction logic itself is covered directly in
// test/ui.phpI18nCalls.test.js and test/ui.i18nCatalog.test.js.

const PROJECT = "ui_i18n_fixture";
let dir;

async function i18nKeyEntity(msgid) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, natural_key, title, data, deleted_at
       FROM entities
      WHERE project_id = $1 AND kind = 'i18n_key' AND data->>'msgid' = $2`,
    [project.id, msgid]
  );
  return res.rows[0] || null;
}

async function uiElementByText(matchText) {
  const project = await getProject(PROJECT);
  const res = await pool.query(
    `SELECT id, data FROM entities
      WHERE project_id = $1 AND kind = 'ui_element' AND deleted_at IS NULL
        AND data->>'i18n_key' = $2`,
    [project.id, matchText]
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

const PO_VI = `msgid ""
msgstr ""
"Language: vi\\n"
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Save"
msgstr "Lưu"

msgid "Operation failed"
msgstr "Thao tác thất bại"
`;

function writeFixture() {
  fs.mkdirSync(path.join(dir, "languages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "languages", "my-textdomain-vi.po"), PO_VI);

  fs.writeFileSync(path.join(dir, "settings.php"), `<?php
class Settings {
  public function render_save_button() {
    echo '<button>' . esc_html__( 'Save', 'my-textdomain' ) . '</button>';
  }
  public function render_missing_key() {
    echo '<label>' . esc_html__( 'Untranslated Label', 'my-textdomain' ) . '</label>';
  }
  public function log_message() {
    $msg = __( 'Operation failed', 'my-textdomain' );
    return $msg;
  }
}
`);
}

before(async () => {
  await initDb();
  await cleanupTestProject(PROJECT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codectx-ui-i18n-"));
  writeFixture();
});

after(async () => {
  await cleanupTestProject(PROJECT);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

test("REQ-003/REQ-004: a catalog-resolved key upgrades the ui_element's text/text_source and links TRANSLATION_OF", async () => {
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));
  assert.ok(stats.i18n && !stats.i18n.error, JSON.stringify(stats.i18n));

  const key = await i18nKeyEntity("Save");
  assert.ok(key, "i18n_key entity should exist");
  assert.equal(key.data.textdomain, "my-textdomain");
  assert.equal(key.data.resolved_text, "Lưu");
  assert.equal(key.data.translations.vi, "Lưu");
  assert.equal(key.natural_key, key.data.i18n_key_id);

  const el = await uiElementByText("Save");
  assert.ok(el, "ui_element with i18n_key 'Save' should exist");
  assert.equal(el.data.text, "Lưu", "translated catalog value should outrank the literal msgid reconstruction");
  assert.equal(el.data.text_source, "translated_catalog_value");

  const links = await linksOf(key.id);
  const translationOf = links.find((l) => l.relation === "TRANSLATION_OF" && l.src_id === el.id);
  assert.ok(translationOf, "ui_element should be TRANSLATION_OF the i18n_key");

  const usedAt = links.find((l) => l.relation === "TRANSLATION_USED_AT");
  assert.ok(usedAt, "i18n_key should be TRANSLATION_USED_AT the usage-site symbol");
  const usageSymbol = await symbolEntity("Settings::render_save_button", "settings.php");
  assert.equal(usedAt.dst_id, usageSymbol);
});

test("EDGE-004: a key with no catalog entry indexes with visible_text=null, text_source='translation_key', as a normal non-error state", async () => {
  const key = await i18nKeyEntity("Untranslated Label");
  assert.ok(key, "i18n_key entity should still be created even without a catalog entry");
  assert.deepEqual(key.data.translations, {});
  assert.equal(key.data.resolved_text, null);

  const el = await uiElementByText("Untranslated Label");
  assert.ok(el, "ui_element should still exist");
  assert.equal(el.data.text, null);
  assert.equal(el.data.text_source, "translation_key");
});

test("REQ-004: a standalone i18n call not tied to any ui_element still gets an i18n_key + TRANSLATION_USED_AT (generic, not UI-only)", async () => {
  const key = await i18nKeyEntity("Operation failed");
  assert.ok(key, "i18n_key entity should exist for a call site with no consuming ui_element");
  assert.equal(key.data.resolved_text, "Thao tác thất bại");

  const links = await linksOf(key.id);
  assert.equal(links.filter((l) => l.relation === "TRANSLATION_OF").length, 0, "no ui_element consumes this key");
  const usedAt = links.find((l) => l.relation === "TRANSLATION_USED_AT");
  assert.ok(usedAt, "usage site should still resolve");
  const usageSymbol = await symbolEntity("Settings::log_message", "settings.php");
  assert.equal(usedAt.dst_id, usageSymbol);
});

test("storage plane: only entities/entity_links are touched for i18n wiring, symbols/edges untouched", async () => {
  const project = await getProject(PROJECT);
  const symbolRows = await pool.query(
    `SELECT count(*)::int AS n FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.project_id = $1 AND s.kind LIKE 'i18n%'`,
    [project.id]
  );
  assert.equal(symbolRows.rows[0].n, 0);
});

test("removing a key's only call site tombstones its i18n_key, and re-adding it un-tombstones on next index", async () => {
  fs.writeFileSync(path.join(dir, "settings.php"), `<?php
class Settings {
  public function render_save_button() {
    echo '<button>Static Save</button>';
  }
}
`);
  const stats = await indexProject(PROJECT, dir);
  assert.equal(stats.failed, 0, JSON.stringify(stats));

  const key = await i18nKeyEntity("Save");
  assert.ok(key, "i18n_key entity row should still exist");
  assert.ok(key.deleted_at !== null, "key with no remaining live call site should be tombstoned");

  // restore the fixture for repeatability
  writeFixture();
  const stats2 = await indexProject(PROJECT, dir);
  assert.equal(stats2.failed, 0, JSON.stringify(stats2));
  const keyAgain = await i18nKeyEntity("Save");
  assert.equal(keyAgain.deleted_at, null, "key should un-tombstone once its call site returns");
});
