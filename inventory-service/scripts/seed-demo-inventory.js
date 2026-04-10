/**
 * seed-demo-inventory.js
 * Creates inventory records for any catalog product that doesn't have one.
 * Quantity: 1–8 (never 0, never out of stock)
 * Reserved: 0–30% of quantity
 * Threshold: 2–4
 * Run: node inventory-service/scripts/seed-demo-inventory.js
 */
const path = require('path');
const fs   = require('fs');

// Load inventory env
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const INV_URI = process.env.MONGODB_URI;

// Load catalog URI directly from its .env
let CAT_URI = '';
const catEnv = path.join(__dirname, '../../catalog-service/.env');
fs.readFileSync(catEnv, 'utf8').split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && k.trim() === 'MONGODB_URI') CAT_URI = rest.join('=').trim();
});

const mongoose = require('mongoose');

async function run() {
    const catConn = await mongoose.createConnection(CAT_URI).asPromise();
    const invConn = await mongoose.createConnection(INV_URI).asPromise();

    const Product   = catConn.model('Product',   new mongoose.Schema({ sellerId: mongoose.Schema.Types.ObjectId, status: String }));
    const Inventory = invConn.model('Inventory', new mongoose.Schema({
        productId:         { type: mongoose.Schema.Types.ObjectId, unique: true },
        sellerId:          mongoose.Schema.Types.ObjectId,
        quantity:          Number,
        reserved:          Number,
        lowStockThreshold: Number,
        updatedAt:         Date
    }));

    // All non-deleted products
    const products = await Product.find({ status: { $ne: 'deleted' } });
    console.log(`Found ${products.length} catalog product(s).`);

    // Existing inventory productIds
    const existing = new Set(
        (await Inventory.find({}, 'productId')).map(r => r.productId.toString())
    );
    console.log(`${existing.size} already have inventory records.`);

    const toCreate = products.filter(p => !existing.has(p._id.toString()));
    console.log(`Creating records for ${toCreate.length} product(s)...\n`);

    let created = 0;
    for (const p of toCreate) {
        const quantity          = Math.floor(Math.random() * 8) + 1;       // 1–8
        const reserved          = Math.floor(Math.random() * Math.max(1, Math.floor(quantity * 0.3))); // 0–30%
        const lowStockThreshold = Math.floor(Math.random() * 3) + 2;       // 2–4

        await Inventory.create({
            productId:  p._id,
            sellerId:   p.sellerId,
            quantity,
            reserved,
            lowStockThreshold,
            updatedAt:  new Date()
        });

        const available = quantity - reserved;
        console.log(`  ${p._id} → qty=${quantity}  reserved=${reserved}  available=${available}  threshold=${lowStockThreshold}`);
        created++;
    }

    console.log(`\nDone. Created ${created} inventory record(s).`);
    await catConn.close();
    await invConn.close();
}

run().catch(err => { console.error(err); process.exit(1); });
