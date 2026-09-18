import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPhpHooks } from "../src/ui/phpHooks.js";

// Unit tests for the pure, DB-free hook call-site extraction function
// (phase 1A-3: REQ-014). Project-wide LISTENS_TO/FIRED_BY resolution
// through indexProject (entities + entity_links writes, tombstone
// lifecycle) lives in test/indexer.uiHooks.test.js.

test("REQ-014: add_action() with a literal hook name and string callback is recognized as a listen site", () => {
  const src = `<?php
add_action( 'init', 'my_plugin_init' );
`;
  const { listens, fires } = extractPhpHooks(src);
  assert.equal(fires.length, 0);
  assert.equal(listens.length, 1);
  assert.equal(listens[0].hookName, "init");
  assert.equal(listens[0].registrationFn, "add_action");
  assert.equal(listens[0].callback, "my_plugin_init");
  assert.equal(listens[0].owner, "@file");
});

test("REQ-014: add_filter() resolves an array($this, 'method') callback relative to its enclosing class", () => {
  const src = `<?php
class Cart {
  public function boot() {
    add_filter( 'woocommerce_before_cart', array( $this, 'render' ) );
  }
}
`;
  const { listens } = extractPhpHooks(src);
  assert.equal(listens.length, 1);
  assert.equal(listens[0].hookName, "woocommerce_before_cart");
  assert.equal(listens[0].registrationFn, "add_filter");
  assert.equal(listens[0].callback, "Cart::render");
  assert.equal(listens[0].owner, "Cart::boot");
});

test("REQ-014: do_action()/apply_filters() are recognized as fire sites, owner is the enclosing function", () => {
  const src = `<?php
function render_cart() {
  do_action( 'woocommerce_before_cart' );
  $x = apply_filters( 'woocommerce_cart_item_class', $x );
}
`;
  const { fires } = extractPhpHooks(src);
  assert.equal(fires.length, 2);
  assert.equal(fires[0].hookName, "woocommerce_before_cart");
  assert.equal(fires[0].firingFn, "do_action");
  assert.equal(fires[0].owner, "render_cart");
  assert.equal(fires[1].hookName, "woocommerce_cart_item_class");
  assert.equal(fires[1].firingFn, "apply_filters");
});

test("REQ-026/Q-003: a dynamic (non-literal) hook name is skipped entirely -- no fabricated entity", () => {
  const src = `<?php
add_action( $hook_name, 'my_callback' );
do_action( $another_hook );
`;
  const { listens, fires } = extractPhpHooks(src);
  assert.equal(listens.length, 0);
  assert.equal(fires.length, 0);
});

test("REQ-026: an unresolvable callback (a variable object) is recorded with callback null, never fabricated", () => {
  const src = `<?php
add_action( 'init', array( $obj, 'method' ) );
`;
  const { listens } = extractPhpHooks(src);
  assert.equal(listens.length, 1);
  assert.equal(listens[0].callback, null);
});

test("add_shortcode()/do_shortcode() are not recognized -- shortcodes are a distinct concept (1B-1's scope)", () => {
  const src = `<?php
add_shortcode( 'my_shortcode', 'render_shortcode' );
echo do_shortcode( '[my_shortcode]' );
`;
  const { listens, fires } = extractPhpHooks(src);
  assert.equal(listens.length, 0);
  assert.equal(fires.length, 0);
});
