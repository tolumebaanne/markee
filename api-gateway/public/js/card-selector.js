/**
 * Markee Card Selector Modal
 * Usage: window.showCardSelector(onSelect)
 *   onSelect(cardObject) — called with the chosen card, modal closes
 *   cardObject: { id, brand, last4, expMonth, expYear }
 */
(function () {
    function escHtml(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function isExpired(c) {
        const today        = new Date();
        const currentYear  = today.getFullYear();
        const currentMonth = today.getMonth() + 1;
        const cardYear     = parseInt(c.expYear,  10);
        const cardMonth    = parseInt(c.expMonth, 10);
        if (cardYear < currentYear) return true;
        if (cardYear === currentYear && cardMonth < currentMonth) return true;
        return false;
    }

    function brandIcon(brand) {
        const icons = {
            visa:       'fa-cc-visa',
            mastercard: 'fa-cc-mastercard',
            amex:       'fa-cc-amex',
            discover:   'fa-cc-discover',
            diners:     'fa-cc-diners-club',
            jcb:        'fa-cc-jcb',
        };
        const key = (brand || '').toLowerCase();
        return icons[key]
            ? `<i class="fab ${icons[key]}" style="font-size:1.1rem;margin-right:0.4rem"></i>`
            : `<i class="fa fa-credit-card" style="margin-right:0.4rem"></i>`;
    }

    window.showCardSelector = async function (onSelect) {
        // Remove any existing instance
        const existing = document.getElementById('card-selector-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'card-selector-overlay';
        overlay.className = 'payment-selector-overlay';
        overlay.innerHTML = `
            <div class="payment-selector-modal">
                <div class="payment-selector-header">
                    <h3>Select Saved Card</h3>
                    <button class="payment-selector-close" aria-label="Close">&times;</button>
                </div>
                <div class="payment-selector-body">
                    <div class="payment-selector-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('.payment-selector-close').onclick = () => overlay.remove();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const body = overlay.querySelector('.payment-selector-body');

        try {
            const token = localStorage.getItem('access_token') || localStorage.getItem('authToken') || localStorage.getItem('token') || '';
            const r = await fetch('/api/payments/saved-cards', {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!r.ok) throw new Error('Could not load saved cards');
            const data  = await r.json();
            const cards = data.cards || [];

            if (!cards.length) {
                const returnTo = encodeURIComponent(window.location.pathname);
                body.innerHTML = `
                    <div class="payment-selector-empty">
                        <p>No saved cards yet.</p>
                        <p style="font-size:0.82rem;color:var(--text-muted)">Cards are saved automatically after your first card payment.</p>
                        <a href="/account/wallet?returnTo=${returnTo}" class="nav-pill nav-pill-red" style="text-decoration:none;">Manage Cards</a>
                    </div>`;
                return;
            }

            body.innerHTML = cards.map((c, i) => {
                const brand   = escHtml(c.brand.charAt(0).toUpperCase() + c.brand.slice(1));
                const exp     = `${String(c.expMonth).padStart(2,'0')}/${c.expYear}`;
                const expired = isExpired(c);
                if (expired) {
                    return `
                <div class="payment-selector-card" data-index="${i}" aria-disabled="true" tabindex="-1" style="pointer-events:none;opacity:0.5;" aria-label="${brand} ending ${escHtml(c.last4)} — expired">
                    <div class="pm-card-brand">${brandIcon(c.brand)}${brand} •••• ${escHtml(c.last4)}</div>
                    <div class="pm-card-expiry" style="color:#dc2626;">Expires ${exp} <span style="margin-left:0.4rem;padding:0.1rem 0.45rem;background:#fca5a5;color:#7f1d1d;border-radius:4px;font-size:0.68rem;font-weight:700;">Expired</span></div>
                </div>`;
                }
                return `
                <div class="payment-selector-card" data-index="${i}" tabindex="0" role="button" aria-label="Select ${brand} ending ${escHtml(c.last4)}">
                    <div class="pm-card-brand">${brandIcon(c.brand)}${brand} •••• ${escHtml(c.last4)}</div>
                    <div class="pm-card-expiry">Expires ${exp}</div>
                </div>`;
            }).join('');

            body.querySelectorAll('.payment-selector-card:not([aria-disabled])').forEach((card) => {
                const i = parseInt(card.dataset.index, 10);
                const select = () => {
                    overlay.remove();
                    if (onSelect) onSelect(cards[i]);
                };
                card.addEventListener('click', select);
                card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') select(); });
            });

        } catch (err) {
            body.innerHTML = `
                <div class="payment-selector-empty">
                    <p>Couldn't load your saved cards.</p>
                    <a href="/account/wallet" class="nav-pill nav-pill-red" style="text-decoration:none;">Manage Cards</a>
                </div>`;
        }
    };
})();
