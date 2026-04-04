require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const errorResponse = require('../shared/utils/errorResponse');
const bus = require('../shared/eventBus');

const app = express();
app.use(express.json());
app.use(cors());

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_orders').then(() => console.log('Order DB Connected')).catch(console.error);

const OrderSchema = new mongoose.Schema({
    buyerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    items: [{ productId: mongoose.Schema.Types.ObjectId, sellerId: mongoose.Schema.Types.ObjectId, qty: Number, price: Number }],
    status: { type: String, enum: ['pending', 'paid', 'processing', 'shipped', 'delivered'], default: 'pending' },
    shippingAddress: { street: String, city: String, zip: String, country: String },
    timeline: [{ status: String, timestamp: Date }],
    totalAmount: Number,
    createdAt: { type: Date, default: Date.now, index: true }
});
const Order = mongoose.model('Order', OrderSchema);

app.post('/', async (req, res) => {
    try {
        const order = await Order.create({ ...req.body, buyerId: req.user.sub });
        bus.emit('order.placed', { orderId: order._id, buyerId: order.buyerId, items: order.items, totalAmount: order.totalAmount });
        res.status(201).json(order);
    } catch(err) { errorResponse(res, 500, err.message); }
});

app.get('/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return errorResponse(res, 404, 'Not found');
        if (req.user.role === 'buyer' && order.buyerId.toString() !== req.user.sub) return errorResponse(res, 403, 'Access denied');
        res.json(order);
    } catch(err) { errorResponse(res, 500, err.message); }
});

app.patch('/:id/status', async (req, res) => {
    try {
        const order = await Order.findByIdAndUpdate(req.params.id, { 
            status: req.body.status, 
            $push: { timeline: { status: req.body.status, timestamp: Date.now() }}
        }, { new: true });
        res.json(order);
    } catch(err) { errorResponse(res, 500, err.message); }
});

app.listen(process.env.PORT || 5003, () => console.log('Order Service on 5003'));
