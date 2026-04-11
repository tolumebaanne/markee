const mongoose = require('mongoose');

const TemplateSchema = new mongoose.Schema({
    sellerId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    label: { type: String, required: true },
    body:  { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = TemplateSchema;
