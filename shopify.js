const { shopifyApi, ApiVersion } = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');

const shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES.split(','),
    hostName: process.env.HOST.replace(/https?:\/\//, ''),
    apiVersion: ApiVersion.July26,
    isEmbeddedApp: false, // User requested a standalone app
});

module.exports = shopify;
