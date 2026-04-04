require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const app = express(); app.use(express.json()); app.use(cors());
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mvp_messaging').then(()=>console.log('Messaging DB Linked'));

const MessageSchema = new mongoose.Schema({
    threadId: { type: String, required: true, index: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, required: true },
    recipientId: { type: mongoose.Schema.Types.ObjectId, required: true },
    body: { type: String, required: true },
    read: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Auth error'));
    jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret', (err, decoded) => {
        if (err) return next(new Error('Auth error'));
        socket.user = decoded;
        socket.join(decoded.sub);
        next();
    });
});

io.on('connection', (socket) => {
    socket.on('send_message', async (data) => {
        const msg = await Message.create({
            threadId: data.threadId, senderId: socket.user.sub,
            recipientId: data.recipientId, body: data.body
        });
        io.to(data.recipientId).emit('new_message', msg);
    });
});

app.get('/thread/:threadId', async (req, res) => {
    const msgs = await Message.find({ threadId: req.params.threadId }).sort({createdAt: 1});
    await Message.updateMany({ threadId: req.params.threadId, recipientId: req.user.sub, read: false }, { read: true });
    res.json(msgs);
});

const PORT = process.env.PORT || 5009;
server.listen(PORT, () => console.log('Messaging WebSocket & REST on 5009'));
