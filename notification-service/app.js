require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bus = require('../shared/eventBus');

const app = express(); app.use(cors());

const notifications = [];

bus.on('order.placed', (data) => {
    console.log(`[Notification] Order ${data.orderId} placed by ${data.buyerId}`);
    notifications.push({ type: 'ORDER_PLACED', ...data });
});
bus.on('shipment.delivered', (data) => {
    console.log(`[Notification] Order ${data.orderId} delivered`);
    notifications.push({ type: 'DELIVERED', ...data });
});

app.get('/', (req, res) => res.json(notifications));
app.listen(process.env.PORT || 5011, () => console.log('Notification Service operational on 5011'));
