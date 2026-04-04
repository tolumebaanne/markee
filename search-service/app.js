require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bus = require('../shared/eventBus');

const app = express(); app.use(express.json()); app.use(cors());
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_search').then(()=>console.log('Search DB Indexed'));

const SearchIndexSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    title: String, category: String, price: Number, sellerId: mongoose.Schema.Types.ObjectId,
    rating: { type: Number, default: 0 },
    text: String
});
SearchIndexSchema.index({ text: 'text' });
const SearchIndex = mongoose.model('SearchIndex', SearchIndexSchema);

bus.on('product.created', async (p) => {
    try {
        await SearchIndex.create({ productId: p.productId, title: p.title, sellerId: p.sellerId, text: `${p.title} ${p.category}` });
    } catch(e) { console.error('Search index err', e); }
});
bus.on('review.approved', async (r) => {
    try {
        await SearchIndex.updateOne({ productId: r.productId }, { rating: r.rating });
    } catch(e) {}
});

app.get('/', async (req, res) => {
    const { q, category, minPrice, maxPrice } = req.query;
    let query = {};
    if (q) query.$text = { $search: q };
    if (category) query.category = category;
    if (minPrice || maxPrice) {
        query.price = {};
        if (minPrice) query.price.$gte = Number(minPrice);
        if (maxPrice) query.price.$lte = Number(maxPrice);
    }
    const results = await SearchIndex.find(query);
    res.json(results);
});

app.listen(process.env.PORT || 5010, () => console.log('Search Service deployed to 5010'));
