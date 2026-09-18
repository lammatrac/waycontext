import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPhpBlocks } from "../src/ui/phpBlocks.js";

// Unit tests for the pure, DB-free block-registration call-site extraction
// function (phase 1B-2: REQ-024). Reading/parsing block.json and
// project-wide `block`/`block_manifest` entity + DEFINED_IN/RENDERED_BY
// resolution through indexProject live in test/indexer.uiBlocks.test.js.

test("REQ-024/AC-016: register_block_type(__DIR__.'/build', ['render_callback' => ...]) is recognized", () => {
  const src = `<?php
register_block_type( __DIR__ . '/build', array( 'render_callback' => 'render_pricing_block' ) );
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].dirArg, "/build");
  assert.equal(blocks[0].renderCallback, "render_pricing_block");
  assert.equal(blocks[0].owner, "@file");
});

test("REQ-024: short-array syntax for the args array is recognized identically", () => {
  const src = `<?php
register_block_type( __DIR__ . '/build', [ 'render_callback' => 'render_pricing_block' ] );
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].renderCallback, "render_pricing_block");
});

test("REQ-024: __DIR__ alone (no concatenation) resolves to the empty-string path fragment", () => {
  const src = `<?php
register_block_type( __DIR__ );
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].dirArg, "");
  assert.equal(blocks[0].renderCallback, null);
});

test("REQ-024: a plain string literal directory (no __DIR__) is also resolved", () => {
  const src = `<?php
register_block_type( 'build', array( 'render_callback' => 'render_pricing_block' ) );
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].dirArg, "build");
});

test("REQ-024: array($this, 'method') render_callback resolves relative to its enclosing class", () => {
  const src = `<?php
class Pricing_Block {
  public function boot() {
    register_block_type( __DIR__ . '/build', array( 'render_callback' => array( $this, 'render' ) ) );
  }
}
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].renderCallback, "Pricing_Block::render");
  assert.equal(blocks[0].owner, "Pricing_Block::boot");
});

test("array(__CLASS__, 'method') and array('LiteralClass', 'method') render_callbacks resolve", () => {
  const src = `<?php
class Pricing_Block {
  public static function boot() {
    register_block_type( __DIR__ . '/build_a', array( 'render_callback' => array( __CLASS__, 'render_a' ) ) );
    register_block_type( __DIR__ . '/build_b', array( 'render_callback' => array( 'Pricing_Block', 'render_b' ) ) );
  }
}
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].renderCallback, "Pricing_Block::render_a");
  assert.equal(blocks[1].renderCallback, "Pricing_Block::render_b");
});

test("REQ-026/Q-003: a dynamic (non-literal) first argument is skipped entirely -- no fabricated entity", () => {
  const src = `<?php
register_block_type( $dynamicDir, array( 'render_callback' => 'render_pricing_block' ) );
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks.length, 0);
});

test("REQ-026: register_block_type(plugin_dir_path(__FILE__) . 'build') is unresolvable -- skipped, not guessed", () => {
  const src = `<?php
register_block_type( plugin_dir_path( __FILE__ ) . 'build' );
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks.length, 0);
});

test("no render_callback key present -> renderCallback null, block still recognized", () => {
  const src = `<?php
register_block_type( __DIR__ . '/build' );
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].renderCallback, null);
});

test("an unresolvable render_callback value (a variable) is recorded as null, never fabricated", () => {
  const src = `<?php
register_block_type( __DIR__ . '/build', array( 'render_callback' => $callback ) );
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].renderCallback, null);
});

test("register_block_type_from_metadata() is NOT recognized -- deliberately out of scope", () => {
  const src = `<?php
register_block_type_from_metadata( __DIR__ . '/build' );
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks.length, 0);
});

test("line numbers are recorded per call site", () => {
  const src = `<?php

register_block_type( __DIR__ . '/build', array( 'render_callback' => 'render_pricing_block' ) );
`;
  const blocks = extractPhpBlocks(src);
  assert.equal(blocks[0].line, 3);
});
