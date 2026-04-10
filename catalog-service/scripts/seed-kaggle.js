/**
 * Markee Kaggle Diverse Seed Script
 * 
 * Clears old seeded products and re-seeds with diverse products
 * from 10+ different categories, 20 per category = 200+ real products.
 * 
 * Uses the local Amazon Products Dataset 2023 (already on disk).
 * Data lifecycle: all products use p@p.ca as seller.
 *   On account delete -> user.deleted event -> catalog service wipes all.
 */
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

// ─── Config ──────────────────────────────────────────────────────────────────
// Required env vars: AUTH_URI, CATALOG_URI (set in your .env file)
const AUTH_URI    = process.env.AUTH_URI;
const CATALOG_URI = process.env.CATALOG_URI;
const PRODUCTS_CSV = path.join(__dirname, '../../foundational_docs/Amazon Products Dataset 2023/amazon_products.csv');
const CATEGORIES_CSV = path.join(__dirname, '../../foundational_docs/Amazon Products Dataset 2023/amazon_categories.csv');
const TARGET_EMAIL = 'p@p.ca';
const TARGET_PW    = '123456789123';

// ─── Target categories: category_id -> Markee display name ──────────────────
// Chosen for maximum marketplace diversity visible to end users
const TARGET_CATEGORIES = {
    '71':  'Electronics',           // Headphones & Earbuds
    '69':  'Electronics',           // Televisions & Video Products
    '72':  'Electronics',           // Office Electronics
    '110': 'Fashion',               // Men's Clothing
    '91':  'Fashion',               // Girls' Clothing
    '114': 'Fashion',               // Men's Shoes
    '112': 'Fashion',               // Men's Accessories
    '255': 'Gaming & Consoles',     // Video Games
    '253': 'Gaming & Consoles',     // PlayStation 4
    '245': 'Gaming & Consoles',     // Xbox 360
    '270': 'Toys & Games',          // Toys & Games
    '228': 'Toys & Games',          // Sports & Outdoor Play Toys
    '175': 'Home & Garden',         // Vacuum Cleaners
    '128': 'Health & Wellness',     // Wellness & Relaxation
    '16':  'Vehicles',              // Automotive Tires & Wheels
    '17':  'Vehicles',              // Automotive Tools
    '206': 'Home & Garden',         // Light Bulbs
    '124': 'Home & Garden',         // Kids' Furniture
};

const PER_CATEGORY_LIMIT = 20; // products per category_id bucket

// ─── Helpers ─────────────────────────────────────────────────────────────────
function loadCategoriesFromCsv() {
    return new Promise((resolve, reject) => {
        const map = {};
        fs.createReadStream(CATEGORIES_CSV)
            .pipe(csv())
            .on('data', row => { map[row.id] = row.category_name; })
            .on('end', () => resolve(map))
            .on('error', reject);
    });
}

function streamProducts(buckets) {
    return new Promise((resolve, reject) => {
        const targetIds = new Set(Object.keys(TARGET_CATEGORIES));
        let done = false;

        const stream = fs.createReadStream(PRODUCTS_CSV).pipe(csv());

        stream.on('data', row => {
            const catId = String(row.category_id || '').trim();
            if (!targetIds.has(catId)) return;

            const bucket = buckets[catId] || (buckets[catId] = []);
            if (bucket.length >= PER_CATEGORY_LIMIT) return;

            const price = Math.round(parseFloat(row.price || '0') * 100);
            if (!row.title || !row.imgUrl || isNaN(price) || price <= 0) return;
            // Filter out placeholder/broken images
            if (!row.imgUrl.startsWith('http')) return;

            bucket.push({
                title: row.title.slice(0, 200),
                description: row.productURL
                    ? `Shop this item on Amazon: ${row.productURL}\n\nRating: ${row.stars || 'N/A'} ⭐  |  Reviews: ${row.reviews || 0}\n\nOriginal List Price: $${row.listPrice || 'N/A'}`
                    : `Amazon product imported to Markee. Rating: ${row.stars || 'N/A'} ⭐`,
                category: TARGET_CATEGORIES[catId],
                price,
                images: [row.imgUrl],
                stars: parseFloat(row.stars || 0),
            });

            // Check if all buckets are full
            const allFull = Object.keys(TARGET_CATEGORIES).every(id => buckets[id]?.length >= PER_CATEGORY_LIMIT);
            if (allFull && !done) {
                done = true;
                stream.destroy(); // stop reading, we have enough
            }
        });

        stream.on('close', () => resolve(buckets));
        stream.on('end', () => resolve(buckets));
        stream.on('error', err => {
            if (err.code === 'ERR_STREAM_DESTROYED') resolve(buckets);
            else reject(err);
        });
    });
}

// ─── Main seed function ──────────────────────────────────────────────────────
async function seed() {
    console.log('\n🌱  Markee Diverse Kaggle Seeder');
    console.log('━'.repeat(50));

    // 1. Auth DB — find or create seller
    console.log('\n[1/5] Connecting to Auth DB...');
    const authConn = await mongoose.createConnection(AUTH_URI).asPromise();
    const User = authConn.model('User', new mongoose.Schema({
        email: String, passwordHash: String, role: String,
        storeId: mongoose.Schema.Types.ObjectId,
    }));

    let seller = await User.findOne({ email: TARGET_EMAIL });
    if (!seller) {
        console.log(`     Creating seller account: ${TARGET_EMAIL}`);
        seller = await User.create({
            email: TARGET_EMAIL,
            passwordHash: await bcrypt.hash(TARGET_PW, 10),
            role: 'seller',
            storeId: new mongoose.Types.ObjectId(),
        });
    }
    const sellerId = seller.storeId || seller._id;
    console.log(`     ✓ Seller: ${seller.email}  |  StoreID: ${sellerId}`);

    // 2. Catalog DB — clear old seeded data
    console.log('\n[2/5] Connecting to Catalog DB...');
    const catalogConn = await mongoose.createConnection(CATALOG_URI).asPromise();
    const Product = catalogConn.model('Product', new mongoose.Schema({
        sellerId: mongoose.Schema.Types.ObjectId,
        title: String, description: String, category: String,
        price: Number, images: [String], status: String,
        stars: Number, createdAt: { type: Date, default: Date.now },
    }));

    console.log('\n[3/5] Clearing old seeded products for this seller...');
    const deleted = await Product.deleteMany({ sellerId });
    console.log(`     ✓ Removed ${deleted.deletedCount} old products`);

    // 3. Stream CSV and collect diverse products
    console.log('\n[4/5] Streaming CSV for diverse products...');
    const buckets = {};
    await streamProducts(buckets);

    const products = [];
    for (const [catId, items] of Object.entries(buckets)) {
        const catName = TARGET_CATEGORIES[catId];
        console.log(`     • ${catName} (id:${catId}): ${items.length} products`);
        for (const item of items) {
            products.push({ ...item, sellerId, status: 'active' });
        }
    }

    // 4. Insert
    console.log(`\n[5/5] Inserting ${products.length} products...`);
    if (products.length === 0) {
        console.log('     ⚠  No products collected. Check CSV path or category IDs.');
    } else {
        await Product.insertMany(products, { ordered: false });
        console.log(`     ✓ Seeded ${products.length} products across ${Object.keys(buckets).length} category buckets`);
    }

    // Summary
    console.log('\n' + '━'.repeat(50));
    console.log('✅  Seed complete!');
    console.log(`   Total products in marketplace: ${products.length}`);
    console.log(`   Categories represented: ${[...new Set(products.map(p=>p.category))].join(', ')}`);
    console.log('━'.repeat(50) + '\n');

    await authConn.close();
    await catalogConn.close();
    process.exit(0);
}

seed().catch(err => {
    console.error('\n❌  Seed Failed:', err.message);
    process.exit(1);
});
