const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const StoreConfig = require('../models/StoreConfig');
const shopify = require('../shopify');

// Helper to create real Shopify Discount via Admin API
async function createShopifyDiscount(shopUrl, accessToken, codeName, prizeType, discountValue, collectionId) {
    const headers = {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json"
    };

    let priceRule = {
        title: codeName,
        target_type: "line_item",
        target_selection: "all",
        allocation_method: "across",
        value_type: "percentage",
        value: "-10.0",
        customer_selection: "all",
        starts_at: new Date().toISOString()
    };

    if (prizeType === 'percentage') {
        priceRule.value = `-${discountValue}.0`;
    } else if (prizeType === 'free_shipping') {
        priceRule.target_type = "shipping_line";
        priceRule.value_type = "percentage";
        priceRule.value = "-100.0";
        priceRule.allocation_method = "each";
    } else if (prizeType === 'free_accessory') {
        priceRule.value = "-100.0";
        if (collectionId) {
            priceRule.target_selection = "entitled";
            priceRule.entitled_collection_ids = [parseInt(collectionId, 10)];
            priceRule.allocation_method = "each";
            // Require user to buy 1 of ANY item to get 1 entitled item free
            priceRule.prerequisite_to_entitlement_quantity_ratio = {
                prerequisite_quantity: 1,
                entitled_quantity: 1
            };
            priceRule.allocation_limit = 1;
        }
    }

    // 1. Create Price Rule
    const ruleResponse = await fetch(`https://${shopUrl}/admin/api/2024-04/price_rules.json`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ price_rule: priceRule })
    });

    if (!ruleResponse.ok) {
        const errText = await ruleResponse.text();
        console.error("Shopify Price Rule Error Payload:", JSON.stringify({ price_rule: priceRule }));
        throw new Error(`Failed to create Price Rule: ${errText}`);
    }

    const ruleData = await ruleResponse.json();
    const priceRuleId = ruleData.price_rule.id;

    // 2. Create Discount Code
    const codeResponse = await fetch(`https://${shopUrl}/admin/api/2024-04/price_rules/${priceRuleId}/discount_codes.json`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            discount_code: { code: codeName }
        })
    });

    if (!codeResponse.ok) {
        throw new Error(`Failed to create Discount Code: ${await codeResponse.text()}`);
    }

    return codeName;
}

// Default fallback prizes matching the 6 slices on the frontend wheel
const fallbackPrizes = [
    { label: '10% OFF', type: 'percentage', probabilityWeight: 30 },
    { label: '15% OFF', type: 'percentage', probabilityWeight: 20 },
    { label: 'FREE GIFT', type: 'free_accessory', probabilityWeight: 5 },
    { label: 'FREE SHIP', type: 'free_shipping', probabilityWeight: 10 },
    { label: '20% OFF', type: 'percentage', probabilityWeight: 5 },
    { label: 'TRY AGAIN', type: 'none', probabilityWeight: 30 }
];

router.post('/spin', async (req, res) => {
    try {
        const { shopDomain, name, email, phone } = req.body;
        if (!shopDomain || !email) return res.status(400).send('Missing data');

        let config = await StoreConfig.findOne({ storeDomain: shopDomain });
        let prizes = (config && config.prizes && config.prizes.length > 0) ? config.prizes : fallbackPrizes;

        // Calculate weighted probability
        const totalWeight = prizes.reduce((acc, p) => acc + (Number(p.probabilityWeight) || 0), 0);
        let randomNum = Math.random() * totalWeight;
        let selectedPrize = null;
        let selectedIndex = 0;

        for (let i = 0; i < prizes.length; i++) {
            const prize = prizes[i];
            const weight = Number(prize.probabilityWeight) || 0;
            if (randomNum < weight) {
                selectedPrize = prize;
                selectedIndex = i;
                break;
            }
            randomNum -= weight;
        }

        // Failsafe
        if (!selectedPrize) {
            selectedPrize = prizes[prizes.length - 1];
            selectedIndex = prizes.length - 1;
        }

        let discountCode = null;
        let selectedVariantId = null;
        let finalPrizeText = selectedPrize.label;

        // Generate Real Shopify Discount Code
        if (selectedPrize.type !== 'none') {
            let codeName = '';
            let discountValue = 0;

            if (selectedPrize.type === 'percentage') {
                const valMatch = selectedPrize.label.match(/\d+/);
                discountValue = valMatch ? valMatch[0] : 10;
                codeName = `SPIN${discountValue}-${Math.random().toString(36).substring(2,8).toUpperCase()}`;
            } else if (selectedPrize.type === 'free_accessory') {
                codeName = `GIFT-${Math.random().toString(36).substring(2,8).toUpperCase()}`;
                
                // Pick a random product from the collection if configured
                if (config && config.freeGiftCollectionId) {
                    try {
                        const accessToken = (config && config.accessToken) ? config.accessToken : process.env.SHOPIFY_ACCESS_TOKEN;
                        const prodsRes = await fetch(`https://${shopDomain}/admin/api/2024-04/products.json?collection_id=${config.freeGiftCollectionId}`, {
                            headers: { "X-Shopify-Access-Token": accessToken }
                        });
                        
                        if (prodsRes.ok) {
                            const prodsData = await prodsRes.json();
                            const products = (prodsData.products || []).filter(p => p.status === 'active');
                            if (products.length > 0) {
                                const randomProduct = products[Math.floor(Math.random() * products.length)];
                                if (randomProduct.variants && randomProduct.variants.length > 0) {
                                    selectedVariantId = randomProduct.variants[0].id;
                                    finalPrizeText = `FREE GIFT: ${randomProduct.title}`;
                                }
                            }
                        }
                    } catch (e) {
                        console.error("Failed to fetch random free gift:", e);
                    }
                }
                
            } else if (selectedPrize.type === 'free_shipping') {
                codeName = `SHIP-${Math.random().toString(36).substring(2,8).toUpperCase()}`;
            }

            try {
                const accessToken = (config && config.accessToken) ? config.accessToken : process.env.SHOPIFY_ACCESS_TOKEN;
                if (accessToken) {
                    await createShopifyDiscount(shopDomain, accessToken, codeName, selectedPrize.type, discountValue, config?.freeGiftCollectionId);
                }
                discountCode = codeName;
            } catch (e) {
                console.error("Shopify Discount Creation Error:", e);
                discountCode = codeName; // Provide mock code if API fails
            }
        }

        // Save Lead to MongoDB
        const expiryDate = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours from now
        
        const newLead = new Lead({
            storeDomain: shopDomain,
            name, email, phone,
            campaign: 'Spin & Win',
            prize: finalPrizeText,
            discountCode,
            selectedVariantId,
            expiry: expiryDate
        });
        await newLead.save();

        res.json({
            prize: finalPrizeText,
            prizeIndex: selectedIndex,
            discountCode,
            selectedVariantId
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('Server Error');
    }
});

router.get('/shopify/collections', async (req, res) => {
    try {
        const shopUrl = process.env.SHOPIFY_SHOP_URL;
        let config = await StoreConfig.findOne({ storeDomain: shopUrl });
        const accessToken = (config && config.accessToken) ? config.accessToken : process.env.SHOPIFY_ACCESS_TOKEN;
        
        if (!accessToken) {
            return res.status(400).json({ error: "Missing SHOPIFY_ACCESS_TOKEN in backend .env" });
        }

        // Fetch both Custom Collections and Smart Collections from Shopify REST API
        const headers = {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json"
        };

        const [customRes, smartRes] = await Promise.all([
            fetch(`https://${shopUrl}/admin/api/2024-04/custom_collections.json`, { headers }),
            fetch(`https://${shopUrl}/admin/api/2024-04/smart_collections.json`, { headers })
        ]);

        if (!customRes.ok || !smartRes.ok) {
            throw new Error(`Shopify API Error: Custom(${customRes.status}), Smart(${smartRes.status})`);
        }

        const customData = await customRes.json();
        const smartData = await smartRes.json();
        
        // Combine and map to simpler format for frontend
        const allCollections = [
            ...(customData.custom_collections || []),
            ...(smartData.smart_collections || [])
        ].map(col => ({
            id: col.id.toString(),
            title: col.title
        }));

        res.json({ collections: allCollections });
    } catch (e) {
        console.error("Shopify Collection Fetch Error:", e);
        res.status(500).json({ collections: [], error: e.message });
    }
});

router.get('/analytics', async (req, res) => {
    try {
        const totalSpins = await Lead.countDocuments();
        
        // Count documents that have an email (real leads)
        const leadsCaptured = await Lead.countDocuments({ email: { $exists: true, $ne: "" } });
        
        // Count documents where used is true or converted is true
        const discountsUsed = await Lead.countDocuments({ 
            $or: [{ used: true }, { converted: true }] 
        });

        const totalConversions = await Lead.countDocuments({ converted: true });

        res.json({
            totalSpins,
            leadsCaptured,
            discountsUsed,
            totalConversions
        });
    } catch (e) {
        console.error("Analytics Error:", e);
        res.status(500).json({ error: 'Server Error' });
    }
});

// GET Store Config
router.get('/config', async (req, res) => {
    try {
        const shopUrl = process.env.SHOPIFY_SHOP_URL;
        let config = await StoreConfig.findOne({ storeDomain: shopUrl });
        
        if (!config) {
            // Create default config if it doesn't exist
            config = new StoreConfig({
                storeDomain: shopUrl,
                prizes: fallbackPrizes
            });
            await config.save();
        }
        
        res.json(config);
    } catch (e) {
        console.error("Config Fetch Error:", e);
        res.status(500).json({ error: 'Server Error' });
    }
});

// POST Store Config
router.post('/config', async (req, res) => {
    try {
        const shopUrl = process.env.SHOPIFY_SHOP_URL;
        const { prizes, freeGiftCollectionId, isActive } = req.body;
        
        let config = await StoreConfig.findOne({ storeDomain: shopUrl });
        if (!config) {
            config = new StoreConfig({ storeDomain: shopUrl });
        }
        
        if (prizes) config.prizes = prizes;
        if (freeGiftCollectionId !== undefined) config.freeGiftCollectionId = freeGiftCollectionId;
        if (isActive !== undefined) config.isActive = isActive;
        
        await config.save();
        res.json(config);
    } catch (e) {
        console.error("Config Save Error:", e);
        res.status(500).json({ error: 'Server Error' });
    }
});

// GET Leads Data for Admin Dashboard
router.get('/leads', async (req, res) => {
    try {
        // Fetch all leads and sort by newest first
        const leads = await Lead.find().sort({ createdAt: -1 });
        res.json({ leads });
    } catch (e) {
        console.error("Leads Fetch Error:", e);
        res.status(500).json({ error: 'Server Error' });
    }
});

module.exports = router;
