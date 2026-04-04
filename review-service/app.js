require('dotenv').config(); 
const express = require('express'); 
const mongoose = require('mongoose'); 
const cors = require('cors'); 
const bus = require('../shared/eventBus');

const app = express(); app.use(express.json()); app.use(cors());
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_reviews').then(()=>console.log('Reviews DB live'));

const ReviewSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, required: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    body: String,
    status: { type: String, enum: ['pending', 'approved', 'flagged'], default: 'pending' },
    createdAt: { type: Date, default: Date.now, index: true }
});
const Review = mongoose.model('Review', ReviewSchema);

app.post('/', async (req, res) => {
    const rev = await Review.create({ ...req.body, buyerId: req.user.sub });
    res.json(rev);
});

app.get('/product/:productId', async (req, res) => {
    const revs = await Review.find({ productId: req.params.productId, status: 'approved' });
    res.json(revs);
});

app.patch('/:id/moderate', async (req, res) => {
    const rev = await Review.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    if (rev.status === 'approved') bus.emit('review.approved', { productId: rev.productId, rating: rev.rating });
    res.json(rev);
});

app.listen(process.env.PORT || 5008, () => console.log('Review Service mounted on 5008'));
