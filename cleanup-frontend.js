// Script to clean frontend files for open-source
// Removes payment/subscription UI code

const fs = require('fs');
const path = require('path');

const scriptPath = path.join(__dirname, 'public', 'script.js');
const htmlPath = path.join(__dirname, 'public', 'index.html');

console.log('🧹 Cleaning frontend files for open-source...\n');

// Clean script.js
if (fs.existsSync(scriptPath)) {
    let content = fs.readFileSync(scriptPath, 'utf8');
    
    // Replace subscription status loaded
    content = content.replace(
        /let subscriptionStatusLoaded = false;/g,
        "let subscriptionStatusLoaded = true; // Open-source: No subscription needed"
    );
    
    // Replace determineSubscriptionLockReason
    content = content.replace(
        /function determineSubscriptionLockReason\(\) \{[\s\S]*?return 'subscription_required';[\s\S]*?\}/g,
        `function determineSubscriptionLockReason() {
    // Open-source: No subscription locks - all features available
    return 'bypass';
}`
    );
    
    // Replace handleAiPaywallPrimaryAction
    content = content.replace(
        /function handleAiPaywallPrimaryAction\(reason = 'subscription_required'\) \{[\s\S]*?showPaymentModal\(\);[\s\S]*?\}/g,
        `function handleAiPaywallPrimaryAction(reason = 'subscription_required') {
    // Open-source: No payment required - features always available
    if (!currentUser) {
        loginWithGoogle();
        return;
    }
    // No payment modal needed
}`
    );
    
    // Replace 402 error handling in analyzeToken
    content = content.replace(
        /} else if \(response\.status === 402\) \{[\s\S]*?await showPaymentModal\(errorData\);/g,
        `} else if (response.status === 402) {
            // Open-source: Should not receive 402 errors (no payment required)
            // If we do, it's likely an API key issue
            const errorData = await response.json().catch(() => ({}));
            modal.classList.remove('active');
            const warningMessage = errorData.message || 'Analysis failed. Please check your API keys in .env file.';
            showToast(warningMessage, 'warning');`
    );
    
    // Replace showPaymentModal with no-op
    const paymentModalMatch = content.match(/async function showPaymentModal\([^)]*\) \{[\s\S]*?\n\}/);
    if (paymentModalMatch) {
        content = content.replace(
            paymentModalMatch[0],
            `// Open-source: Payment modal removed - no payment required
async function showPaymentModal(paymentInfo = {}) {
    console.log('Payment modal called (open-source: no payment required)');
}`
        );
    }
    
    // Replace purchaseSubscriptionPlan with no-op
    const purchaseMatch = content.match(/async function purchaseSubscriptionPlan\([^)]*\) \{[\s\S]*?\n\}/);
    if (purchaseMatch) {
        content = content.replace(
            purchaseMatch[0],
            `// Open-source: No subscription purchases needed
async function purchaseSubscriptionPlan(planId, button) {
    showToast('Open-source version: No payment required. Configure your API keys in .env file.', 'info');
}`
        );
    }
    
    fs.writeFileSync(scriptPath, content);
    console.log('✅ script.js cleaned');
} else {
    console.log('⚠️  script.js not found');
}

// Clean index.html - comment out payment modal
if (fs.existsSync(htmlPath)) {
    let content = fs.readFileSync(htmlPath, 'utf8');
    
    // Comment out payment modal
    content = content.replace(
        /<!-- Subscription Modal -->[\s\S]*?<!-- Toast Notification -->/,
        `<!-- Open-source: Payment modal removed - no payment required -->
    <!-- Subscription Modal removed for open-source version -->
    
    <!-- Toast Notification -->`
    );
    
    fs.writeFileSync(htmlPath, content);
    console.log('✅ index.html cleaned');
} else {
    console.log('⚠️  index.html not found');
}

console.log('\n✅ Frontend cleanup complete!');
console.log('⚠️  Manual review recommended - check for any remaining payment code');

