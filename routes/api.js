const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const StoreConfig = require('../models/StoreConfig');
const shopify = require('../shopify');

// Helper to create real Shopify Discount via Admin API
async function createShopifyDiscount(shopUrl, accessToken, discountValue, codeName) {
    const headers = {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json"
    };

    // 1. Create Price Rule
    const ruleResponse = await fetch(`https://${shopUrl}/admin/api/2024-04/price_rules.json`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            price_rule: {
                title: codeName,
                target_type: "line_item",
                target_selection: "all",
                allocation_method: "across",
                value_type: "percentage",
                value: `-${discountValue}.0`,
                customer_selection: "all",
                starts_at: new Date().toISOString()
            }
        })
    });

    if (!ruleResponse.ok) {
        throw new Error(`Failed to create Price Rule: ${await ruleResponse.text()}`);
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

        // Generate Real Shopify Discount Code
        if (selectedPrize.type === 'percentage') {
            const valMatch = selectedPrize.label.match(/\d+/);
            const discountValue = valMatch ? valMatch[0] : 10;
            const codeName = `SPIN${discountValue}-${Math.random().toString(36).substring(2,8).toUpperCase()}`;
            
            try {
                const accessToken = (config && config.accessToken) ? config.accessToken : process.env.SHOPIFY_ACCESS_TOKEN;
                if (accessToken) {
                    await createShopifyDiscount(shopDomain, accessToken, discountValue, codeName);
                }
                discountCode = codeName;
            } catch (e) {
                console.error("Shopify Discount Creation Error:", e);
                discountCode = codeName; // Provide mock code if API fails
            }
        } else if (selectedPrize.type === 'free_accessory') {
            selectedVariantId = '40012345678901'; // Mock Variant ID
            discountCode = `FREEGIFT-${Math.random().toString(36).substring(2,8).toUpperCase()}`;
        }

        // Save Lead to MongoDB
        const expiryDate = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours from now
        
        const newLead = new Lead({
            storeDomain: shopDomain,
            name, email, phone,
            campaign: 'Spin & Win',
            prize: selectedPrize.label,
            discountCode,
            selectedVariantId,
            expiry: expiryDate
        });
        await newLead.save();

        res.json({
            prize: selectedPrize.label,
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
