const express = require('express');
const router = express.Router();
const shopify = require('../shopify');
const StoreConfig = require('../models/StoreConfig');

// GET /api/auth
// Start OAuth flow
router.get('/', async (req, res) => {
    const shop = req.query.shop;
    if (!shop) {
        return res.status(400).send('Missing shop parameter');
    }

    try {
        await shopify.auth.begin({
            shop: shopify.utils.sanitizeShop(shop, true),
            callbackPath: '/api/auth/callback',
            isOnline: false, // Offline token for background tasks
            rawRequest: req,
            rawResponse: res,
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('OAuth Failed');
    }
});

// GET /api/auth/callback
// Handle OAuth callback
router.get('/callback', async (req, res) => {
    try {
        const callbackResponse = await shopify.auth.callback({
            rawRequest: req,
            rawResponse: res,
        });

        const { session } = callbackResponse;
        
        // Save token to DB
        await StoreConfig.findOneAndUpdate(
            { storeDomain: session.shop },
            { 
                storeDomain: session.shop,
                accessToken: session.accessToken,
                isActive: true
            },
            { upsert: true, new: true }
        );

        // Redirect to admin dashboard
        res.redirect(`${process.env.FRONTEND_URL}/dashboard?shop=${session.shop}`);

    } catch (e) {
        console.error(e);
        res.status(500).send(e.message);
    }
});

module.exports = router;
