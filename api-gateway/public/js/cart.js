/**
 * Markee Shared Cart Utility
 * Persists in localStorage under a per-user key so carts never bleed between accounts.
 * Key: markee_cart_<userSub>  (logged in)
 *      markee_cart_guest      (unauthenticated)
 *
 * On login the gateway callback page calls MarkeeCart.migrateGuestCart()
 * to fold any guest items into the newly identified user's cart.
 */
(function() {
    // ── Key resolution ────────────────────────────────────────────────────────
    function cartKey() {
        try {
            const t = localStorage.getItem('access_token');
            if (t) {
                const payload = JSON.parse(atob(t.split('.')[1]));
                if (payload.sub && payload.exp * 1000 > Date.now()) {
                    return 'markee_cart_' + payload.sub;
                }
            }
        } catch {}
        return 'markee_cart_guest';
    }

    // ── Core helpers ──────────────────────────────────────────────────────────
    function getCart() {
        try { return JSON.parse(localStorage.getItem(cartKey()) || '[]'); }
        catch { return []; }
    }

    function saveCart(cart) {
        localStorage.setItem(cartKey(), JSON.stringify(cart));
        updateAllCartBadges();
    }

    // ── Public API ────────────────────────────────────────────────────────────
    function addItem(product, qty = 1) {
        const cart = getCart();
        const existing = cart.find(i => i._id === product._id);
        if (existing) {
            existing.qty += qty;
        } else {
            // sellerId and fulfillment fields are required at checkout
            cart.push({
                _id:              product._id,
                title:            product.title,
                price:            product.price,
                image:            (product.images || [])[0] || '',
                sellerId:         product.sellerId || null,
                fastDeliveryFee:  product.fastDeliveryFee || 0,
                fulfillmentOptions: product.fulfillmentOptions || [],
                enabledCarriers:    product.enabledCarriers   || [],
                pickupLocationId:   product.pickupLocationId  || null,
                qty
            });
        }
        saveCart(cart);
        return cart;
    }

    function removeItem(productId) {
        const cart = getCart().filter(i => i._id !== productId);
        saveCart(cart);
        return cart;
    }

    function updateQty(productId, qty) {
        const cart = getCart();
        const item = cart.find(i => i._id === productId);
        if (item) {
            item.qty = Math.max(1, qty);
            saveCart(cart);
        }
        return getCart();
    }

    function clearCart() {
        localStorage.removeItem(cartKey());
        updateAllCartBadges();
    }

    function getTotalCount() {
        return getCart().reduce((sum, i) => sum + i.qty, 0);
    }

    function getTotalPrice() {
        return getCart().reduce((sum, i) => sum + (i.price * i.qty), 0);
    }

    function updateAllCartBadges() {
        const count = getTotalCount();
        document.querySelectorAll('.cart-count-badge').forEach(el => {
            el.textContent = count;
            el.style.display = count > 0 ? 'inline-flex' : 'none';
        });
    }

    /**
     * Call this immediately after a successful login (before refreshing the page).
     * Merges any items that were added as a guest into the now-known user cart,
     * then removes the guest key so nothing leaks to the next anonymous session.
     */
    function migrateGuestCart() {
        const guestKey  = 'markee_cart_guest';
        const guestCart = JSON.parse(localStorage.getItem(guestKey) || '[]');
        if (guestCart.length === 0) return;

        const userCart = getCart();
        guestCart.forEach(guestItem => {
            const existing = userCart.find(i => i._id === guestItem._id);
            if (existing) {
                existing.qty += guestItem.qty;
            } else {
                userCart.push(guestItem);
            }
        });
        saveCart(userCart);
        localStorage.removeItem(guestKey);
    }

    // Expose globally
    window.MarkeeCart = {
        getCart, addItem, removeItem, updateQty,
        clearCart, getTotalCount, getTotalPrice,
        updateAllCartBadges, migrateGuestCart
    };

    // Init badge on load
    document.addEventListener('DOMContentLoaded', () => updateAllCartBadges());
})();
