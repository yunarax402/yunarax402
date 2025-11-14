// Script to prepare clean server.js for open-source
// Removes payment/subscription code, SDK endpoints, and wallet service

const fs = require('fs');
const path = require('path');

const sourceFile = path.join(__dirname, '..', '..', 'server.js');
const targetFile = path.join(__dirname, 'server.js');

console.log('📝 Preparing clean server.js for open-source...');
console.log(`   Source: ${sourceFile}`);
console.log(`   Target: ${targetFile}`);

if (!fs.existsSync(sourceFile)) {
  console.error('❌ Source server.js not found!');
  process.exit(1);
}

let content = fs.readFileSync(sourceFile, 'utf8');

// Remove wallet-service import
content = content.replace(/const walletService = require\(['"]\.\/wallet-service['"]\);?\n?/g, '');
content = content.replace(/const subscriptionService = require\(['"]\.\/subscription-service['"]\);?\n?/g, '');

// Remove subscription-related functions
content = content.replace(/function sanitizeSubscriptionForClient[\s\S]*?^}/gm, '');
content = content.replace(/async function requireActiveSubscriptionAccess[\s\S]*?^}/gm, '');

// Remove x402PaymentMiddleware function (large block)
const x402Start = content.indexOf('const x402PaymentMiddleware');
if (x402Start !== -1) {
  const x402End = content.indexOf('};', x402Start) + 2;
  if (x402End > x402Start) {
    content = content.substring(0, x402Start) + content.substring(x402End);
  }
}

// Remove subscription endpoints
content = content.replace(/app\.(get|post)\('\/api\/subscriptions\/[^']*'[^}]*\}[^}]*\}\);?\n?/gm, '');
content = content.replace(/app\.(get|post)\('\/api\/wallet\/pay'[^}]*\}[^}]*\}\);?\n?/gm, '');
content = content.replace(/app\.(get|post)\('\/api\/wallet\/[^']*'[^}]*\}[^}]*\}\);?\n?/gm, '');

// Remove SDK endpoints
content = content.replace(/app\.(get|post)\('\/api\/sdk\/[^']*'[^}]*\}[^}]*\}\);?\n?/gm, '');

// Modify /api/analyze to remove subscription checks
content = content.replace(
  /if \(!isPreview\) \{[\s\S]*?subscriptionStatus\.status !== 'active'[\s\S]*?\}/g,
  `if (!isPreview) {
      // Open-source: Authentication optional, no subscription required
      // Users provide their own API keys
    }`
);

// Remove subscription status checks in /api/analyze
content = content.replace(
  /if \(\(subscriptionStatus\.cuBalance \|\| 0\) < ANALYSIS_CU_COST\) \{[\s\S]*?\}/g,
  '// Open-source: No CU checks'
);

// Remove ANALYSIS_CU_COST constant
content = content.replace(/const ANALYSIS_CU_COST = \d+;\n?/g, '');

// Remove payment-related CONFIG
content = content.replace(/recipientWallet: [^,]+,\n?/g, '');
content = content.replace(/recipientWallets: [^,]+,\n?/g, '');
content = content.replace(/facilitatorUrl[^,]+,\n?/g, '');
content = content.replace(/usdcContract: [^,]+,\n?/g, '');

// Remove wallet service usage
content = content.replace(/walletService\.[^;]+;/g, '');

console.log('✅ Processing complete!');
console.log('⚠️  Manual review required - check server.js for any remaining payment code');

fs.writeFileSync(targetFile, content);
console.log(`✅ Clean server.js written to: ${targetFile}`);

