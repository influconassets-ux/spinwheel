const mongoose = require('mongoose');

const StoreConfigSchema = new mongoose.Schema({
    storeDomain: { type: String, required: true, unique: true },
    accessToken: { type: String }, // Shopify OAuth token (Optional for Custom Apps using .env)
    isActive: { type: Boolean, default: false },
    campaignName: { type: String, default: 'Spin & Win' },
    startDate: { type: Date },
    endDate: { type: Date },
    maxSpinsPerCustomer: { type: Number, default: 1 },
    freeGiftCollectionId: { type: String }, // Shopify Collection ID
    prizes: [{
        label: { type: String, required: true }, // e.g., '10% OFF', 'Free Accessory'
        type: { type: String, enum: ['percentage', 'fixed_amount', 'free_shipping', 'free_accessory', 'none'], required: true },
        value: { type: Number }, // percentage or amount
        probabilityWeight: { type: Number, required: true }, // e.g., 10, 20, 50
    }]
}, { timestamps: true });

module.exports = mongoose.model('StoreConfig', StoreConfigSchema);
