require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const errorResponse = require('../shared/utils/errorResponse');
const bus = require('../shared/eventBus');

const app = express();
app.use(express.json());
app.use(cors());

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_inventory')
    .then(() => console.log('Inventory DB Connected'))
    .catch(console.error);

const InventorySchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, required: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    quantity: { type: Number, required: true, default: 0 },
    reserved: { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: 5 },
    updatedAt: { type: Date, default: Date.now }
});
const Inventory = mongoose.model('Inventory', InventorySchema);

bus.on('product.created', async (payload) => {
    try {
        await Inventory.create({ productId: payload.productId, sellerId: payload.sellerId, quantity: 0 });
        console.log(`Inventory record created for product ${payload.productId}`);
    } catch(err) { 
        console.error('Inventory creation error', err); 
    }
});

app.get('/:productId', async (req, res) => {
    try {
        const inv = await Inventory.findOne({ productId: req.params.productId });
        if (!inv) return errorResponse(res, 404, 'Not found');
        if (inv.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');
        res.json(inv);
    } catch (err) {
         errorResponse(res, 500, err.message);
    }
});

app.put('/:productId', async (req, res) => {
    try {
        const inv = await Inventory.findOne({ productId: req.params.productId });
        if (!inv) return errorResponse(res, 404, 'Not found');
        if (inv.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');
        
        inv.quantity = req.body.quantity ?? inv.quantity;
        inv.lowStockThreshold = req.body.lowStockThreshold ?? inv.lowStockThreshold;
        inv.updatedAt = Date.now();
        await inv.save();
        res.json(inv);
    } catch (err) {
        errorResponse(res, 500, err.message);
    }
});

const PORT = process.env.PORT || 5006;
app.listen(PORT, () => console.log(`Inventory Service on port ${PORT}`));
