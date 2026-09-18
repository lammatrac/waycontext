<?php
/**
 * Purpose-built WordPress fixture, phase 1A-9 (see docs/specs/ui-intelligence/
 * contracts.md "Phase 1A-9" for the fixture-wide index). Covers AC-001,
 * AC-002 and AC-004 verbatim from § 14 of the spec: submit_button() wrapped
 * in the i18n call from the spec's own worked example, an aria-label-only
 * control with no text child, and add_menu_page() with the spec's own
 * literal argument list.
 */

function waycontext_register_menu() {
    add_menu_page(
        'WayContext',
        'WayContext',
        'manage_options',
        'waycontext',
        'render_waycontext_page'
    );
}
add_action( 'admin_menu', 'waycontext_register_menu' );

function render_waycontext_page() {
    // AC-001: role/type "button", visible text "Sync members" (resolved
    // through the i18n wrapper, see languages/waycontext-vi.po for AC-003).
    submit_button( __( 'Sync members', 'waycontext' ), 'primary', 'sync_members' );
    ?>
    <!-- AC-002: no text child, identified only by aria-label. -->
    <button aria-label="Sync members" class="waycontext-icon-button"></button>
    <?php
}
