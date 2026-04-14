/**
 * Markee Address Selector Modal
 * Usage: window.showAddressSelector(options, onSelect)
 *   options.type    — 'delivery' | 'pickup'
 *   options.title   — modal heading string
 *   options.storeId — required when type === 'pickup'
 *   onSelect(addressObject) — called with the chosen address, modal closes
 */
(function () {
    window.showAddressSelector = async function (options, onSelect) {
        const { type = 'delivery', title = 'Select Address', storeId } = options || {};

        // Remove any existing instance
        const existing = document.getElementById('addr-selector-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'addr-selector-overlay';
        overlay.className = 'address-selector-overlay';
        overlay.innerHTML = `
            <div class="address-selector-modal">
                <div class="address-selector-header">
                    <h3>${title}</h3>
                    <button class="address-selector-close" aria-label="Close">&times;</button>
                </div>
                <div class="address-selector-body">
                    <div class="address-selector-loading"><i class="fas fa-spinner fa-spin"></i> Loading…</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('.address-selector-close').onclick = () => overlay.remove();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        const body = overlay.querySelector('.address-selector-body');

        try {
            let addresses = [];

            if (type === 'delivery') {
                const token = localStorage.getItem('access_token') || localStorage.getItem('authToken') || localStorage.getItem('token') || '';
                const r = await fetch('/api/users/me/addresses', {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (!r.ok) throw new Error('Could not load addresses');
                addresses = await r.json();
            } else if (type === 'pickup') {
                if (!storeId) throw new Error('storeId required for pickup type');
                const token = localStorage.getItem('access_token') || localStorage.getItem('authToken') || localStorage.getItem('token') || '';
                const r = await fetch(`/api/seller/${storeId}/pickup-locations`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (!r.ok) throw new Error('Could not load pickup locations');
                const locs = await r.json();
                // Normalise pickup locations to the canonical address shape
                addresses = locs.filter(l => l.active !== false).map(l => ({
                    _id:        l._id,
                    label:      l.label || 'Pickup Location',
                    street:     l.street || '',
                    city:       l.city || '',
                    province:   l.province || '',
                    postalCode: l.postalCode || '',
                    country:    l.country || 'Canada',
                    hours:      l.hours || '',
                    instructions: l.instructions || ''
                }));
            }

            if (!addresses.length) {
                const link = type === 'delivery'
                    ? '<a href="/account/addresses">Add one in Account Settings</a>'
                    : '<a href="/account/addresses">Add a pickup location in Account Settings</a>';
                body.innerHTML = `<div class="address-selector-empty"><p>No addresses saved.</p><p>${link}</p></div>`;
                return;
            }

            body.innerHTML = addresses.map((a, i) => {
                const line2 = [a.city, a.province, a.postalCode].filter(Boolean).join(', ');
                const extra = [];
                if (a.hours)        extra.push(`<span class="addr-meta"><i class="fas fa-clock"></i> ${a.hours}</span>`);
                if (a.instructions) extra.push(`<span class="addr-meta">${a.instructions}</span>`);
                return `
                <div class="address-selector-card" data-index="${i}" tabindex="0" role="button" aria-label="Select ${a.label || a.street}">
                    <div class="addr-card-label">${a.label || 'Address'}${a.isDefault ? ' <span class="addr-default-badge">DEFAULT</span>' : ''}</div>
                    <div class="addr-card-street">${a.street}</div>
                    ${line2 ? `<div class="addr-card-line2">${line2}</div>` : ''}
                    ${a.country ? `<div class="addr-card-country">${a.country}</div>` : ''}
                    ${extra.join('')}
                </div>`;
            }).join('');

            body.querySelectorAll('.address-selector-card').forEach((card, i) => {
                const select = () => {
                    overlay.remove();
                    if (onSelect) onSelect(addresses[i]);
                };
                card.addEventListener('click', select);
                card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') select(); });
            });

        } catch (err) {
            body.innerHTML = `<div class="address-selector-empty"><p>Could not load addresses: ${err.message}</p></div>`;
        }
    };
})();
