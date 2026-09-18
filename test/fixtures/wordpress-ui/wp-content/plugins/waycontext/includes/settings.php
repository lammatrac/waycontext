<?php
/**
 * AC-006: a Settings Field registered via add_settings_field with a render
 * callback (render_api_key()) that itself calls onward into the ordinary
 * call graph -- trace_ui_action must resolve REGISTERED_AT/RENDERED_BY and
 * then walk that onward chain via the existing (non-UI) call graph.
 */

function waycontext_register_settings() {
    add_settings_section( 'waycontext_main', 'Main Settings', 'render_main_section', 'waycontext-settings' );
    add_settings_field( 'api_key', 'API Key', 'render_api_key', 'waycontext-settings', 'waycontext_main' );
}
add_action( 'admin_init', 'waycontext_register_settings' );

function render_main_section() {
}

function render_api_key() {
    fetch_api_key_value();
}

function fetch_api_key_value() {
    return get_option( 'waycontext_api_key' );
}
