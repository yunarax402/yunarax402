# Preparing server.js for Open-Source

This document outlines the changes needed to create a clean open-source version of server.js.

## Changes Required

### 1. Remove Payment/Subscription Code

Remove or comment out:
- All `x402PaymentMiddleware` references
- All subscription service checks
- All payment endpoints (`/api/subscriptions/*`, `/api/wallet/pay`)
- `requireActiveSubscriptionAccess` middleware
- SDK endpoints (`/api/sdk/*`)
- Wallet service imports and usage

### 2. Modify `/api/analyze` Endpoint

Change from:
```javascript
// Check subscription
if (!subscriptionStatus || subscriptionStatus.status !== 'active') {
  return res.status(402).json({ error: 'subscription_required' });
}
```

To:
```javascript
// Open-source: No subscription required
// Users provide their own API keys
```

### 3. Remove Wallet Service

- Remove `const walletService = require('./wallet-service');`
- Remove all wallet-related endpoints
- Remove Crossmint integration

### 4. Keep Core Functionality

- Keep all analysis functions (`performTokenAnalysis`, `fetchGrokTwitterInsights`)
- Keep search endpoints
- Keep AI chat (remove PRO mode checks)
- Keep authentication (optional)
- Keep all Moralis integration

### 5. Update CONFIG

Remove payment-related config:
- Remove `recipientWallet`, `facilitatorUrl`, etc.
- Keep only API keys: `moralisApiKey`, `geminiApiKey`, `openaiApiKey`, `grokApiKey`

## Automated Script

Run `prepare-server.js` to automatically process server.js:

```bash
node prepare-server.js
```

This will create `server-clean.js` with all payment code removed.

