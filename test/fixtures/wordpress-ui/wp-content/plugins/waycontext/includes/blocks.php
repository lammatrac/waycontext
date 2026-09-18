<?php
/**
 * AC-016 (phase 1B-2, REQ-024): register_block_type(__DIR__.'/build', ...)
 * with a block.json declaring namespace "waycontext/pricing" -- the spec's
 * own worked example almost verbatim, adapted only for this file living in
 * includes/ rather than the plugin root (so the block.json lives at
 * wp-content/plugins/waycontext/build/block.json, a sibling of includes/,
 * via `__DIR__ . '/../build'`).
 */
function waycontext_register_blocks() {
    register_block_type( __DIR__ . '/../build', array(
        'render_callback' => 'waycontext_render_pricing_block',
    ) );
}
add_action( 'init', 'waycontext_register_blocks' );

function waycontext_render_pricing_block( $attributes ) {
    return '<div class="wc-pricing"></div>';
}
