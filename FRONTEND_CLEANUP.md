# Frontend Cleanup Guide for Open-Source

This guide helps you remove payment/subscription UI from the frontend files.

## Files to Update

### 1. `public/script.js`

#### Remove/Modify Subscription Functions:

**FIND (around line 162-186):**
```javascript
function determineSubscriptionLockReason() {
    // ... subscription checks ...
}

function handleAiPaywallPrimaryAction(reason = 'subscription_required') {
    // ... payment modal calls ...
}
```

**REPLACE WITH:**
```javascript
// Open-source: No subscription locks - all features available
function determineSubscriptionLockReason() {
    return 'bypass'; // Always bypass in open-source version
}

function handleAiPaywallPrimaryAction(reason = 'subscription_required') {
    // Open-source: No payment required - features always available
    if (!currentUser) {
        loginWithGoogle();
        return;
    }
    // No payment modal needed
}
```

**FIND (around line 28):**
```javascript
let subscriptionStatusLoaded = false;
```

**REPLACE WITH:**
```javascript
let subscriptionStatusLoaded = true; // Always "loaded" in open-source (no subscription needed)
```

**FIND (around line 4233-4240):**
```javascript
} else if (response.status === 402) {
    const errorData = await response.json().catch(() => ({}));
    modal.classList.remove('active');
    const warningMessage = errorData.error === 'insufficient_cu'
        ? 'You are out of compute units. Please upgrade or top up your subscription.'
        : 'Activate a subscription plan to run full AI analysis.';
    showToast(warningMessage, 'warning');
    await showPaymentModal(errorData);
```

**REPLACE WITH:**
```javascript
} else if (response.status === 402) {
    // Open-source: Should not receive 402 errors (no payment required)
    // If we do, it's likely an API key issue
    const errorData = await response.json().catch(() => ({}));
    modal.classList.remove('active');
    const warningMessage = errorData.message || 'Analysis failed. Please check your API keys in .env file.';
    showToast(warningMessage, 'warning');
```

**REMOVE/REPLACE (around line 4254-4348):**
- `showPaymentModal()` function - Replace with no-op
- `closePaymentModal()` function - Replace with no-op
- `processPayment()` function - Replace with no-op
- `openSubscriptionPlansFromModal()` function - Replace with no-op

**REMOVE/REPLACE (around line 2081-2192):**
- `purchaseSubscriptionPlan()` function - Replace with simple no-op

**REMOVE/REPLACE (around line 2193-2245):**
- `generateSubscriptionApiKey()` function - Remove or replace with no-op

**FIND and REMOVE:**
- All `loadSubscriptionStatus()` calls
- All subscription status checks
- All payment modal references

### 2. `public/index.html`

**FIND (around line 631-659):**
```html
<!-- Subscription Modal -->
<div id="payment-modal" class="modal">
    ...
</div>
```

**REPLACE WITH:**
```html
<!-- Open-source: Payment modal removed - no payment required -->
```

**FIND and REMOVE:**
- All wallet dashboard UI (if you want to remove it)
- Subscription plan displays
- Payment buttons

### 3. Quick Find/Replace

Search for these patterns and remove/replace:
- `showPaymentModal` → Replace with no-op function
- `purchaseSubscriptionPlan` → Replace with no-op function
- `subscription_required` → Replace with `'bypass'`
- `402` status checks → Replace with API key error messages
- `currentSubscription` checks → Remove or always return true

## Testing After Cleanup

1. Open the app in browser
2. Try to analyze a token - should work without payment
3. Check console for any subscription-related errors
4. Verify no payment modals appear

