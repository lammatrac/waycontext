import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPhpShortcodes } from "../src/ui/phpShortcodes.js";

// Unit tests for the pure, DB-free shortcode call-site extraction function
// (phase 1B-1: REQ-023). Project-wide `shortcode` entity / REGISTERED_AT /
// RENDERED_BY resolution through indexProject lives in
// test/indexer.uiShortcodes.test.js.

test("REQ-023: add_shortcode() with a literal tag and string callback is recognized", () => {
  const src = `<?php
add_shortcode( 'members', 'render_members' );
`;
  const shortcodes = extractPhpShortcodes(src);
  assert.equal(shortcodes.length, 1);
  assert.equal(shortcodes[0].tag, "members");
  assert.equal(shortcodes[0].callback, "render_members");
  assert.equal(shortcodes[0].owner, "@file");
});

test("REQ-023: add_shortcode() resolves an array($this, 'method') callback relative to its enclosing class", () => {
  const src = `<?php
class Members {
  public function boot() {
    add_shortcode( 'members', array( $this, 'render' ) );
  }
}
`;
  const shortcodes = extractPhpShortcodes(src);
  assert.equal(shortcodes.length, 1);
  assert.equal(shortcodes[0].tag, "members");
  assert.equal(shortcodes[0].callback, "Members::render");
  assert.equal(shortcodes[0].owner, "Members::boot");
});

test("REQ-023: array(__CLASS__, 'method') and array('LiteralClass', 'method') callbacks resolve", () => {
  const src = `<?php
class Members {
  public static function boot() {
    add_shortcode( 'members_a', array( __CLASS__, 'render_a' ) );
    add_shortcode( 'members_b', array( 'Members', 'render_b' ) );
  }
}
`;
  const shortcodes = extractPhpShortcodes(src);
  assert.equal(shortcodes.length, 2);
  assert.equal(shortcodes[0].callback, "Members::render_a");
  assert.equal(shortcodes[1].callback, "Members::render_b");
});

test("REQ-026/Q-003: a dynamic (non-literal) tag is skipped entirely -- no fabricated entity", () => {
  const src = `<?php
add_shortcode( $tag_name, 'render_members' );
`;
  const shortcodes = extractPhpShortcodes(src);
  assert.equal(shortcodes.length, 0);
});

test("REQ-026: an unresolvable callback (a variable object) is recorded with callback null, never fabricated", () => {
  const src = `<?php
add_shortcode( 'members', array( $obj, 'method' ) );
`;
  const shortcodes = extractPhpShortcodes(src);
  assert.equal(shortcodes.length, 1);
  assert.equal(shortcodes[0].callback, null);
});

test("owner is the enclosing function, or the '@file' sentinel for a top-level call", () => {
  const src = `<?php
function register_shortcodes() {
  add_shortcode( 'members', 'render_members' );
}
add_shortcode( 'top_level', 'render_top_level' );
`;
  const shortcodes = extractPhpShortcodes(src);
  assert.equal(shortcodes.length, 2);
  assert.equal(shortcodes[0].owner, "register_shortcodes");
  assert.equal(shortcodes[1].owner, "@file");
});

test("do_shortcode() is not recognized -- REQ-023 only names registration, no firing side", () => {
  const src = `<?php
add_shortcode( 'members', 'render_members' );
echo do_shortcode( '[members]' );
`;
  const shortcodes = extractPhpShortcodes(src);
  assert.equal(shortcodes.length, 1);
  assert.equal(shortcodes[0].tag, "members");
});
