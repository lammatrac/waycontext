<?php
/**
 * AC-011 counterpart to wp-content/themes/storefront/functions.php: a
 * *different* plugin registers the callback for the hook the theme fires.
 * The class-qualified callback (array($this,'method')) is the dominant
 * real-world WP idiom this fixture deliberately exercises (contracts.md
 * "Phase 1A-3": LISTENS_TO resolves this via resolveCallable()).
 */

class WC_Cart_Notices {
    public function boot() {
        add_action( 'woocommerce_before_cart', array( $this, 'render_notice' ) );
    }

    public function render_notice() {
        echo '<p>Cart notice</p>';
    }
}
