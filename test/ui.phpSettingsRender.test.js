import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPhpSettingsRenderSites } from "../src/ui/phpSettingsRender.js";

// Unit tests for the pure, DB-free do_settings_sections() call-site
// extraction function (phase 1A-6, REQ-018 completion). Project-wide
// cross-file CONTAINS resolution through indexProject (entities +
// entity_links writes, tombstone lifecycle) lives in
// test/indexer.uiRelations.test.js.

test("REQ-018: do_settings_sections() with a literal $page is recognized, owner is the enclosing function", () => {
  const src = `<?php
function render_page() {
  do_settings_sections( 'my-page' );
}
`;
  const sites = extractPhpSettingsRenderSites(src);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].page, "my-page");
  assert.equal(sites[0].owner, "render_page");
});

test("owner is qualified Class::method inside a class body", () => {
  const src = `<?php
class Admin_Page {
  public function render_page() {
    do_settings_sections( 'my-page' );
  }
}
`;
  const sites = extractPhpSettingsRenderSites(src);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].owner, "Admin_Page::render_page");
});

test("top-level call site gets the @file owner sentinel", () => {
  const src = `<?php
do_settings_sections( 'my-page' );
`;
  const sites = extractPhpSettingsRenderSites(src);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].owner, "@file");
});

test("REQ-026/Q-003: a dynamic (non-literal) $page is skipped entirely -- no fabricated entity", () => {
  const src = `<?php
function render_page( $page ) {
  do_settings_sections( $page );
}
`;
  const sites = extractPhpSettingsRenderSites(src);
  assert.equal(sites.length, 0);
});

test("multiple call sites in one file are all recognized", () => {
  const src = `<?php
function render_a() { do_settings_sections( 'page-a' ); }
function render_b() { do_settings_sections( 'page-b' ); }
`;
  const sites = extractPhpSettingsRenderSites(src);
  assert.equal(sites.length, 2);
  assert.deepEqual(sites.map((s) => s.page).sort(), ["page-a", "page-b"]);
});
