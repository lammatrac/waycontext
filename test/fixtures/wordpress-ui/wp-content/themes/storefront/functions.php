<?php
/**
 * AC-011: the theme fires a hook that a *different* plugin (cart-plugin/
 * cart-plugin.php) registers the callback for. trace_ui_action, called on
 * the "View Cart" button this function renders, must resolve LISTENS_TO/
 * FIRED_BY across that plugin/theme boundary to the callback's actual file.
 */

function storefront_render_cart_area() {
    submit_button( 'View Cart', 'secondary', 'view_cart' );
    do_action( 'woocommerce_before_cart' );
}
