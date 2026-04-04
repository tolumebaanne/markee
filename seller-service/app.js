require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const errorResponse = require('../shared/utils/errorResponse');

const app = express();
app.use(express.json());
app.use(cors());

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_sellers')
    .then(() => console.log('Seller DB Connected'))
    .catch(console.error);

const StoreSchema = new mongoose.Schema({
    name: String,
    description: String,
    sellerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    createdAt: { type: Date, default: Date.now }
});
const Store = mongoose.model('Store', StoreSchema);

app.post('/register', async (req, res) => {
    try {
        const store = await Store.create({ ...req.body, sellerId: req.user.sub });
        res.status(201).json(store);
    } catch (err) {
        errorResponse(res, 500, err.message);
    }
});

app.get('/:storeId', async (req, res) => {
    try {
        const store = await Store.findById(req.params.storeId);
        if (!store) return errorResponse(res, 404, 'Store not found');
        res.json(store);
    } catch (err) {
        errorResponse(res, 500, err.message);
    }
});

app.put('/:storeId', async (req, res) => {
    // Validate that the token's storeId claim matches the route parameter
    if (!req.user.storeId || req.user.storeId !== req.params.storeId) {
        return errorResponse(res, 403, 'StoreId claim validation failed');
    }
    try {
        const store = await Store.findByIdAndUpdate(req.params.storeId, req.body, { new: true });
        res.json(store);
    } catch (err) {
        errorResponse(res, 500, err.message);
    }
});

const PORT = process.env.PORT || 5005;
app.listen(PORT, () => console.log(`Seller Service running on port ${PORT}`));
