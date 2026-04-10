/**
 * seed-reviews.js
 * Injects realistic demo reviews into seeded products.
 *
 * Usage:
 *   node seed-reviews.js          — wipe + re-seed all review data
 *   node seed-reviews.js --clean  — wipe only (reviews, seller reviews, search index ratings)
 *
 * Idempotent: safe to run multiple times. Always clears before inserting.
 */

const mongoose = require('./review-service/node_modules/mongoose');

// ── Connection strings — set these in your .env file ─────────────────────────
// Required env vars: CATALOG_URI, REVIEW_URI, SEARCH_URI
const CATALOG_URI = process.env.CATALOG_URI;
const REVIEW_URI  = process.env.REVIEW_URI;
const SEARCH_URI  = process.env.SEARCH_URI;

// ── Review copy pool ──────────────────────────────────────────────────────────
// Each entry: { rating, body, imageUrl? }
const REVIEW_POOL = [
    { rating: 5, body: 'Absolutely love this! The quality exceeded my expectations. Would definitely buy again and recommend to friends.' },
    { rating: 5, body: 'Fast delivery, well-packaged. Exactly as described — no surprises. Five stars all the way.', imageUrl: 'https://images.unsplash.com/photo-1560343090-f0409e92791a?w=400&q=80' },
    { rating: 5, body: 'Best purchase I\'ve made in a while. Works perfectly straight out of the box. Very impressed with the build quality.' },
    { rating: 4, body: 'Great product overall. Minor cosmetic imperfection on arrival but nothing that affects functionality. Happy with it.' },
    { rating: 4, body: 'Good value for money. Setup was straightforward and performance has been solid so far. Seller was responsive too.' },
    { rating: 4, body: 'Solid item, matches the photos accurately. Delivery took a bit longer than expected but arrived in perfect condition.', imageUrl: 'https://images.unsplash.com/photo-1491553895911-0055eca6402d?w=400&q=80' },
    { rating: 3, body: 'Decent product but not quite what I expected from the description. Does the job but nothing special. Average.' },
    { rating: 5, body: 'Incredible quality! I was skeptical at this price point but it\'s genuinely premium. Packaging was also really nice.', imageUrl: 'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?w=400&q=80' },
    { rating: 4, body: 'Really pleased with this. Exactly what I needed and arrived quickly. The seller even included a small thank you note.' },
    { rating: 5, body: 'Outstanding experience from browsing to delivery. The product itself is top notch — clear attention to detail.' },
    { rating: 3, body: 'It works as advertised but I had to contact the seller for clarification on setup. Response was helpful though.' },
    { rating: 4, body: 'Good quality and sturdy construction. Would have given 5 stars but took a week longer to arrive than estimated.' },
];

const SELLER_REVIEW_POOL = [
    { rating: 5, body: 'Excellent seller! Super responsive and shipped the same day. One of the best buying experiences I\'ve had.', tags: ['fast_shipping', 'good_communication', 'as_described'] },
    { rating: 5, body: 'Packaged really carefully and arrived in perfect condition. Seller answered all my questions within the hour.', tags: ['good_communication', 'as_described'] },
    { rating: 4, body: 'Good seller overall. Product was as described and delivery was within the stated window. Would buy from again.', tags: ['as_described'] },
    { rating: 4, body: 'Pleasant transaction. Items well packaged, no damage on arrival. Communication was polite and professional.', tags: ['good_communication', 'fast_shipping'] },
    { rating: 5, body: 'Fantastic seller! Even went out of their way to ensure my order was correct. Rare level of care. Highly recommend.', tags: ['fast_shipping', 'good_communication', 'as_described'] },
];

const SELLER_REPLIES = [
    'Thank you so much for your kind words! It was a pleasure. Hope to see you again.',
    'Really appreciate the review! Let us know if there\'s anything else we can help with.',
    'Thank you! We always aim to pack carefully and get orders out fast. Glad it arrived safely.',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(n, shuffled.length));
}
function fakeId() { return new mongoose.Types.ObjectId(); }
function daysAgo(n) { return new Date(Date.now() - n * 86400000); }

function computeQualityScore(body, imageUrl, rating) {
    let score = 20; // base: verified purchase
    if (body && body.length >= 50) score += 40;
    else if (body && body.length >= 10) score += 20;
    if (imageUrl) score += 30;
    if (rating === 1 || rating === 5) score += 10;
    return score;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const CLEAN_ONLY = process.argv.includes('--clean');

async function run() {
    console.log('Connecting to databases...');
    const catalogConn = mongoose.createConnection(CATALOG_URI);
    const reviewConn  = mongoose.createConnection(REVIEW_URI);
    const searchConn  = mongoose.createConnection(SEARCH_URI);

    await Promise.all([
        new Promise(r => catalogConn.once('connected', r)),
        new Promise(r => reviewConn.once('connected',  r)),
        new Promise(r => searchConn.once('connected',  r)),
    ]);
    console.log('All databases connected.');

    // ── Schemas ───────────────────────────────────────────────────────────────
    const Product = catalogConn.model('Product', new mongoose.Schema({
        sellerId: mongoose.Schema.Types.ObjectId,
        title: String, category: String, price: Number, status: String,
    }, { strict: false }));

    const Review = reviewConn.model('Review', new mongoose.Schema({
        productId:    mongoose.Schema.Types.ObjectId,
        sellerId:     mongoose.Schema.Types.ObjectId,
        buyerId:      mongoose.Schema.Types.ObjectId,
        orderId:      mongoose.Schema.Types.ObjectId,
        rating:       Number,
        body:         String,
        imageUrl:     String,
        qualityScore: Number,
        status:       { type: String, default: 'approved' },
        helpfulCount: { type: Number, default: 0 },
        helpfulVoters: [mongoose.Schema.Types.ObjectId],
        flagCount:    { type: Number, default: 0 },
        flagVoters:   [mongoose.Schema.Types.ObjectId],
        sellerReply:  { body: String, repliedAt: Date, addressed: Boolean },
        statusHistory: [{ status: String, changedAt: Date, reason: String }],
        createdAt:    { type: Date, default: Date.now },
    }));

    const SellerReview = reviewConn.model('SellerReview', new mongoose.Schema({
        sellerId:  mongoose.Schema.Types.ObjectId,
        buyerId:   mongoose.Schema.Types.ObjectId,
        orderId:   mongoose.Schema.Types.ObjectId,
        rating:    Number,
        body:      String,
        tags:      [String],
        status:    { type: String, default: 'approved' },
        createdAt: { type: Date, default: Date.now },
    }));

    const SearchIndex = searchConn.model('SearchIndex', new mongoose.Schema({
        productId:   { type: mongoose.Schema.Types.ObjectId, unique: true },
        rating:      { type: Number, default: 0 },
        reviewCount: { type: Number, default: 0 },
    }, { strict: false }));

    // ── Wipe (always runs, --clean stops here) ────────────────────────────────
    const [rDel, srDel] = await Promise.all([
        Review.deleteMany({}),
        SellerReview.deleteMany({}),
    ]);
    // Reset all search index ratings to 0 so stale scores don't linger
    const siReset = await SearchIndex.updateMany({}, { $set: { rating: 0, reviewCount: 0 } });
    console.log(`Cleared: ${rDel.deletedCount} reviews, ${srDel.deletedCount} seller reviews, ${siReset.modifiedCount} search index ratings reset.`);

    if (CLEAN_ONLY) {
        console.log('\n✓ Clean complete (--clean flag set, skipping re-seed).');
        await catalogConn.close(); await reviewConn.close(); await searchConn.close();
        process.exit(0);
    }

    // ── Fetch products ────────────────────────────────────────────────────────
    const products = await Product.find({ status: 'active' }).lean();
    if (!products.length) {
        console.error('No active products found in catalog. Run seed-catalog.js first.');
        process.exit(1);
    }
    console.log(`Found ${products.length} active products.`);

    // ── Stable fake buyer IDs (consistent across run) ─────────────────────────
    const buyers = Array.from({ length: 8 }, () => fakeId());

    const reviewDocs = [];
    const searchUpdates = []; // { productId, avgRating, reviewCount }

    for (const product of products) {
        const pool = pickN(REVIEW_POOL, 3 + Math.floor(Math.random() * 3)); // 3–5 reviews
        const usedBuyers = pickN(buyers, pool.length);
        const productReviews = [];

        pool.forEach((template, i) => {
            const imageUrl = template.imageUrl || undefined;
            const addReply = i === 0 && Math.random() > 0.4; // ~60% of products get a seller reply on first review
            productReviews.push({
                productId:    product._id,
                sellerId:     product.sellerId,
                buyerId:      usedBuyers[i],
                orderId:      fakeId(),
                rating:       template.rating,
                body:         template.body,
                imageUrl,
                qualityScore: computeQualityScore(template.body, imageUrl, template.rating),
                status:       'approved',
                helpfulCount: Math.floor(Math.random() * 12),
                statusHistory: [{ status: 'approved', reason: 'auto_approved', changedAt: daysAgo(30 - i * 4) }],
                sellerReply: addReply ? {
                    body:       pick(SELLER_REPLIES),
                    repliedAt:  daysAgo(28 - i * 4),
                    addressed:  Math.random() > 0.5
                } : undefined,
                createdAt: daysAgo(30 - i * 5),
            });
        });

        reviewDocs.push(...productReviews);

        // Compute avg for search index update
        const sum = productReviews.reduce((s, r) => s + r.rating, 0);
        const avg = Math.round((sum / productReviews.length) * 10) / 10;
        searchUpdates.push({ productId: product._id, avgRating: avg, reviewCount: productReviews.length });
    }

    // ── Insert product reviews ────────────────────────────────────────────────
    await Review.insertMany(reviewDocs);
    console.log(`Inserted ${reviewDocs.length} product reviews across ${products.length} products.`);

    // ── Seller reviews (1–2 per unique seller) ────────────────────────────────
    const uniqueSellers = [...new Map(products.map(p => [p.sellerId.toString(), p.sellerId])).values()];
    const sellerReviewDocs = [];

    for (const sellerId of uniqueSellers) {
        const count = 1 + Math.floor(Math.random() * 2); // 1–2
        const pool  = pickN(SELLER_REVIEW_POOL, count);
        pool.forEach((template, i) => {
            sellerReviewDocs.push({
                sellerId,
                buyerId:  pick(buyers),
                orderId:  fakeId(),
                rating:   template.rating,
                body:     template.body,
                tags:     template.tags,
                status:   'approved',
                createdAt: daysAgo(20 - i * 6),
            });
        });
    }

    await SellerReview.insertMany(sellerReviewDocs);
    console.log(`Inserted ${sellerReviewDocs.length} seller reviews for ${uniqueSellers.length} seller(s).`);

    // ── Update search index ───────────────────────────────────────────────────
    let searchHits = 0;
    for (const upd of searchUpdates) {
        const result = await SearchIndex.updateOne(
            { productId: upd.productId },
            { $set: { rating: upd.avgRating, reviewCount: upd.reviewCount } }
        );
        if (result.matchedCount) searchHits++;
    }
    console.log(`Updated ${searchHits}/${searchUpdates.length} search index entries with ratings.`);
    if (searchHits < searchUpdates.length) {
        console.log('  (Some products not yet in search index — run the search-service to sync them first)');
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n✓ Review seeding complete.');
    console.log(`  Products seeded : ${products.length}`);
    console.log(`  Product reviews : ${reviewDocs.length}`);
    console.log(`  Seller reviews  : ${sellerReviewDocs.length}`);
    console.log(`  Search index    : ${searchHits} entries updated`);

    await catalogConn.close();
    await reviewConn.close();
    await searchConn.close();
    process.exit(0);
}

run().catch(err => {
    console.error('Seed failed:', err.message);
    process.exit(1);
});
