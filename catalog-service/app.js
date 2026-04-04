require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const errorResponse = require('../shared/utils/errorResponse');
const bus = require('../shared/eventBus');

const app = express();
app.use(express.json());
app.use(cors());

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_catalog')
    .then(() => console.log('Catalog DB Connected'))
    .catch(console.error);

const ProductSchema = new mongoose.Schema({
    sellerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    title: { type: String, required: true },
    description: String,
    category: { type: String, required: true },
    price: { type: Number, required: true },
    images: [String],
    attributes: { type: Map, of: mongoose.Schema.Types.Mixed },
    avgRating: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'paused', 'deleted'], default: 'active' },
    createdAt: { type: Date, default: Date.now }
});
ProductSchema.index({ title: 'text', description: 'text' });
const Product = mongoose.model('Product', ProductSchema);

app.post('/products', async (req, res) => {
    // Requires storeId claim
    if (!req.user || !req.user.storeId) return errorResponse(res, 403, 'Missing storeId');
    try {
        const product = await Product.create({ ...req.body, sellerId: req.user.storeId });
        bus.emit('product.created', { productId: product._id, sellerId: product.sellerId });
        res.status(201).json(product);
    } catch (err) {
        errorResponse(res, 500, err.message);
    }
});

app.get('/products', async (req, res) => {
    try {
        const products = await Product.find({ status: 'active' });
        res.json(products);
    } catch (err) {
        errorResponse(res, 500, err.message);
    }
});

app.get('/products/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        product ? res.json(product) : errorResponse(res, 404, 'Not found');
    } catch (err) {
        errorResponse(res, 500, err.message);
    }
});

app.put('/products/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return errorResponse(res, 404, 'Not found');
        if (product.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');
        Object.assign(product, req.body);
        await product.save();
        res.json(product);
    } catch (err) {
        errorResponse(res, 500, err.message);
    }
});

app.delete('/products/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return errorResponse(res, 404, 'Not found');
        if (product.sellerId.toString() !== req.user.storeId) return errorResponse(res, 403, 'Not owned by you');
        product.status = 'deleted';
        await product.save();
        res.json({ message: 'Deleted' });
    } catch (err) {
        errorResponse(res, 500, err.message);
    }
});

const PORT = process.env.PORT || 5002;
app.listen(PORT, () => console.log(`Catalog Service on port ${PORT}`));
