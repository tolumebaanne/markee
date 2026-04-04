require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bus = require('../shared/eventBus');

const app = express(); app.use(express.json()); app.use(cors());
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_analytics').then(()=>console.log('Analytics DB Configured'));

const MetricSchema = new mongoose.Schema({
    event: String,
    data: mongoose.Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now }
});
const Metric = mongoose.model('Metric', MetricSchema);

const events = ['order.placed', 'payment.captured', 'shipment.created', 'shipment.delivered', 'product.created', 'review.approved'];
events.forEach(ev => {
    bus.on(ev, async (payload) => {
        try {
            await Metric.create({ event: ev, data: payload });
        } catch(e) {}
    });
});

app.get('/dashboard', async (req, res) => {
    const totalOrders = await Metric.countDocuments({ event: 'order.placed' });
    res.json({ totalOrders });
});

app.listen(process.env.PORT || 5012, () => console.log('Analytics Service on 5012'));
