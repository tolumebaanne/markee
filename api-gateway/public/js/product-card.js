/**
 * renderProductCard(product, opts) — canonical product card for all surfaces.
 * opts: { showSeller, showCart, showRating, compact, linkToProduct }
 */
window.renderProductCard = function(product, opts) {
    opts = opts || {};
    const showSeller    = opts.showSeller    !== false;
    const showCart      = opts.showCart      !== false;
    const showRating    = opts.showRating    !== false;
    const compact       = opts.compact       === true;
    const linkToProduct = opts.linkToProduct !== false;

    if (!product || !product._id) return '';

    const price = (product.price / 100).toLocaleString('en-US', {
        style: 'currency', currency: 'USD'
    });
    const imgSrc = (product.images && product.images[0]) || '/assets/product-placeholder.svg';
    const rawTitle = product.title || 'Untitled Product';
    const title  = rawTitle.length > 60 ? rawTitle.slice(0, 57) + '\u2026' : rawTitle;
    const rating = product.avgRating ? Number(product.avgRating).toFixed(1) : null;
    const catLabel = product.category
        ? product.category.split('/').pop().replace(/-/g, ' ')
        : '';
    const isActive = !product.status || product.status === 'active';

    // Escape for safe HTML attribute embedding
    const safeTitle = title.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const body = `
        <div class="pc-img-wrap">
            <img src="${imgSrc}" alt="${safeTitle}" class="pc-img"
                 onerror="this.onerror=null;this.src='/assets/product-placeholder.svg'">
            ${!isActive ? `<div class="pc-overlay">${product.status}</div>` : ''}
        </div>
        <div class="pc-body">
            ${catLabel ? `<span class="pc-category">${catLabel}</span>` : ''}
            <div class="pc-title">${title}</div>
            ${showRating && rating ? `<div class="pc-rating">\u2605 ${rating}</div>` : ''}
            ${showSeller && product.storeName ? `<div class="pc-store">${product.storeName}</div>` : ''}
            <div class="pc-footer">
                <span class="pc-price">${price}</span>
                ${showCart && isActive
                    ? `<button class="btn btn-sm btn-red"
                           onclick="event.stopPropagation();event.preventDefault();
                                    if(window.MarkeeCart)MarkeeCart.addItem('${product._id}','${safeTitle}',${product.price})">
                           Add to Cart</button>`
                    : ''}
            </div>
        </div>
    `;

    const cls = 'product-card' + (compact ? ' pc-compact' : '');
    if (linkToProduct) {
        return `<a href="/product/${product._id}" class="${cls}" style="text-decoration:none;">${body}</a>`;
    }
    return `<div class="${cls}">${body}</div>`;
};
