<?php
/**
 * REQ-013: wp-includes/ is classified framework-owned, not application
 * source -- exercised by find_ui_source/get_ui_context's not_relevant
 * output. Not itself an AC-001..AC-019 fixture, but reused from the same
 * pattern test/operations.uiQueries.test.js already established.
 */

function core_widget_render() {
    ?>
    <button>Core Widget</button>
    <?php
}
