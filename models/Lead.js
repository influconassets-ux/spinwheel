const mongoose = require('mongoose');

const LeadSchema = new mongoose.Schema({
    storeDomain: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    campaign: { type: String, required: true }, // e.g., 'Navratri Free Gifts'
    prize: { type: String, required: true },
    discountCode: { type: String }, // Code generated from Shopify
    selectedVariantId: { type: String }, // If free accessory was won
    expiry: { type: Date },
    used: { type: Boolean, default: false },
    converted: { type: Boolean, default: false },
    orderId: { type: String } // Shopify Order ID upon conversion
}, { timestamps: true });

module.exports = mongoose.model('Lead', LeadSchema);
