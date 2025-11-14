# Cleanup Guide for Open-Source server.js

This guide helps you remove payment/subscription code from server.js to create a clean open-source version.

## Quick Cleanup Steps

### 1. Remove Imports (Lines ~12-14)
```javascript
// REMOVE these lines:
const walletService = require('./wallet-service');
const subscriptionService = require('./subscription-service');
```

### 2. Remove Functions (Lines ~21-72)
```javascript
// REMOVE these entire functions:
- sanitizeSubscriptionForClient()
- requireActiveSubscriptionAccess()
```

### 3. Remove Subscription Endpoints (Lines ~94-266)
```javascript
// REMOVE all these endpoints:
- app.get('/api/subscriptions/plans')
- app.get('/api/subscriptions/status')
- app.post('/api/subscriptions/activate')
- app.post('/api/subscriptions/purchase')
- app.post('/api/subscriptions/cancel')
- app.post('/api/subscriptions/api-keys')
- app.get('/api/subscriptions/api-keys')
- app.delete('/api/subscriptions/api-keys/:keyId')
```

### 4. Remove Payment/Wallet Endpoints
```javascript
// REMOVE:
- app.post('/api/wallet/pay')
- app.get('/api/wallet')
- app.post('/api/wallet/refresh')
- app.get('/api/wallet/all')
- app.post('/api/wallet/create-crossmint')
- app.get('/api/wallet/crossmint-status')
```

### 5. Remove SDK Endpoints
```javascript
// REMOVE:
- app.post('/api/sdk/analyze')
```

### 6. Remove x402PaymentMiddleware Function
Find and remove the entire `const x402PaymentMiddleware = (requiredAmount) => { ... }` function (large block, ~1000+ lines).

### 7. Modify /api/analyze Endpoint (Line ~5414)

**FIND:**
```javascript
if (!isPreview) {
  if (!(req.isAuthenticated && req.isAuthenticated())) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  userId = req.user.id;
  // ... subscription checks ...
  if (!subscriptionStatus || subscriptionStatus.status !== 'active') {
    return res.status(402).json({ error: 'subscription_required' });
  }
  if ((subscriptionStatus.cuBalance || 0) < ANALYSIS_CU_COST) {
    return res.status(402).json({ error: 'insufficient_cu' });
  }
}
```

**REPLACE WITH:**
```javascript
// Open-source: No subscription required
// Users provide their own API keys
if (!isPreview && req.isAuthenticated && req.isAuthenticated()) {
  userId = req.user.id;
  // Optional: Save analysis to user's saved analyses
}
```

### 8. Remove Payment-Related CONFIG (Line ~350)

**FIND:**
```javascript
const CONFIG = {
  // ... API keys ...
  recipientWallet: getRecipientWallet('base'),
  recipientWallets: RECIPIENT_WALLETS,
  facilitatorUrl: ...,
  facilitatorUrlSolana: ...,
  facilitatorUrlEthereum: ...,
  facilitatorUrlBnb: ...,
  usdcContract: ...,
  // ...
};
```

**REPLACE WITH:**
```javascript
const CONFIG = {
  moralisApiKey: process.env.MORALIS_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  twitterApiKey: process.env.TWITTER_API_KEY,
  grokApiKey: process.env.GROK_API_KEY || '',
  rugCheckApiKey: process.env.RUGCHECK_API_KEY || '',
  twitterUsername: TWITTER_USERNAME,
  heliusApiKey: process.env.HELIUS_API_KEY || '',
  port: process.env.PORT || 3000
};
```

### 9. Remove ANALYSIS_CU_COST Constant (Line ~389)
```javascript
// REMOVE:
const ANALYSIS_CU_COST = 1;
```

### 10. Remove Wallet/Recipient Functions (Lines ~282-348)
```javascript
// REMOVE:
- normalizeRecipientWallet()
- normalizeSolanaRecipientWallet()
- getRecipientWallet()
- RECIPIENT_WALLETS constant
```

### 11. Remove AI Chat PRO Mode Checks (Line ~5853)

**FIND:**
```javascript
// Check if user has active subscription for PRO mode
let isPro = false;
let subscriptionStatus = null;
if (req.isAuthenticated && req.isAuthenticated()) {
  subscriptionStatus = await subscriptionService.getSubscriptionStatus(req.user.id);
  isPro = subscriptionStatus && subscriptionStatus.status === 'active';
}
```

**REPLACE WITH:**
```javascript
// Open-source: All users get full analysis (no PRO mode restrictions)
let isPro = true; // Always enable full features
```

### 12. Remove Subscription Usage Tracking

**FIND:**
```javascript
// Save analysis to user's saved analyses
if (req.isAuthenticated && req.isAuthenticated()) {
  // ... usage tracking with subscriptionService.consumeComputeUnits ...
}
```

**REPLACE WITH:**
```javascript
// Save analysis to user's saved analyses (optional)
if (req.isAuthenticated && req.isAuthenticated()) {
  // No usage tracking needed in open-source version
}
```

## Verification Checklist

After cleanup, verify:
- [ ] No `subscriptionService` references
- [ ] No `walletService` references  
- [ ] No `x402PaymentMiddleware` references
- [ ] No `/api/subscriptions/*` endpoints
- [ ] No `/api/wallet/*` endpoints
- [ ] No `/api/sdk/*` endpoints
- [ ] `/api/analyze` works without subscription checks
- [ ] `/api/ai-chat` works without PRO mode restrictions
- [ ] Server starts without errors

## Testing

After cleanup:
1. `npm install`
2. Create `.env` with your API keys
3. `npm start`
4. Test `/api/analyze` endpoint
5. Test `/api/ai-chat` endpoint
6. Verify no payment/subscription errors in console

