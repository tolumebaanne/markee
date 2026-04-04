require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bus = require('../shared/eventBus');

const app = express(); app.use(express.json()); app.use(cors());
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_shipping').then(()=>console.log('Shipping DB active'));

const ShipmentSchema = new mongoose.Schema({
    orderId: { type: mongoose.Schema.Types.ObjectId, required: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    carrier: String, trackingNumber: String,
    status: { type: String, enum: ['created', 'in_transit', 'out_for_delivery', 'delivered'], default: 'created' },
    estimatedDelivery: Date, updatedAt: { type: Date, default: Date.now }
});
const Shipment = mongoose.model('Shipment', ShipmentSchema);

app.post('/', async (req, res) => {
    if (req.user.storeId && req.user.storeId !== req.body.sellerId) return res.status(403).json({error: 'storeId claim fail'});
    const shipment = await Shipment.create(req.body);
    bus.emit('shipment.created', { orderId: shipment.orderId, sellerId: shipment.sellerId, trackingNumber: shipment.trackingNumber });
    res.json(shipment);
});

app.patch('/:id/status', async (req, res) => {
    const shipment = await Shipment.findByIdAndUpdate(req.params.id, { status: req.body.status, updatedAt: Date.now() }, { new: true });
    if (shipment.status === 'delivered') bus.emit('shipment.delivered', { orderId: shipment.orderId, sellerId: shipment.sellerId });
    res.json(shipment);
});

app.listen(process.env.PORT || 5007, () => console.log('Shipping Service spinning on 5007'));
