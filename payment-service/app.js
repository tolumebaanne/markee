require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bus = require('../shared/eventBus');

const app = express();
app.use(express.json()); app.use(cors());

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_payments').then(() => console.log('Payment DB Locked and Loaded'));

const EscrowSchema = new mongoose.Schema({
    orderId: mongoose.Schema.Types.ObjectId,
    buyerId: mongoose.Schema.Types.ObjectId,
    amount: Number,
    status: { type: String, enum: ['held', 'released', 'refunded'], default: 'held' },
    sellerPayouts: [{ sellerId: mongoose.Schema.Types.ObjectId, amount: Number }]
});
const Escrow = mongoose.model('Escrow', EscrowSchema);

bus.on('order.placed', async (payload) => {
    try {
        const payouts = payload.items.map(i => ({ sellerId: i.sellerId, amount: i.qty * i.price }));
        const esc = await Escrow.create({ orderId: payload.orderId, buyerId: payload.buyerId, amount: payload.totalAmount, sellerPayouts: payouts });
        bus.emit('payment.captured', { orderId: esc.orderId, amount: esc.amount });
    } catch(err) { console.error(err); }
});

bus.on('shipment.delivered', async (payload) => {
    try {
        const esc = await Escrow.findOne({ orderId: payload.orderId });
        if (esc) {
            console.log(`Releasing escrow for seller ${payload.sellerId} on order ${payload.orderId}`);
        }
    } catch(e) { console.error(e); }
});

app.get('/escrow/:orderId', async (req, res) => {
    const esc = await Escrow.findOne({ orderId: req.params.orderId });
    res.json(esc);
});

app.listen(process.env.PORT || 5004, () => console.log('Payment Service on 5004'));
