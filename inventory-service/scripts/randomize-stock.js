/**
 * randomize-stock.js
 * Sets all inventory quantities to a random value between 1 and 9 (inclusive),
 * and resets reserved to 0.
 * Run: node inventory-service/scripts/randomize-stock.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const InventorySchema = new mongoose.Schema({
    productId:         mongoose.Schema.Types.ObjectId,
    sellerId:          mongoose.Schema.Types.ObjectId,
    quantity:          Number,
    reserved:          Number,
    lowStockThreshold: Number,
    updatedAt:         Date
});

async function run() {
    const conn = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();
    const Inventory = conn.model('Inventory', InventorySchema);

    const records = await Inventory.find({});
    console.log(`Found ${records.length} inventory record(s).`);

    for (const r of records) {
        const qty = Math.floor(Math.random() * 9) + 1; // 1–9, never 0
        r.quantity  = qty;
        r.reserved  = 0;
        r.updatedAt = new Date();
        await r.save();
        console.log(`  product ${r.productId} → qty=${qty}`);
    }

    console.log(`\nDone. All records updated.`);
    await conn.close();
}

run().catch(err => { console.error(err); process.exit(1); });
