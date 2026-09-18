<?php
/**
 * AC-005: a second screen carrying an element with the exact same visible
 * text ("Sync members") as waycontext.php's submit_button, so
 * find_ui_element can be screen-scoped to disambiguate between the two.
 *
 * Deliberately slug 'wc-members', not 'waycontext-members': 1A-7's route
 * signal (contracts.md "Phase 1A-7") scores via substring containment on
 * the joined route|menu_slug|page_title|menu_title string, so a submenu
 * slug prefixed by the parent's own slug ("waycontext-members") would
 * containment-match a "WayContext"/"waycontext" screen hint too, defeating
 * the very disambiguation this fixture exists to demonstrate.
 */

function waycontext_register_members_menu() {
    add_submenu_page(
        'waycontext',
        'Members',
        'Members',
        'manage_options',
        'wc-members',
        'render_members_page'
    );
}
add_action( 'admin_menu', 'waycontext_register_members_menu' );

function render_members_page() {
    submit_button( 'Sync members', 'primary', 'sync_members_dup' );
}

/**
 * AC-015 (phase 1B-1, REQ-023): add_shortcode('members', 'render_members'),
 * the spec's own worked example almost verbatim. Wrapped in a named
 * registering function (not called at file top-level) so REGISTERED_AT
 * resolves to a real symbol rather than the "@file" sentinel -- same
 * reasoning waycontext_register_members_menu()/add_action('admin_menu', ...)
 * already establishes above for add_menu_page().
 */
function waycontext_register_shortcodes() {
    add_shortcode( 'members', 'render_members' );
}
add_action( 'init', 'waycontext_register_shortcodes' );

function render_members() {
    return '[members shortcode output]';
}
