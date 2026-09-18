import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPhpI18nCalls } from "../src/ui/phpI18nCalls.js";

// Unit tests for the pure, DB-free i18n call-site extraction function
// (phase 1A-4: REQ-003/REQ-004). Project-wide catalog resolution + entity/
// entity_links writes through indexProject live in test/indexer.uiI18n.test.js.

test("REQ-004: __() with msgid and domain is recognized", () => {
  const src = `<?php
$label = __( 'Save', 'my-textdomain' );
`;
  const calls = extractPhpI18nCalls(src);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wrapper, "__");
  assert.equal(calls[0].msgid, "Save");
  assert.equal(calls[0].domain, "my-textdomain");
  assert.equal(calls[0].msgctxt, null);
  assert.equal(calls[0].owner, "@file");
});

test("REQ-004: omitted domain defaults to WP core's own 'default' textdomain", () => {
  const src = `<?php
$label = __( 'Save' );
`;
  const calls = extractPhpI18nCalls(src);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].domain, "default");
});

test("REQ-004: a present-but-dynamic domain argument is left unresolved (null), never defaulted", () => {
  const src = `<?php
$label = __( 'Save', $dynamic_domain );
`;
  const calls = extractPhpI18nCalls(src);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].domain, null);
});

test("REQ-004: _x()/_ex() capture msgctxt as the 2nd argument and domain as the 3rd", () => {
  const src = `<?php
$label = _x( 'Post', 'noun', 'my-textdomain' );
echo _ex( 'Close', 'verb', 'my-textdomain' );
`;
  const calls = extractPhpI18nCalls(src);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].msgid, "Post");
  assert.equal(calls[0].msgctxt, "noun");
  assert.equal(calls[0].domain, "my-textdomain");
  assert.equal(calls[1].msgid, "Close");
  assert.equal(calls[1].msgctxt, "verb");
});

test("REQ-004: a non-literal msgid is skipped entirely, never fabricated", () => {
  const src = `<?php
$label = __( $dynamic_text, 'my-textdomain' );
`;
  const calls = extractPhpI18nCalls(src);
  assert.equal(calls.length, 0);
});

test("REQ-004: owner tracking resolves Class::method the same way as the other sibling extractors", () => {
  const src = `<?php
class Settings {
  public function render() {
    echo esc_html__( 'Save Changes', 'td' );
  }
}
`;
  const calls = extractPhpI18nCalls(src);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, "Settings::render");
});

test("REQ-004: recognizes a call site regardless of whether it's inside an echo/HTML fragment or a plain assignment", () => {
  const src = `<?php
function render() {
  $x = __( 'Standalone', 'td' );
  echo '<button>' . esc_html__( 'Embedded', 'td' ) . '</button>';
}
`;
  const calls = extractPhpI18nCalls(src);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.msgid).sort(), ["Embedded", "Standalone"]);
});

test("REQ-004: esc_html_e()/esc_attr_e() etc. are recognized alongside __()/_e()", () => {
  const src = `<?php
esc_html_e( 'A', 'td' );
esc_attr_e( 'B', 'td' );
esc_attr__( 'C', 'td' );
`;
  const calls = extractPhpI18nCalls(src);
  assert.equal(calls.length, 3);
});
