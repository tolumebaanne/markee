/**
 * repair-seller-ids.js
 * Finds order items with null/missing sellerId and patches them by looking up
 * the product's sellerId from the catalog DB.
 * Bible-sanctioned migration script: cross-DB reads are permitted in scripts.
 *
 * Run: node order-service/scripts/repair-seller-ids.js
 */
const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '../.env') });
const ORDER_URI = process.env.MONGODB_URI;

let CAT_URI = '';
const catEnvPath = path.join(__dirname, '../../catalog-service/.env');
fs.readFileSync(catEnvPath, 'utf8').split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && k.trim() === 'MONGODB_URI') CAT_URI = rest.join('=').trim();
});

const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
    buyerId:  mongoose.Schema.Types.ObjectId,
    items: [{
        productId: mongoose.Schema.Types.ObjectId,
        sellerId:  mongoose.Schema.Types.ObjectId,
        title:     String,
        image:     String,
        qty:       Number,
        price:     Number
    }],
    status:    String,
    totalAmount: Number,
    createdAt: Date
});

const ProductSchema = new mongoose.Schema({
    sellerId: mongoose.Schema.Types.ObjectId,
    title:    String,
    status:   String
});

async function run() {
    console.log('Connecting to databases...');
    const orderConn   = await mongoose.createConnection(ORDER_URI).asPromise();
    const catalogConn = await mongoose.createConnection(CAT_URI).asPromise();

    const Order   = orderConn.model('Order', OrderSchema);
    const Product = catalogConn.model('Product', ProductSchema);

    // Find orders that have at least one item with null/missing sellerId
    const orders = await Order.find({ 'items.sellerId': null });
    console.log(`Found ${orders.length} order(s) with missing sellerId on items.`);

    let totalFixed = 0;

    for (const order of orders) {
        let changed = false;
        for (const item of order.items) {
            if (item.sellerId) continue; // already set
            if (!item.productId) {
                console.log(`  Order ${order._id}: item has no productId — skipping`);
                continue;
            }
            const product = await Product.findById(item.productId);
            if (!product) {
                console.log(`  Order ${order._id}: product ${item.productId} not found in catalog`);
                continue;
            }
            console.log(`  Order ${order._id}: item "${item.title}" → sellerId = ${product.sellerId}`);
            item.sellerId = product.sellerId;
            changed = true;
            totalFixed++;
        }
        if (changed) await order.save();
    }

    console.log(`\nDone. Repaired ${totalFixed} item(s) across ${orders.length} order(s).`);
    await orderConn.close();
    await catalogConn.close();
}

run().catch(err => { console.error(err); process.exit(1); });
