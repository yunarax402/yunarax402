require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { ethers } = require('ethers');
const NodeCache = require('node-cache');
const Moralis = require('moralis').default;
const compression = require('compression');
const passport = require('passport');

// Import auth and wallet services
const { initializePassport, requireAuth, isAuthenticated, getUserById, loadUsers, saveUsers } = require('./auth');

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // 10-minute default cache
const fs = require('fs').promises;
const path = require('path');





// Initialize Moralis
let moralisInitialized = false;

// Trust proxy (required for cookies/sessions behind Nginx reverse proxy)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1); // Trust first proxy (Nginx)
}

// Middleware
app.use(compression()); // Enable gzip compression for faster responses
app.use(cors({
  origin: true,
  credentials: true // Allow cookies
}));
app.use(express.json());
app.use(express.static('public'));

// Initialize authentication
initializePassport(app);

// ===== Subscription & API Access =====

app.get('/api/subscriptions/plans', (req, res) => {
  try {
    const plans = subscriptionService.getPlans();
    res.json({ success: true, plans });
  } catch (error) {
    console.error('Error fetching subscription plans:', error);
    res.status(500).json({ success: false, error: 'Failed to load subscription plans' });
  }
});

app.get('/api/subscriptions/status', requireAuth, async (req, res) => {
  try {
    const subscription = await subscriptionService.getSubscriptionStatus(req.user.id);
    res.json({ success: true, subscription });
  } catch (error) {
    console.error('Error fetching subscription status:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to load subscription status' });
  }
});

app.post('/api/subscriptions/activate', requireAuth, async (req, res) => {
  try {
    const { planId, autoRenew } = req.body || {};
    if (!planId) {
      return res.status(400).json({ success: false, error: 'planId is required' });
    }

    const subscription = await subscriptionService.activateSubscription(req.user.id, planId, { autoRenew });
    res.json({ success: true, subscription });
  } catch (error) {
    console.error('Error activating subscription:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to activate subscription' });
  }
});

app.post('/api/subscriptions/purchase', requireAuth, (req, res) => {
  const { planId, autoRenew, txHash } = req.body || {};

  if (!planId) {
    return res.status(400).json({ success: false, error: 'planId is required' });
  }

  const plan = subscriptionService.getPlanById(planId);
  if (!plan) {
    return res.status(400).json({ success: false, error: 'Invalid subscription plan' });
  }

  const requiredAmount = plan.monthlyPriceUsd.toFixed(2);
  
  // Use x402PaymentMiddleware to handle payment (all payments go through x402 facilitators)
  const middleware = x402PaymentMiddleware(requiredAmount);

  middleware(req, res, async (err) => {
    if (err) {
      console.error('Subscription payment verification error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Payment verification failed', details: err.message });
      }
      return;
    }

    try {
      // Payment verified - get payment details from headers
      const paymentHeader = req.headers['x-payment'];
      let paymentSource = 'x402';
      let metadataTxHash = txHash || req.headers['x-payment-txhash'] || null;
      let paymentChain = req.headers['x-payment-chain'] || 'base';
      
      // Decode payment proof if available
      if (paymentHeader) {
        try {
          const paymentProof = Buffer.from(paymentHeader, 'base64').toString('utf-8');
          if (!paymentProof.startsWith('free-credit-')) {
            try {
              const paymentData = JSON.parse(paymentProof);
              metadataTxHash = paymentData.txHash || metadataTxHash;
              paymentChain = paymentData.chain || paymentChain;
              paymentSource = paymentData.source || 'server-wallet';
            } catch (e) {
              // Legacy format - plain txHash
              metadataTxHash = paymentProof;
            }
          }
        } catch (e) {
          console.warn('Could not decode payment header:', e);
        }
      }
      
      console.log(`✅ Payment verified for subscription purchase:`, {
        planId,
        amount: requiredAmount,
        txHash: metadataTxHash,
        chain: paymentChain,
        source: paymentSource
      });
      
      // Activate subscription
      const subscription = await subscriptionService.activateSubscription(req.user.id, planId, {
        autoRenew,
        paymentSource: paymentSource,
        txHash: metadataTxHash,
        chain: paymentChain
      });
      
      res.json({ 
        success: true, 
        subscription,
        payment: {
          txHash: metadataTxHash,
          chain: paymentChain,
          amount: requiredAmount,
          source: paymentSource
        }
      });
    } catch (error) {
      console.error('Error finalizing subscription purchase:', error);
      if (!res.headersSent) {
        res.status(500).json({ 
          success: false, 
          error: error.message || 'Failed to activate subscription' 
        });
      }
    }
  });
});

app.post('/api/subscriptions/cancel', requireAuth, async (req, res) => {
  try {
    await subscriptionService.cancelSubscription(req.user.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to cancel subscription' });
  }
});

app.post('/api/subscriptions/api-keys', requireAuth, async (req, res) => {
  try {
    const { label } = req.body || {};
    const result = await subscriptionService.generateApiKey(req.user.id, label || 'SDK Key');
    res.json({ success: true, apiKey: result.apiKey, key: result.key });
  } catch (error) {
    console.error('Error generating API key:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to generate API key' });
  }
});

app.get('/api/subscriptions/api-keys', requireAuth, async (req, res) => {
  try {
    const keys = await subscriptionService.listApiKeys(req.user.id);
    res.json({ success: true, keys });
  } catch (error) {
    console.error('Error listing API keys:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to load API keys' });
  }
});

app.delete('/api/subscriptions/api-keys/:keyId', requireAuth, async (req, res) => {
  try {
    const { keyId } = req.params;
    if (!keyId) {
      return res.status(400).json({ success: false, error: 'keyId is required' });
    }

    await subscriptionService.revokeApiKey(req.user.id, keyId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error revoking API key:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to revoke API key' });
  }
});

// Configuration
function normalizeTwitterHandle(handle) {
  if (!handle) return null;
  const trimmed = handle.trim();
  if (!trimmed) return null;
  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return withoutAt;
}

const twitterHandleEnv = normalizeTwitterHandle(process.env.TWITTER_USERNAME);
const TWITTER_USERNAME = twitterHandleEnv && twitterHandleEnv.toLowerCase() !== 'yunarax402'
  ? twitterHandleEnv
  : 'YunaraX402';

const FALLBACK_RECIPIENT_WALLET = '0x6a4F1d1B077356A84b0853760a7759DdCA5CAfAd';
const FALLBACK_SOLANA_RECIPIENT_WALLET = '8fwoY65qh4UryqsjDy2FHw6Cz7x6rU5AZAS58rxhrgXY';

function normalizeRecipientWallet(address) {
  if (!address) {
    console.warn('RECIPIENT_WALLET_ADDRESS missing. Using fallback Yunara treasury wallet.');
    return FALLBACK_RECIPIENT_WALLET;
  }

  const trimmed = address.trim();
  if (!trimmed) {
    console.warn('RECIPIENT_WALLET_ADDRESS empty after trimming. Using fallback Yunara treasury wallet.');
    return FALLBACK_RECIPIENT_WALLET;
  }

  try {
    if (!ethers.utils.isAddress(trimmed)) {
      console.warn(`Invalid RECIPIENT_WALLET_ADDRESS "${trimmed}". Using fallback Yunara treasury wallet.`);
      return FALLBACK_RECIPIENT_WALLET;
    }
    return ethers.utils.getAddress(trimmed);
  } catch (error) {
    console.warn(`Failed to normalize RECIPIENT_WALLET_ADDRESS "${trimmed}". Using fallback Yunara treasury wallet.`, error);
    return FALLBACK_RECIPIENT_WALLET;
  }
}

function normalizeSolanaRecipientWallet(address) {
  if (!address) {
    console.warn('RECIPIENT_WALLET_ADDRESS_SOLANA missing. Using fallback Solana treasury wallet.');
    return FALLBACK_SOLANA_RECIPIENT_WALLET;
  }

  const trimmed = address.trim();
  if (!trimmed) {
    console.warn('RECIPIENT_WALLET_ADDRESS_SOLANA empty after trimming. Using fallback Solana treasury wallet.');
    return FALLBACK_SOLANA_RECIPIENT_WALLET;
  }

  try {
    const { PublicKey } = require('@solana/web3.js');
    return new PublicKey(trimmed).toBase58();
  } catch (error) {
    console.warn(`Failed to normalize RECIPIENT_WALLET_ADDRESS_SOLANA "${trimmed}". Using fallback Solana treasury wallet.`, error);
    return FALLBACK_SOLANA_RECIPIENT_WALLET;
  }
}

const RECIPIENT_WALLETS = 

// Log recipient addresses on startup (for debugging)
console.log('💰 Recipient Wallets Configured:', {
  evm: RECIPIENT_WALLETS.evm,
  solana: RECIPIENT_WALLETS.solana,
  evmEnv: process.env.RECIPIENT_WALLET_ADDRESS ? 'SET' : 'MISSING',
  solanaEnv: process.env.RECIPIENT_WALLET_ADDRESS_SOLANA ? 'SET' : 'MISSING'
});

function getRecipientWallet(chain = 'base') {
  if (chain === 'solana') {
    return RECIPIENT_WALLETS.solana;
  }
  return RECIPIENT_WALLETS.evm;
}

const CONFIG = {
  moralisApiKey: process.env.MORALIS_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  twitterApiKey: process.env.TWITTER_API_KEY,
  grokApiKey: process.env.GROK_API_KEY || '', // Grok API key for Twitter insights
      baseRpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
   // Base x402 facilitator
   // Solana x402 facilitator
   // Ethereum x402 facilitator
   // BNB Chain x402 facilitator
   // Base USDC
  rugCheckApiKey: process.env.RUGCHECK_API_KEY || '', // Optional: RugCheck API key
  twitterUsername: TWITTER_USERNAME, // Your Twitter/X username for quest verification
  heliusApiKey: process.env.HELIUS_API_KEY || '', // Optional: Helius API key for enhanced metadata
  port: process.env.PORT || 3000
};

const DEFAULT_PUBLIC_BASE_URL = process.env.NODE_ENV === 'production'
  ? 'https://yunarax402.com'
  : `http://localhost:${CONFIG.port}`;

const RAW_PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL
  || process.env.APP_BASE_URL
  || process.env.FRONTEND_BASE_URL
  || DEFAULT_PUBLIC_BASE_URL;

const PUBLIC_BASE_URL = RAW_PUBLIC_BASE_URL.replace(/\/+$/, '');

const INTERNAL_BASE_URL = (process.env.INTERNAL_BASE_URL
  || (process.env.NODE_ENV === 'production'
    ? `http://127.0.0.1:${CONFIG.port}`
    : `http://localhost:${CONFIG.port}`)).replace(/\/+$/, '');

const RUGCHECK_SAFE_THRESHOLD = 29; // Require RugCheck score <= 29 to qualify
const RUGCHECK_CACHE_TTL = 30 * 60; // 30 minutes


function getRugCheckStatusLabel(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) {
    return 'unknown';
  }

  const numericScore = Number(score);

  if (numericScore <= 20) return 'safe';
  if (numericScore <= 40) return 'low-risk';
  if (numericScore <= 70) return 'medium-risk';
  return 'high-risk';
}

async function fetchRugCheckAnalysis(address, { allowCached = true } = {}) {
  if (!address) {
    return {
      address,
      report: null,
      score: null,
      status: 'error',
      safe: false,
      error: 'Missing token address',
      timestamp: new Date().toISOString()
    };
  }

  const cacheKey = `rugcheck-${address}`;
  if (allowCached) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  try {
    const response = await axios.get(
      `https://api.rugcheck.xyz/v1/tokens/${address}/report`,
      {
        headers: {
          Accept: 'application/json',
          ...(CONFIG.rugCheckApiKey && { Authorization: `Bearer ${CONFIG.rugCheckApiKey}` })
        },
        timeout: 15000
      }
    );

    const report = response.data || null;
    const rawScore = report?.score_normalised ?? report?.score ?? null;
    const numericScore = rawScore !== null ? Number(rawScore) : null;
    const status = getRugCheckStatusLabel(numericScore);
    const safe = numericScore !== null ? numericScore <= RUGCHECK_SAFE_THRESHOLD : false;

    const result = {
      address,
      report,
      score: numericScore,
      status,
      safe,
      timestamp: new Date().toISOString()
    };

    cache.set(cacheKey, result, RUGCHECK_CACHE_TTL);
    return result;
  } catch (error) {
    const errorPayload = {
      address,
      report: null,
      score: null,
      status: 'error',
      safe: false,
      error: error.message,
      errorCode: error.response?.status,
      timestamp: new Date().toISOString()
    };

    cache.set(cacheKey, errorPayload, 60);
    return errorPayload;
  }
}

async function performTokenAnalysis({ tokenData, chain, address, isPreview }) {
  // Fetch comprehensive token data
  // Use tokenData as base (search results now include comprehensive data)
  let comprehensiveData = { 
    ...tokenData,
    // Preserve any comprehensive fields from search results
    holders: tokenData.holders || 0,
    volume24h: tokenData.volume24h || 0,
    liquidity: tokenData.liquidity || 0,
    marketCap: tokenData.marketCap || 0,
    priceChange24h: tokenData.priceChange24h || 0
  };
  
  // Get full token details if chain and address provided (for additional data not in search results)
  if (chain && address) {
    try {
      // Use the correct base URL for production vs development
      const detailsResponse = await axios.get(
        `${INTERNAL_BASE_URL}/api/token-details/${chain}/${address}`,
        { timeout: 10000 }
      );
      if (detailsResponse.data) {
        comprehensiveData.fullDetails = detailsResponse.data;
        
        // Merge holder stats from token details if not already in tokenData
        if (detailsResponse.data.holderStats && !comprehensiveData.holderStats) {
          comprehensiveData.holderStats = detailsResponse.data.holderStats;
          comprehensiveData.holders = detailsResponse.data.holderStats.totalHolders || comprehensiveData.holders;
        }
        
        // Merge pairs data (volume/liquidity) if not already in tokenData
        if (detailsResponse.data.pairs && detailsResponse.data.pairs.length > 0) {
          let totalLiquidity = 0;
          let totalVolume = 0;
          detailsResponse.data.pairs.forEach(pair => {
            totalLiquidity += parseFloat(pair.liquidity_usd || pair.totalLiquidity || 0);
            totalVolume += parseFloat(pair.volume_24h || pair.total24hVolume || 0);
          });
          if (totalLiquidity > 0) comprehensiveData.liquidity = totalLiquidity;
          if (totalVolume > 0) comprehensiveData.volume24h = totalVolume;
        }
      }
    } catch (err) {
      console.log('Could not fetch full token details:', err.message);
    }

    // Get RugCheck for Solana tokens
    if (chain === 'solana') {
      try {
        const rugcheckResponse = await axios.get(
          `${INTERNAL_BASE_URL}/api/rugcheck/${address}`,
          { timeout: 10000 }
        );
        if (rugcheckResponse.data && !rugcheckResponse.data.error) {
          comprehensiveData.rugcheck = rugcheckResponse.data;
        }
      } catch (err) {
        console.log('Could not fetch RugCheck:', err.message);
      }
    }

    // Get holder statistics for Solana and EVM chains
    try {
      if (chain === 'solana') {
        const holderStatsResponse = await axios.get(
          `${INTERNAL_BASE_URL}/api/holder-stats/solana/${address}`,
          { timeout: 10000 }
        );
        if (holderStatsResponse.data && !holderStatsResponse.data.error) {
          comprehensiveData.holderStats = holderStatsResponse.data;
          console.log(`✓ Holder stats: ${holderStatsResponse.data.totalHolders} holders, acquisition breakdown available`);
        }
      } else if (['bnb', 'base', 'ethereum', 'eth'].includes((chain || '').toLowerCase())) {
        // Fetch EVM holder stats
        const holderStatsResponse = await axios.get(
          `${INTERNAL_BASE_URL}/api/holder-stats/evm/${chain}/${address}`,
          { timeout: 10000 }
        );
        if (holderStatsResponse.data && !holderStatsResponse.data.error) {
          comprehensiveData.holderStats = holderStatsResponse.data;
          console.log(`✓ EVM Holder stats: ${holderStatsResponse.data.totalHolders} holders, acquisition breakdown available`);
        }
      }
    } catch (err) {
      console.log('Could not fetch holder stats:', err.message);
    }
  }

  // Fetch Grok insights for both paid and preview analyses
  let grokInsights = null;
  const tokenName = comprehensiveData.name || tokenData.name || 'Unknown Token';
  const tokenSymbol = comprehensiveData.symbol || tokenData.symbol || 'UNKNOWN';
  const tokenAddress = comprehensiveData.address || address || tokenData.address;
  
  // ALWAYS try to fetch Grok insights (even if API key check fails, let the function handle it)
  try {
    console.log(`🤖 [GROK] Starting Grok fetch for ${isPreview ? 'preview' : 'paid'} analysis...`);
    console.log(`   [GROK] Token: ${tokenName} (${tokenSymbol})`);
    console.log(`   [GROK] Address: ${tokenAddress}`);
    console.log(`   [GROK] API Key check: ${CONFIG.grokApiKey ? `PRESENT (${CONFIG.grokApiKey.substring(0, 10)}...)` : 'MISSING'}`);
    console.log(`   [GROK] Token data:`, {
      price: comprehensiveData.price || tokenData.price,
      marketCap: comprehensiveData.marketCap || tokenData.marketCap,
      volume24h: comprehensiveData.volume24h || tokenData.volume24h,
      liquidity: comprehensiveData.liquidity || tokenData.liquidity,
      holders: comprehensiveData.holders || tokenData.holders,
      priceChange24h: comprehensiveData.priceChange24h || tokenData.priceChange24h,
      chain: chain || comprehensiveData.chain || tokenData.chain
    });
    
    // Pass comprehensive token data to Grok
    grokInsights = await fetchGrokTwitterInsights(
      tokenName, 
      tokenSymbol, 
      tokenAddress,
      {
        ...comprehensiveData,
        ...tokenData,
        price: comprehensiveData.price || tokenData.price,
        marketCap: comprehensiveData.marketCap || tokenData.marketCap,
        volume24h: comprehensiveData.volume24h || tokenData.volume24h,
        liquidity: comprehensiveData.liquidity || tokenData.liquidity,
        holders: comprehensiveData.holders || tokenData.holders,
        priceChange24h: comprehensiveData.priceChange24h || tokenData.priceChange24h,
        chain: chain || comprehensiveData.chain || tokenData.chain
      }
    );
    
    if (grokInsights && grokInsights.trim().length > 0) {
      console.log(`✅ [GROK] Insights received successfully (${grokInsights.length} chars)`);
      console.log(`   [GROK] Preview: ${grokInsights.substring(0, 150)}...`);
    } else {
      console.log(`⚠️ [GROK] Insights returned null/empty - function may have failed silently`);
      console.log(`   [GROK] This could mean: API key missing, API call failed, or model not available`);
    }
  } catch (grokError) {
    console.error('❌ [GROK] Exception caught while fetching Grok insights:', grokError.message);
    console.error('   [GROK] Error stack:', grokError.stack);
    console.error('   [GROK] Full error:', grokError);
    // Don't fail the analysis if Grok fails
    grokInsights = null;
  }

  // Prepare comprehensive analysis prompt
  const prompt = `You are an expert cryptocurrency analyst with deep knowledge of DeFi, tokenomics, security, and market dynamics. 

Analyze this token comprehensively using ALL available data and provide a detailed professional analysis.

AVAILABLE DATA:
${JSON.stringify(comprehensiveData, null, 2)}

ANALYSIS REQUIREMENTS:

1. **Executive Summary** (2-3 sentences): Key takeaways and overall assessment

2. **Risk Assessment** (Low/Medium/High/Very High):
   - Consider: Liquidity levels, holder concentration, security (RugCheck if Solana), contract verification, market cap, volume, price volatility
   - Provide detailed risk factors and risk score (0-100)

3. **Security Analysis**:
   - Contract verification status
   - RugCheck score (if available)
   - Liquidity lock status
   - Ownership renounced status
   - Holder distribution analysis
   - Any red flags or security concerns

4. **Market Analysis**:
   - Current price and 24h change
   - Market cap assessment
   - Liquidity depth
   - Volume trends
   - Trading indicators (RSI, MA, Momentum, Fibonacci if available)
   - Price action and trend analysis

5. **Tokenomics & Fundamentals**:
   - **Holder Statistics** (CRITICAL - USE holderStats data if available):
     * Total holder count (holderStats.totalHolders) - analyze if this indicates wide distribution or concentration
     * Holder acquisition breakdown (holderStats.holdersByAcquisition):
       - Swap percentage: Higher swap % indicates organic trading/interest
       - Transfer percentage: May indicate P2P distribution or bot activity
       - Airdrop percentage: May indicate marketing strategy or initial distribution
     * Calculate and discuss what these percentages mean for token health and distribution quality
   - Token age/maturity
   - Launchpad reputation
   - DEX listing status
   - Community metrics (if available)

6. **Key Opportunities** (array of 3-5 specific opportunities):
   - Be specific and actionable
   - Reference actual data points

7. **Warning Signs** (array of 3-5 specific warnings):
   - Be specific and reference actual data points
   - Highlight critical red flags

8. **Recommended Action** (Buy/Hold/Avoid/Speculate with rationale):
   - Provide clear recommendation with reasoning
   - Suggest position sizing if applicable

9. **Confidence Score** (0-100%): Based on data completeness and clarity of signals

10. **Detailed Analysis** (comprehensive paragraph explaining the assessment):
    - Synthesize all data points
    - Explain the reasoning behind the recommendation
    - Discuss both bullish and bearish factors
${grokInsights ? `
11. **Twitter/Community Insights** (CRITICAL - USE THIS DATA):
    - Analyze community sentiment from Twitter/X
    - Identify key influencers and community trends
    - Assess social media engagement and discussions
    - Evaluate community strength and authenticity
    - Consider how Twitter sentiment affects the token's prospects
    
TWITTER/COMMUNITY DATA FROM GROK:
${grokInsights}
` : ''}

Provide your analysis in JSON format with these keys:
{
  "risk": "Low/Medium/High/Very High",
  "riskScore": number (0-100),
  "securityScore": number (0-100),
  "opportunities": ["specific opportunity 1", "specific opportunity 2", ...],
  "warnings": ["specific warning 1", "specific warning 2", ...],
  "recommendation": "Buy/Hold/Avoid/Speculate",
  "recommendationReason": "detailed explanation",
  "confidence": number (0-100),
  "summary": "executive summary 2-3 sentences",
  "detailedAnalysis": "comprehensive paragraph",
  "keyMetrics": {
    "priceChange24h": "analysis of price movement",
    "liquidity": "liquidity assessment",
    "marketCap": "market cap assessment",
    "volume": "volume analysis",
    "holders": "holder distribution analysis"
  }${grokInsights ? ',\n  "twitterInsights": "summary of Twitter/community sentiment and trends based on Grok analysis"' : ''}\n}`;

  let analysis = null;
  let llmUsed = 'none';

  // Try Gemini AI first - try multiple models
  if (CONFIG.geminiApiKey) {
    const geminiModels = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
    for (const modelName of geminiModels) {
      try {
        console.log(`🤖 Trying Gemini model: ${modelName}...`);
        const geminiResponse = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${CONFIG.geminiApiKey}`,
          {
            contents: [{
              parts: [{ text: prompt }]
            }]
          },
          { timeout: 30000, validateStatus: () => true }
        );

        console.log(`   Gemini response status: ${geminiResponse.status}`);
        
        if (geminiResponse.status === 200 && geminiResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          const responseText = geminiResponse.data.candidates[0].content.parts[0].text;
          console.log(`   ✓ Gemini response received (${responseText.length} chars)`);
          // Extract JSON from response
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              analysis = JSON.parse(jsonMatch[0]);
              llmUsed = 'gemini';
              console.log(`✅ Gemini analysis parsed successfully with model ${modelName}`);
              break; // Success, stop trying other models
            } catch (parseError) {
              console.error(`   ⚠️ Failed to parse Gemini JSON: ${parseError.message}`);
              console.error(`   Response preview: ${responseText.substring(0, 200)}...`);
            }
          } else {
            console.error(`   ⚠️ No JSON found in Gemini response`);
            console.error(`   Response preview: ${responseText.substring(0, 200)}...`);
          }
        } else {
          console.error(`   ⚠️ Gemini model ${modelName} failed:`, {
            status: geminiResponse.status,
            statusText: geminiResponse.statusText,
            error: geminiResponse.data?.error || geminiResponse.data
          });
          // If it's a 404, model doesn't exist, try next
          if (geminiResponse.status === 404) {
            continue;
          }
        }
      } catch (geminiError) {
        console.error(`   ❌ Gemini API error for ${modelName}:`, geminiError.message);
        if (geminiError.response) {
          console.error(`   Error response:`, geminiError.response.data);
        }
        // Continue to next model
        continue;
      }
    }
  } else {
    console.log('⚠️ Gemini API key not configured');
  }

  // Fallback to ChatGPT if Gemini failed
  if (!analysis && CONFIG.openaiApiKey) {
    try {
      const openaiResponse = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4-turbo',
          messages: [
            { role: 'system', content: 'You are a cryptocurrency analyst. Respond only with valid JSON.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7
        },
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.openaiApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (openaiResponse.data?.choices?.[0]?.message?.content) {
        const responseText = openaiResponse.data.choices[0].message.content;
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysis = JSON.parse(jsonMatch[0]);
          llmUsed = 'chatgpt';
        }
      }
    } catch (openaiError) {
      console.error('OpenAI API error:', openaiError.message);
    }
  }

  // If both LLMs failed, return enhanced demo analysis
  if (!analysis || typeof analysis !== 'object' || Object.keys(analysis).length === 0) {
    console.log('⚠️ Both LLMs failed, using demo fallback analysis');
    analysis = {
      risk: 'Medium',
      riskScore: 50,
      securityScore: 60,
      opportunities: [
        'Early entry point with potential upside if project develops',
        'Growing community interest and engagement',
        'Listed on established launchpad platforms',
        'Decent initial liquidity suggests legitimate launch'
      ],
      warnings: [
        'Limited liquidity depth may cause high slippage',
        'New token with unproven track record and tokenomics',
        'Market volatility risk - high price swings expected',
        'Limited holder distribution - concentration risk present'
      ],
      recommendation: 'Hold',
      recommendationReason: 'This token shows moderate potential but lacks sufficient data for a strong buy recommendation. The token is very new with limited trading history. Consider monitoring for 24-48 hours before entering a position. If entering, use small position size and set stop-losses.',
      confidence: 65,
      summary: 'This token shows moderate potential but requires careful monitoring. The early-stage nature combined with limited historical data creates uncertainty. Consider starting with a small position and averaging in as the project develops.',
      detailedAnalysis: 'Based on the available data, this token demonstrates some positive initial indicators including listing on reputable launchpads and basic market metrics. However, the limited trading history, uncertain tokenomics, and early-stage nature present significant risks. The liquidity levels are moderate but may not support large trades without significant slippage. Holder distribution appears concentrated, which could lead to volatility. The recommendation is to hold and observe for additional data points before committing significant capital. If participating, use proper risk management with stop-losses and position sizing appropriate for high-risk assets.',
      keyMetrics: {
        priceChange24h: 'Price volatility appears typical for new launches with significant percentage changes',
        liquidity: 'Moderate liquidity levels provide basic trading capability but may limit large positions',
        marketCap: 'Market capitalization suggests early-stage valuation with room for growth or decline',
        volume: 'Trading volume indicates active interest but sustainability remains to be proven',
        holders: 'Holder count and distribution suggest early adoption phase with concentration risks'
      },
      twitterInsights: null // Will be set from Grok below
    };
    llmUsed = 'demo';
    console.log(`✅ Demo analysis created with ${Object.keys(analysis).length} fields`);
  }

  // Ensure all required fields exist and preserve existing analysis
  const finalAnalysis = {
    risk: analysis?.risk || 'Medium',
    riskScore: analysis?.riskScore || (analysis?.risk === 'Low' ? 30 : analysis?.risk === 'Medium' ? 50 : analysis?.risk === 'High' ? 70 : 85),
    securityScore: analysis?.securityScore || 60,
    opportunities: Array.isArray(analysis?.opportunities) ? analysis.opportunities : (analysis?.opportunities ? [analysis.opportunities] : ['Analysis in progress']),
    warnings: Array.isArray(analysis?.warnings) ? analysis.warnings : (analysis?.warnings ? [analysis.warnings] : ['Review required']),
    recommendation: analysis?.recommendation || 'Hold',
    recommendationReason: analysis?.recommendationReason || analysis?.recommendation || 'Based on available data',
    confidence: analysis?.confidence || 65,
    summary: analysis?.summary || 'Analysis complete',
    detailedAnalysis: analysis?.detailedAnalysis || analysis?.summary || 'Detailed analysis available',
    keyMetrics: analysis?.keyMetrics || {},
    twitterInsights: grokInsights || analysis?.twitterInsights || null // Prioritize Grok insights, fallback to LLM analysis
  };
  
  console.log(`📊 Final analysis object created with ${Object.keys(finalAnalysis).length} fields`);
  
  return {
    analysis: finalAnalysis,
    llmUsed,
    comprehensiveData,
    grokInsights
  };
}

// Top KOL wallets from kolscan.io leaderboard (Solana addresses)
const TOP_KOLS = [
  { name: 'Jijo', address: '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk', rank: 1, image: 'kol-images/jijo.png' },
  { name: 'West', address: 'JDd3hy3gQn2V982mi1zqhNqUw1GfV2UL6g76STojCJPN', rank: 2, image: 'kol-images/west.png' },
  { name: '术', address: 'AcoNeFQsTPYs7ZrH8RMWaxxGJTTQJJ4H5aTXmptaz5UK', rank: 3, image: 'kol-images/shu.png' },
  { name: 'Kadenox', address: 'B32QbbdDAyhvUQzjcaM5j6ZVKwjCxAwGH5Xgvb9SJqnC', rank: 4, image: 'kol-images/kadenox.png' },
  { name: 'aloh', address: 'FGVjsmD76HMcMa6NNzhwxZ2qpx25fGnAZT7zF2A3SWtH', rank: 5, image: null },
  { name: 'bandit', address: '5B79fMkcFeRTiwm7ehsZsFiKsC7m7n1Bgv9yLxPp9q2X', rank: 6, image: 'kol-images/bandit.png' },
  { name: 'orangie', address: 'DuQabFqdC9eeBULVa7TTdZYxe8vK8ct5DZr4Xcf7docy', rank: 7, image: 'kol-images/orangie.png' },
  { name: 'Cented', address: 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o', rank: 8, image: null },
  { name: 'danny', address: 'EaVboaPxFCYanjoNWdkxTbPvt57nhXGu5i6m9m6ZS2kK', rank: 9, image: 'kol-images/danny.png' },
  { name: 'Heyitsyolo', address: 'Av3xWHJ5EsoLZag6pr7LKbrGgLRTaykXomDD5kBhL9YQ', rank: 10, image: null },
  { name: 'Keano', address: 'Ez2jp3rwXUbaTx7XwiHGaWVgTPFdzJoSg8TopqbxfaJN', rank: 11, image: 'kol-images/keano.png' },
  { name: 'zhynx', address: 'zhYnXqK3MNSmwS3yxSvPmY5kUa1n2WUaCJgYUDrAHkL', rank: 12, image: 'kol-images/zhynx.png' },
  { name: 'Jeets', address: 'D1H83ueSw5Nxy5okxH7VBfV4jRnqAK5Mm1tm3JAj3m5t', rank: 13, image: null },
  { name: 'Ataberk', address: '6hcX7fVMzeRpW3d7XhFsxYw2CuePfgSMmouZxSiNLj1U', rank: 14, image: null },
  { name: 'Giann', address: 'GNrmKZCxYyNiSUsjduwwPJzhed3LATjciiKVuSGrsHEC', rank: 15, image: null },
  { name: 'Ban', address: '8DGbkGgQewL9mx4aXzZCUChr7hBVXvPK9fYqSqc7Ajpn', rank: 16, image: 'kol-images/ban.png' },
  { name: 'Cupsey', address: '2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f', rank: 17, image: null }
];
// Launchpad configuration
// Each launchpad has its own API endpoint and chain
// Exchange IDs from: https://docs.moralis.com/supported-exchanges
const LAUNCHPADS = {
  pumpfun: {
    name: 'Pump.fun',
    chain: 'solana',
    chainId: 'mainnet',
    moralisChain: 'mainnet',
    emoji: '🟣',
    description: 'Solana meme coin launchpad',
    exchangeId: 'pumpfun',
    isSolana: true
  },
  pancakeswapv2_bsc: {
    name: 'PancakeSwap V2',
    chain: 'bnb',
    chainId: '0x38',
    moralisChain: 'bsc',
    emoji: '🟡',
    description: 'BNB Chain DEX trending tokens',
    exchangeId: 'pancakeswapv2',
    isSolana: false,
    // Popular BNB Chain tokens
    popularTokens: [
      '0x55d398326f99059fF775485246999027B3197955', // USDT
      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // USDC
      '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // ETH
      '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', // BTCB
      '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', // DAI
      '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', // BUSD
      '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', // ADA
      '0xbA2aE424d960c26247Dd6c32edC70B295c744C43', // DOGE
    ]
  },
  aerodrome_base: {
    name: 'Aerodrome',
    chain: 'base',
    chainId: '0x2105',
    moralisChain: 'base',
    emoji: '🔵',
    description: 'Base DEX trending tokens',
    exchangeId: 'aerodrome',
    isSolana: false,
    // Popular Base tokens
    popularTokens: [
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      '0x4200000000000000000000000000000000000006', // WETH
      '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
      '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // USDbC
      '0x940181a94A35A4569E4529A3CDfB74e38FD98631', // AERO
      '0x532f27101965dd16442E59d40670FaF5eBB142E4', // BRETT
      '0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe', // HIGHER
    ]
  },
  uniswapv3_eth: {
    name: 'Uniswap V3',
    chain: 'ethereum',
    chainId: '0x1',
    moralisChain: 'eth',
    emoji: '⚫',
    description: 'Ethereum DEX trending pairs',
    exchangeId: 'uniswapv3',
    isSolana: false,
    // Popular Ethereum tokens
    popularTokens: [
      '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
      '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
      '0x514910771AF9Ca656af840dff83E8264EcF986CA', // LINK
      '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', // AAVE
      '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', // UNI
      '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', // SHIB
    ]
  }
};

// Legacy chain configuration for backward compatibility
const CHAINS = {
  bnb: { id: '0x38', name: 'BNB Chain', emoji: '🟡' },
  base: { id: '0x2105', name: 'Base', emoji: '🔵' },
  ethereum: { id: '0x1', name: 'Ethereum', emoji: '⚫' },
  solana: { id: 'mainnet', name: 'Solana', emoji: '🟣' }
};

// Demo data for fallback
const DEMO_TOKENS = [
  {
    chain: 'base',
    address: '0x1234567890123456789012345678901234567890',
    name: 'Demo Token',
    symbol: 'DEMO',
    decimals: 18,
    logo: null,
    price: 0.00001234,
    priceChange24h: 45.67,
    marketCap: 123456,
    liquidity: 50000,
    holders: 1234,
    createdAt: new Date().toISOString(),
    launchpad: 'Clanker'
  }
];
// x402 Payment Middleware - All payments go through x402 facilitators (Base, Solana, Ethereum, BNB)
// No direct wallet-to-wallet transfers - all payments must use x402 protocol

        
        // First, check which chains have wallets (to avoid errors on chains without wallets)
        const availableChains = [];
        for (const chain of allChains) {
          try {
            const address = await 
            if (address) {
              // Validate it's not a contract address
              const network = 
              if (network && network.usdcContract) {
                // Check if address matches USDC contract address (invalid wallet)
                if (address.toLowerCase() === network.usdcContract.toLowerCase()) {
                  console.log(`⚠️ Skipping ${chain} - wallet address is the USDC contract address (likely no wallet created)`);
                  balanceErrors[chain] = `No ${chain} wallet found. Please create a ${chain} wallet first.`;
                  continue;
                }
              }
              
              // Additional validation for Ethereum - check if it's a valid wallet address format
              if (chain === 'ethereum' || chain === 'base' || chain === 'bnb') {
                const { ethers } = require('ethers');
                if (!ethers.utils.isAddress(address)) {
                  console.log(`⚠️ Skipping ${chain} - invalid wallet address format: ${address}`);
                  balanceErrors[chain] = `Invalid ${chain} wallet address. Please create a new ${chain} wallet.`;
                  continue;
                }
              }
              
              availableChains.push(chain);
              console.log(`✅ ${chain.toUpperCase()} wallet found: ${address.substring(0, 10)}...`);
            }
          } catch (error) {
            console.log(`⚠️ No ${chain.toUpperCase()} wallet found: ${error.message}`);
            balanceErrors[chain] = `No ${chain} wallet found. Please create a ${chain} wallet first.`;
            // Skip this chain - user doesn't have a wallet for it
            continue;
          }
        }
        
        if (availableChains.length === 0) {
          console.log(`❌ No wallets found for any chain. User needs to create at least one wallet.`);
          return res.status(402).json({
            message: 'Payment Required - Please create a wallet first',
            authenticated: true,
            balance: 0,
            required: parseFloat(requiredAmount),
            walletAddress: '',
            freeCredits: user?.freeAnalysisCredits || 0,
            balanceErrors: balanceErrors,
            note: 'No wallets found. Please create a wallet (Solana, Base, Ethereum, or BNB) to make payments.',
            accepts: [
              {
                scheme: 'exact',
                network: 'solana',
                currency: 'USDC',
                amount: requiredAmount,
                recipient: getRecipientWallet('solana'),
                facilitator: CONFIG.                usdcMint: 
        
        // Direct payment approach: Try payment on each available chain
        // sendPayment function will verify balance on-chain using Helius RPC
        for (const chain of availableChains) {
          try {
            console.log(`\n🔄 Attempting payment on ${chain.toUpperCase()}...`);
            console.log(`📤 Calling sendPayment - will verify balance on-chain using Helius RPC`);
            
            // Attempt payment directly - sendPayment will:
            // 1. Use Helius RPC (for Solana)
            // 2. Verify balance on-chain
            // 3. Send USDC to recipient address from .env
            paymentResult = await 
            selectedChain = chain;
            
            console.log(`\n✅✅✅ PAYMENT SUCCESSFUL on ${chain.toUpperCase()}! ✅✅✅`);
            console.log(`📝 Transaction Hash: ${paymentResult.txHash}`);
            console.log(`💰 Amount: ${paymentResult.amount} USDC`);
            console.log(`📤 From: ${paymentResult.from}`);
            console.log(`📥 To: ${paymentResult.to}`);
            console.log(`🔗 Chain: ${paymentResult.chain}`);
            
            break; // Success! Exit loop
            
          } catch (paymentError) {
            console.error(`\n❌ Payment failed on ${chain.toUpperCase()}:`, paymentError.message);
            console.error(`   Error details:`, {
              message: paymentError.message,
              stack: paymentError.stack,
              name: paymentError.name
            });
            balanceErrors[chain] = paymentError.message;
            
            // Log the error but continue to next chain
            if (paymentError.message && paymentError.message.includes('Insufficient balance')) {
              console.log(`⚠️ Insufficient balance on ${chain} - trying next chain...`);
            } else if (paymentError.message && (paymentError.message.includes('429') || paymentError.message.includes('rate limit'))) {
              console.log(`⚠️ Rate limit on ${chain} - trying next chain...`);
            } else if (paymentError.message && paymentError.message.includes('No wallet')) {
              console.log(`⚠️ No wallet on ${chain} - skipping...`);
            } else {
              console.log(`⚠️ Payment error on ${chain} - trying next chain...`);
            }
            continue;
          }
        }
        
        if (paymentResult && selectedChain) {
          // Add payment proof header with chain info (x402-compatible)
          const paymentProof = Buffer.from(JSON.stringify({
            txHash: paymentResult.txHash,
            chain: selectedChain,
            source: 'server-wallet-x402'
          })).toString('base64');
          req.headers['x-payment'] = paymentProof;
          req.headers['x-payment-source'] = 'server-wallet-x402';
          req.headers['x-payment-chain'] = selectedChain;
          
          console.log(`💳 Server-side x402-compatible payment processed on ${selectedChain}: ${paymentResult.txHash}`);
          return next();
        } else {
          // All payment attempts failed - return 402 with all x402 options
          // Don't try to get balance again (might cause more rate limits)
          console.log(`⚠️ All payment attempts failed. Returning 402.`, {
            balanceErrors,
            required: requiredAmount,
            chainsAttempted: availableChains.length > 0 ? availableChains : allChains,
            availableChainsCount: availableChains.length
          });
          
          // Try to get wallet address without checking balance
          let walletAddress = '';
          try {
            const addresses = await 
            walletAddress = addresses.solana || addresses.base || '';
          } catch (e) {
            console.warn('Could not get wallet address:', e.message);
          }
          
          // Filter out SOL-related errors for Crossmint (Crossmint handles fees automatically)
          const filteredBalanceErrors = {};
          for (const [chain, error] of Object.entries(balanceErrors)) {
            // Skip SOL fee errors for Crossmint wallets (they don't need SOL)
            if (chain === 'solana-crossmint' && error && error.includes('Insufficient SOL')) {
              console.log(`⚠️ Filtering out SOL error for ${chain} - Crossmint handles fees automatically`);
              continue; // Don't include this error
            }
            // Also filter out SOL errors from regular Solana if Crossmint is available (to avoid confusion)
            if (chain === 'solana' && error && error.includes('Insufficient SOL')) {
              const hasCrossmint = availableChains.includes('solana-crossmint');
              if (hasCrossmint) {
                console.log(`⚠️ Filtering out SOL error for regular ${chain} - Crossmint wallet is available`);
                continue; // Don't show SOL error if Crossmint is available
              }
            }
            filteredBalanceErrors[chain] = error;
          }
          
          return res.status(402).json({
            message: 'Payment Required - Please pay via x402 protocol',
            authenticated: true,
            balance: 0, // Don't try to fetch balance (rate limit risk)
            required: parseFloat(requiredAmount),
            walletAddress: walletAddress,
            freeCredits: user?.freeAnalysisCredits || 0,
            balanceErrors: filteredBalanceErrors, // Filtered errors (SOL errors removed for Crossmint)
            note: 'Payment attempts failed. Please try again or use x402 client-side payment.',
            accepts: [
              {
                scheme: 'exact',
                network: 'solana',
                currency: 'USDC',
                amount: requiredAmount,
                recipient: getRecipientWallet('solana'),
                facilitator: CONFIG.                usdcMint: 
        // Fall through to manual payment flow
      }
    }
    
    // Manual payment flow (MetaMask/wallet connection) or unauthenticated users
    const paymentHeader = req.headers['x-payment'];

    if (!paymentHeader) {
      // Payment required - return 402 with all x402-supported chains (Solana, Base, Ethereum, BNB)
      // Prioritize Solana first since users typically have funds there
      return res.status(402).json({
        message: 'Payment Required for AI Analysis',
        authenticated: req.isAuthenticated && req.isAuthenticated() ? true : false,
        accepts: [
          {
            scheme: 'exact',
            network: 'solana',
            currency: 'USDC',
            amount: requiredAmount,
            recipient: getRecipientWallet('solana'),
            facilitator: CONFIG.            usdcMint: 
      
      // Check if this is a free credit
      if (paymentProof.startsWith('free-credit-')) {
        // Free credit payment - already processed above, just verify
        res.setHeader('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
          verified: true,
          source: 'free-credit',
          timestamp: new Date().toISOString()
        })).toString('base64'));
        return next();
      }
      
      // Try to parse as JSON (server-side payment) or use as plain txHash (legacy)
      let txHash, chain, paymentSource;
      try {
        const paymentData = JSON.parse(paymentProof);
        txHash = paymentData.txHash;
        chain = paymentData.chain || 'base';
        paymentSource = paymentData.source || 'manual';
      } catch (e) {
        // Legacy format - plain txHash, assume Base
        txHash = paymentProof;
        chain = 'base';
        paymentSource = 'manual';
      }

      // Verify payment on-chain (supports both server-side x402-compatible and client-side x402 payments)
      if (paymentSource === 'server-wallet-x402') {
        // Server-side x402-compatible payment - already processed, trust it
        res.setHeader('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
          verified: true,
          txHash: txHash,
          chain: chain,
          source: 'server-wallet-x402',
          timestamp: new Date().toISOString()
        })).toString('base64'));
        return next();
      }
      
      // Client-side x402 payment - verify on-chain
      if (chain === 'solana') {
        // Verify Solana USDC transfer transaction
        const { Connection, PublicKey } = require('@solana/web3.js');
        const { getAssociatedTokenAddress } = require('@solana/spl-token');
        const connection = 
        
        try {
          const signature = txHash;
          const tx = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          });

          if (!tx) {
            return res.status(402).json({
              error: 'Invalid payment proof',
              message: 'Solana transaction not found'
            });
          }

          if (tx.meta && tx.meta.err) {
            return res.status(402).json({
              error: 'Invalid payment proof',
              message: 'Solana transaction failed'
            });
          }

          // Verify USDC transfer to recipient
          const recipientPublicKey = new PublicKey(getRecipientWallet('solana'));
          const usdcMint = new PublicKey(
          const recipientTokenAddress = await getAssociatedTokenAddress(
            usdcMint,
            recipientPublicKey
          );
          
          // Parse transaction to find USDC transfer
          let paymentVerified = false;
          let transferAmount = 0;
          
          if (tx.meta && tx.meta.preTokenBalances && tx.meta.postTokenBalances) {
            // Check token balance changes for recipient's USDC account
            for (const postBalance of tx.meta.postTokenBalances) {
              if (postBalance.accountIndex !== undefined) {
                const accountKey = tx.transaction.message.accountKeys[postBalance.accountIndex];
                if (accountKey && accountKey.toString() === recipientTokenAddress.toString()) {
                  // Found recipient's USDC account
                  const preBalance = tx.meta.preTokenBalances.find(
                    pre => pre.accountIndex === postBalance.accountIndex
                  );
                  
                  const preAmount = preBalance ? parseFloat(preBalance.uiTokenAmount.uiAmountString || '0') : 0;
                  const postAmount = parseFloat(postBalance.uiTokenAmount.uiAmountString || '0');
                  
                  // Check if USDC mint matches
                  if (postBalance.mint === usdcMint.toString()) {
                    transferAmount = postAmount - preAmount;
                    if (transferAmount >= parseFloat(requiredAmount)) {
                      paymentVerified = true;
                      break;
                    }
                  }
                }
              }
            }
          }
          
          // Alternative: Check instruction data for transfer
          if (!paymentVerified && tx.transaction && tx.transaction.message && tx.transaction.message.instructions) {
            for (const instruction of tx.transaction.message.instructions) {
              if (instruction.programId) {
                const programId = instruction.programId.toString();
                // Token Program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
                if (programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || 
                    programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
                  // This is a token transfer instruction
                  // We'll trust the balance change check above
                  // If balance check found the transfer, we're good
                }
              }
            }
          }

          if (!paymentVerified) {
            return res.status(402).json({
              error: 'Invalid payment proof',
              message: `Solana transaction does not show USDC transfer of at least ${requiredAmount} USDC to recipient`
            });
          }

          res.setHeader('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
            verified: true,
            txHash: signature,
            chain: 'solana',
            amount: transferAmount.toFixed(6),
            timestamp: new Date().toISOString()
          })).toString('base64'));

          return next();
        } catch (solanaError) {
          console.error('Solana payment verification error:', solanaError);
          return res.status(402).json({
            error: 'Payment verification failed',
            message: `Solana verification error: ${solanaError.message}`
          });
        }
      } else {
        // Verify EVM transaction (Base, Ethereum, BNB)
        const network = 
        if (!network || !network.rpcUrl) {
          return res.status(402).json({
            error: 'Invalid chain',
            message: `Chain ${chain} not supported for payment verification`
          });
        }

        const provider = new ethers.JsonRpcProvider(network.rpcUrl);
        const tx = await provider.getTransaction(txHash);

        if (!tx) {
          return res.status(402).json({
            error: 'Invalid payment proof',
            message: 'Transaction not found'
          });
        }

        // Wait for transaction receipt
        const receipt = await provider.getTransactionReceipt(txHash);
        
        if (!receipt || receipt.status !== 1) {
          return res.status(402).json({
            error: 'Invalid payment proof',
            message: 'Transaction failed or pending'
          });
        }

        // Verify USDC contract and amount
        const usdcInterface = new ethers.Interface([
          'function transfer(address to, uint256 amount) returns (bool)'
        ]);

        try {
          const decodedData = usdcInterface.parseTransaction({ data: tx.data, value: tx.value });
          const transferAmount = ethers.formatUnits(decodedData.args[1], 6); // USDC has 6 decimals
          const transferTo = decodedData.args[0].toLowerCase();

          const expectedRecipient = getRecipientWallet(chain);
          if (transferTo !== expectedRecipient.toLowerCase()) {
            return res.status(402).json({
              error: 'Invalid payment recipient',
              message: 'Payment sent to wrong address'
            });
          }

          if (parseFloat(transferAmount) < parseFloat(requiredAmount)) {
            return res.status(402).json({
              error: 'Insufficient payment amount',
              message: `Required: ${requiredAmount} USDC, Received: ${transferAmount} USDC`
            });
          }

          // Payment verified - add payment response header
          res.setHeader('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
            verified: true,
            txHash: txHash,
            chain: chain,
            amount: transferAmount,
            timestamp: new Date().toISOString()
          })).toString('base64'));

          next();
        } catch (decodeError) {
          // If decode fails, it might not be a USDC transfer
          return res.status(402).json({
            error: 'Invalid payment proof',
            message: 'Transaction is not a valid USDC transfer'
          });
        }
      }
    } catch (error) {
      console.error('Payment verification error:', error);
      return res.status(402).json({
        error: 'Payment verification failed',
        message: error.message
      });
    }
  };
};

// API Routes

// Health check
// Diagnostic endpoint to check environment variables
app.get('/api/debug/env', (req, res) => {
  res.json({
    nodeEnv: process.env.NODE_ENV || 'not set',
    hasMoralisKey: !!CONFIG.moralisApiKey,
    hasGeminiKey: !!CONFIG.geminiApiKey,
    hasTwitterKey: !!CONFIG.twitterApiKey,
    hasGrokKey: !!CONFIG.grokApiKey,
    moralisKeyPrefix: CONFIG.moralisApiKey ? CONFIG.moralisApiKey.substring(0, 20) + '...' : 'MISSING',
    port: CONFIG.port,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    supportedChains: Object.keys(CHAINS),
    supportedLaunchpads: Object.keys(LAUNCHPADS),
    x402: {
      enabled: true,
      network: 'base',
      currency: 'USDC',
      billing: 'subscription',
      analysisCuCost: ANALYSIS_CU_COST
    },
    apis: {
      moralis: !!CONFIG.moralisApiKey,
      gemini: !!CONFIG.geminiApiKey,
      openai: !!CONFIG.openaiApiKey,
      twitter: !!CONFIG.twitterApiKey
    }
  });
});

// ===== Authentication Routes =====

// Check authentication status
app.get('/api/auth/status', isAuthenticated, (req, res) => {
  res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      picture: req.user.picture,
      walletAddress: req.user.wallet?.address
    }
  });
});

// Google OAuth login
app.get('/api/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email']
}));

// Google OAuth callback
app.get('/api/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=auth_failed' }),
  (req, res) => {
    // Successful authentication - redirect to frontend with correct domain
    res.redirect(`${PUBLIC_BASE_URL}/?login=success`);
  }
);

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// ===== Wallet Routes =====

// Clear balance cache endpoint (for debugging)
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({
      error: 'Failed to clear cache',
      message: error.message
    });
  }
});

// Get user wallet info and balance for a specific chain
app.get('/api/wallet', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const chain = (req.query.chain || 'base').toLowerCase();
    
    // Validate chain
    const supportedChains = ['base', 'ethereum', 'bnb', 'solana', 'solana-crossmint'];
    if (!supportedChains.includes(chain)) {
      return res.status(400).json({
        error: 'Invalid chain',
        message: `Supported chains: ${supportedChains.join(', ')}`
      });
    }
    
    try {
      const balanceInfo = await 
      
      const response = {
        address: balanceInfo.address,
        balance: balanceInfo.balance,
        balanceWei: balanceInfo.balanceWei || null,
        currency: 'USDC',
        chain: chain,
        network: 
      
      // For Solana wallets, also include SOL balance (needed for transaction fees)
      if (chain === 'solana') {
        try {
          const solBalance = await 
          response.solBalance = solBalance.balance;
          response.solBalanceLamports = solBalance.balanceLamports;
        } catch (solError) {
          console.warn('Could not fetch SOL balance:', solError.message);
          // Don't fail the request if SOL balance check fails
        }
      }
      
      res.json(response);
    } catch (balanceError) {
      console.error(`Error getting balance for ${chain}:`, balanceError);
      
      // If it's a 401 error, provide helpful message
      if (balanceError.message && balanceError.message.includes('401')) {
        console.error(`⚠️ Balance check failed due to Helius authentication error`);
        console.error(`   Payment will still work - balance will be verified on-chain during payment`);
      }
      
      // If balance fetch fails, try to at least return the wallet address
      try {
        const address = await 
        if (address) {
          // Validate it's not a contract address
          const network = 
          if (network && network.usdcContract && address.toLowerCase() === network.usdcContract.toLowerCase()) {
            throw new Error(`Wallet address cannot be the USDC contract address. Please check your ${chain} wallet configuration.`);
          }
          
          // Return wallet address with balance 0 if balance fetch failed
          // But note that payment will still work - it verifies balance on-chain
          res.json({
            address: address,
            balance: '0', // Balance check failed, but payment will verify on-chain
            balanceWei: null,
            currency: 'USDC',
            chain: chain,
            network: 
          return;
        }
      } catch (addressError) {
        console.error(`Error getting address for ${chain}:`, addressError);
        // Don't return the error response here, let it fall through to the main error handler
      }
      
      // If both fail, return error
      throw balanceError;
    }
  } catch (error) {
    console.error('Error getting wallet info:', error);
    res.status(500).json({
      error: 'Failed to get wallet info',
      message: error.message || 'Unknown error occurred'
    });
  }
});
// Get all wallet addresses and balances
app.get('/api/wallet/all', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get addresses (should always work - they're generated from private keys)
    let addresses = {};
    try {
      addresses = await 
    } catch (addressError) {
      console.error('Error getting wallet addresses:', addressError);
      // Try to get addresses one by one as fallback
      const chains = ['base', 'ethereum', 'bnb', 'solana', 'solana-crossmint'];
      for (const chain of chains) {
        try {
          addresses[chain] = await 
        } catch (e) {
          console.error(`Failed to get ${chain} address:`, e);
          addresses[chain] = null;
        }
      }
    }
    
    // Get balances (fetch individually to avoid one failure affecting all)
    let balances = {};
    const allChains = ['base', 'ethereum', 'bnb', 'solana', 'solana-crossmint'];
    
    // Fetch balances in parallel but handle each chain independently
    const balancePromises = allChains.map(async (chain) => {
      try {
        const balanceInfo = await 
        return { chain, balance: balanceInfo.balance };
      } catch (error) {
        console.error(`Error getting ${chain} balance:`, error.message);
        // Try to at least get the address to show wallet exists
        try {
          const address = await 
          if (address) {
            // Return 0 balance but wallet exists
            return { chain, balance: '0' };
          }
        } catch (addrError) {
          console.error(`Error getting ${chain} address:`, addrError.message);
        }
        return { chain, balance: '0' };
      }
    });
    
    const balanceResults = await Promise.allSettled(balancePromises);
    balanceResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        balances[result.value.chain] = result.value.balance;
      } else {
        balances[allChains[index]] = '0';
      }
    });
    
    const wallets = {};
    
    for (const chain of allChains) {
      // Only include wallet if address exists (Crossmint might not be configured)
      if (addresses[chain]) {
        wallets[chain] = {
          address: addresses[chain],
          balance: balances[chain] || '0',
          network: 
      } else if (chain === 'solana-crossmint') {
        // For Crossmint, include null entry so frontend knows to show create button
        // Don't include it if Crossmint is not configured at all
        try {
          const crossmintService = require('./crossmint-service');
          if (crossmintService.isCrossmintConfigured()) {
            // Crossmint is configured but wallet doesn't exist yet - frontend will show create button
            wallets[chain] = {
              address: null,
              balance: '0',
              network: 'Solana Crossmint',
              currency: 'USDC',
              needsCreation: true
            };
          }
        } catch (e) {
          // Crossmint service not available - don't include
        }
      }
    }
    
    console.log('📦 Returning wallets to frontend:', Object.keys(wallets));
    res.json({ wallets });
  } catch (error) {
    console.error('Error getting all wallets:', error);
    res.status(500).json({
      error: 'Failed to get wallet info',
      message: error.message || 'Unknown error occurred'
    });
  }
});

// Check if Crossmint is configured
  } catch (error) {
    console.error('Error checking Crossmint status:', error);
    res.json({
      configured: false,
      hasWallet: false,
      shouldShowButton: false
    });
  }
});

// Create Crossmint wallet for current user (if not exists)
app.post('/api/wallet/create-crossmint', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if Crossmint wallet already exists
    if (user.wallets && user.wallets['solana-crossmint']) {
      return res.json({
        success: true,
        message: 'Crossmint wallet already exists',
        address: user.wallets['solana-crossmint'].address
      });
    }
    
    // Debug: Log environment variables
    console.log('🔍 Creating Crossmint wallet - Environment check:', {
      hasApiKey: !!process.env.CROSSMINT_API_KEY,
      hasProjectId: !!process.env.CROSSMINT_PROJECT_ID,
      apiKeyPrefix: process.env.CROSSMINT_API_KEY ? process.env.CROSSMINT_API_KEY.substring(0, 15) + '...' : 'MISSING',
      projectId: process.env.CROSSMINT_PROJECT_ID || 'MISSING',
      environment: process.env.CROSSMINT_ENVIRONMENT || 'not set'
    });
    
    // Create Crossmint wallet
    const { generateCrossmintWallet, loadUsers, saveUsers } = require('./auth');
    
    let crossmintWallet;
    let walletError = null;
    
    try {
      crossmintWallet = await generateCrossmintWallet(user.googleId, user.email);
    } catch (error) {
      console.error('❌ Error in generateCrossmintWallet:', error);
      walletError = error.message || error.toString();
    }
    
    if (!crossmintWallet) {
      // More detailed error message
      const hasApiKey = !!process.env.CROSSMINT_API_KEY;
      const hasProjectId = !!process.env.CROSSMINT_PROJECT_ID;
      
      return res.status(500).json({
        error: 'Failed to create Crossmint wallet',
        message: walletError || `Crossmint configuration issue. API Key: ${hasApiKey ? 'SET' : 'MISSING'}, Project ID: ${hasProjectId ? 'SET' : 'MISSING'}. Please check your .env file and restart the server.`,
        details: walletError
      });
    }
    
    // Save wallet to user
    const users = await loadUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex !== -1) {
      if (!users[userIndex].wallets) {
        users[userIndex].wallets = {};
      }
      users[userIndex].wallets['solana-crossmint'] = crossmintWallet;
      if (!users[userIndex].balances) {
        users[userIndex].balances = {};
      }
      users[userIndex].balances['solana-crossmint'] = '0';
      await saveUsers(users);
    }
    
    res.json({
      success: true,
      message: 'Crossmint wallet created successfully',
      address: crossmintWallet.address,
      wallet: crossmintWallet
    });
  } catch (error) {
    console.error('Error creating Crossmint wallet:', error);
    res.status(500).json({
      error: 'Failed to create Crossmint wallet',
      message: error.message
    });
  }
});

// Refresh wallet balance for a specific chain
    }
    
    try {
      const balanceInfo = await 
      
      res.json({
        balance: balanceInfo.balance,
        address: balanceInfo.address,
        chain: chain
      });
    } catch (balanceError) {
      console.error(`Error refreshing ${chain} balance:`, balanceError);
      
      // Try to at least return the wallet address even if balance fetch fails
      try {
        const address = await 
        if (address) {
          // Return wallet address with balance 0 if balance fetch failed
          return res.json({
            balance: '0',
            address: address,
            chain: chain
          });
        }
      } catch (addressError) {
        console.error(`Error getting ${chain} wallet address:`, addressError);
      }
      
      // If both balance and address fetch fail, return error but don't crash
      res.status(500).json({
        error: 'Failed to refresh balance',
        message: balanceError.message || 'Unable to fetch wallet balance. The wallet may not exist or RPC may be unavailable.',
        chain: chain
      });
    }
  } catch (error) {
    console.error('Error in wallet refresh endpoint:', error);
    res.status(500).json({
      error: 'Failed to refresh balance',
      message: error.message || 'Unknown error occurred'
    });
  }
});

// Process payment - Server-side x402-compatible payments from wallet funds
    }
    
    // Validate chain
    const supportedChains = ['base', 'ethereum', 'bnb', 'solana', 'solana-crossmint'];
    const selectedChain = chain.toLowerCase();
    
    if (!supportedChains.includes(selectedChain)) {
      return res.status(400).json({
        error: 'Invalid chain',
        message: `Supported chains: ${supportedChains.join(', ')}`
      });
    }
    
    // Check balance and process payment server-side (x402-compatible)
    try {
      const balanceInfo = await 
      const balance = parseFloat(balanceInfo.balance);
      
      if (balance < parseFloat(amount)) {
        // Insufficient balance - return 402 with x402 payment options
        const           solana: CONFIG.          ethereum: CONFIG.          bnb: CONFIG.          balance: balance,
          required: parseFloat(amount),
          walletAddress: balanceInfo.address,
          accepts: [{
            scheme: 'exact',
            network: selectedChain,
            currency: 'USDC',
            amount: amount,
            recipient: getRecipientWallet(selectedChain),
            facilitator:             ...(selectedChain === 'solana' 
              ? { usdcMint: network.usdcMint }
              : {  amount, selectedChain);
      
      res.json({
        success: true,
        txHash: paymentResult.txHash,
        blockNumber: paymentResult.blockNumber,
        from: paymentResult.from,
        to: paymentResult.to,
        amount: paymentResult.amount,
        chain: paymentResult.chain,
        source: 'server-wallet-x402'
      });
    } catch (error) {
      console.error('Error processing payment:', error);
      res.status(500).json({
        error: 'Payment failed',
        message: error.message
      });
    }
  } catch (error) {
    console.error('Error processing payment request:', error);
    res.status(500).json({
      error: 'Payment request failed',
      message: error.message
    });
  }
});

// ===== Watchlist Routes =====

function normalizeAddressForChain(chain, address) {
  if (!address) return '';
  if (address.startsWith('0x')) {
    return address.toLowerCase();
  }
  // Non-EVM chains (e.g., Solana) are case-sensitive
  return address;
}
// Get user watchlist
app.get('/api/watchlist', requireAuth, async (req, res) => {
  try {
    console.log('⭐ Watchlist request from user:', req.user?.id);
    
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'User not authenticated', authenticated: false });
    }
    
    const userId = req.user.id;
    const user = await getUserById(userId);
    
    if (!user) {
      console.error('❌ User not found:', userId);
      return res.status(404).json({ error: 'User not found' });
    }
    
    console.log('✅ User found, watchlist:', user.watchlist?.length || 0, 'tokens');
    
    // Initialize watchlist if it doesn't exist
    if (!user.watchlist) {
      console.log('📝 Initializing empty watchlist for user:', userId);
      user.watchlist = [];
      const users = await loadUsers();
      const userIndex = users.findIndex(u => u.id === userId);
      if (userIndex >= 0) {
        users[userIndex].watchlist = [];
        await saveUsers(users);
      }
    }
    
    // Enrich watchlist with current prices and data
    // Use cached token data if available and recent (from token card), otherwise fetch fresh
    const enrichedWatchlist = await Promise.all((user.watchlist || []).map(async (watched) => {
      try {
        // Use original address for API calls; fallback to stored address
        const rawAddress = watched.originalAddress || watched.address;
        const address = rawAddress;
        const chain = watched.chain.toLowerCase();
        const isEVM = address.startsWith('0x');
        
        // Check if we have cached token data that's recent (< 5 minutes old)
        let tokenData = {
          name: watched.name || 'Unknown',
          symbol: watched.symbol || 'UNKNOWN',
          logo: null,
          price: 0,
          priceChange24h: 0,
          marketCap: 0,
          volume24h: 0,
          liquidity: 0,
          holders: 0,
          contractAddress: address
        };
        
        // Use cached data if available and recent (from token card when added)
        if (watched.cachedTokenData && watched.dataCachedAt) {
          const cacheAge = Date.now() - new Date(watched.dataCachedAt).getTime();
          const cacheMaxAge = 5 * 60 * 1000; // 5 minutes
          
          if (cacheAge < cacheMaxAge) {
            console.log(`✅ [WATCHLIST] Using cached data for ${watched.name} (${cacheAge / 1000}s old)`);
            tokenData = {
              name: watched.cachedTokenData.name || watched.name || 'Unknown',
              symbol: watched.cachedTokenData.symbol || watched.symbol || 'UNKNOWN',
              logo: watched.cachedTokenData.logo || null,
              price: parseFloat(watched.cachedTokenData.price || 0),
              priceChange24h: parseFloat(watched.cachedTokenData.priceChange24h || 0),
              marketCap: parseFloat(watched.cachedTokenData.marketCap || 0),
              volume24h: parseFloat(watched.cachedTokenData.volume24h || 0),
              liquidity: parseFloat(watched.cachedTokenData.liquidity || 0),
              holders: parseInt(watched.cachedTokenData.holders || 0),
              contractAddress: address
            };
            
            // Use cached data as initial values but still fetch fresh data
            console.log(`🔄 [WATCHLIST] Using cached data as fallback, fetching fresh for ${watched.name}...`);
            // Don't return early - continue to fetch fresh data below
          }
        }
        
        // Always fetch fresh data to ensure we have real, up-to-date information
        console.log(`📊 [WATCHLIST] Fetching fresh data for ${watched.name || address} on ${chain}...`);
        
        if (isEVM) {
          // EVM Token - Use comprehensive EVM APIs
          console.log(`📊 [WATCHLIST EVM] Fetching data for ${address} on ${chain}...`);
          
          // Chain mapping for Moralis
          const chainMapping = {
            'bnb': 'bsc',
            'bsc': 'bsc',
            'base': 'base',
            'ethereum': 'eth',
            'eth': 'eth'
          };
          const moralisChain = chainMapping[chain] || chain;
          const chainIdMap = {
            'bsc': '0x38',
            'base': '0x2105',
            'eth': '0x1',
            'ethereum': '0x1'
          };
          const chainId = chainIdMap[chain] || chain;
          
          try {
            // 1. Get token metadata and discovery data
            const [metadataResponse, discoveryResponse] = await Promise.allSettled([
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/erc20/metadata`,
                {
                  params: { chain: chainId, addresses: [address] },
                  headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                  timeout: 10000
                }
              ),
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/discovery/token`,
                {
                  params: { chain: moralisChain, tokenAddress: address },
                  headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                  timeout: 10000
                }
              ).catch(() => null)
            ]);
            
            // Extract metadata
            if (metadataResponse.status === 'fulfilled' && metadataResponse.value.data) {
              const metadata = Array.isArray(metadataResponse.value.data) 
                ? metadataResponse.value.data[0] 
                : metadataResponse.value.data;
              
              if (metadata) {
                console.log(`  📊 [WATCHLIST EVM] Metadata response for ${address}:`, JSON.stringify(metadata, null, 2));
                
                if (metadata.name && metadata.name !== 'Unknown') {
                  tokenData.name = metadata.name;
                }
                if (metadata.symbol && metadata.symbol !== 'UNKNOWN') {
                  tokenData.symbol = metadata.symbol;
                }
                if (metadata.logo || metadata.thumbnail) {
                  tokenData.logo = metadata.logo || metadata.thumbnail;
                }
                console.log(`  ✓ [WATCHLIST EVM] Extracted metadata: ${tokenData.name} (${tokenData.symbol})`);
              }
            } else if (metadataResponse.status === 'rejected') {
              console.log(`  ⚠ [WATCHLIST EVM] Metadata API failed:`, metadataResponse.reason?.message || 'Unknown error');
            }
            
            // Extract discovery data (comprehensive token info)
            if (discoveryResponse && discoveryResponse.status === 'fulfilled' && discoveryResponse.value?.data) {
              const discovery = discoveryResponse.value.data;
              console.log(`  📊 [WATCHLIST EVM] Discovery response for ${address}:`, JSON.stringify(discovery, null, 2));
              
              tokenData.name = discovery.token_name || discovery.name || tokenData.name;
              tokenData.symbol = discovery.token_symbol || discovery.symbol || tokenData.symbol;
              tokenData.logo = discovery.token_logo || discovery.logo || discovery.image || tokenData.logo;
              
              // Price extraction - check multiple fields
              const priceValue = parseFloat(discovery.price_usd || discovery.price || discovery.token_price || 0);
              if (priceValue > 0) {
                tokenData.price = priceValue;
                console.log(`  ✓ [WATCHLIST EVM] Price from discovery: $${priceValue}`);
              }
              
              // Market cap extraction - check multiple fields
              const mcapValue = parseFloat(discovery.market_cap || discovery.marketCap || discovery.usd_market_cap || 0);
              if (mcapValue > 0) {
                tokenData.marketCap = mcapValue;
                console.log(`  ✓ [WATCHLIST EVM] Market cap from discovery: $${mcapValue}`);
              }
              
              // Volume 24h extraction
              const vol24h = parseFloat(
                discovery.volume_change_usd?.['1d'] || 
                discovery.volume_change_usd?.['24h'] || 
                discovery.volume_24h || 
                discovery.volume_usd_24h || 
                0
              );
              if (vol24h > 0) {
                tokenData.volume24h = vol24h;
                console.log(`  ✓ [WATCHLIST EVM] Volume 24h from discovery: $${vol24h}`);
              }
              
              // Liquidity extraction
              const liqValue = parseFloat(
                discovery.liquidity_change_usd?.['1d'] || 
                discovery.liquidity_change_usd?.['24h'] || 
                discovery.liquidity || 
                discovery.liquidity_usd || 
                0
              );
              if (liqValue > 0) {
                tokenData.liquidity = liqValue;
                console.log(`  ✓ [WATCHLIST EVM] Liquidity from discovery: $${liqValue}`);
              }
              
              // Price change 24h extraction
              const priceChange24hValue = parseFloat(
                discovery.price_change_usd?.['1d'] || 
                discovery.price_change_usd?.['24h'] || 
                discovery.price_change_24h || 
                discovery.price_change_percent_24h || 
                0
              );
              if (priceChange24hValue !== 0) {
                tokenData.priceChange24h = priceChange24hValue;
                console.log(`  ✓ [WATCHLIST EVM] Price change 24h from discovery: ${priceChange24hValue}%`);
              }
              
              // Holders extraction
              const holdersValue = parseInt(discovery.holders || discovery.totalHolders || discovery.total_holders || 0);
              if (holdersValue > 0) {
                tokenData.holders = holdersValue;
                console.log(`  ✓ [WATCHLIST EVM] Holders from discovery: ${holdersValue}`);
              }
            } else if (discoveryResponse.status === 'rejected') {
              console.log(`  ⚠ [WATCHLIST EVM] Discovery API failed:`, discoveryResponse.reason?.message || 'Unknown error');
            }
            
            // 2. Get price data (if not already fetched)
            if (tokenData.price === 0) {
              try {
                const priceResponse = await axios.get(
                  `https://deep-index.moralis.io/api/v2.2/erc20/${address}/price`,
                  {
                    params: { chain: chainId },
                    headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                    timeout: 10000
                  }
                );
                
                const priceData = priceResponse.data;
                console.log(`  📊 [WATCHLIST EVM] Price response for ${address}:`, JSON.stringify(priceData, null, 2));
                
                tokenData.price = parseFloat(priceData?.usdPrice || priceData?.price || 0);
                if (tokenData.priceChange24h === 0) {
                  tokenData.priceChange24h = parseFloat(priceData?.['24hrPercentChange'] || priceData?.priceChange24h || 0);
                }
                
                console.log(`  ✓ [WATCHLIST EVM] Price from price API: $${tokenData.price}, change=${tokenData.priceChange24h}%`);
              } catch (priceError) {
                console.log(`⚠ [WATCHLIST EVM] Could not fetch price:`, priceError.message);
                if (priceError.response) {
                  console.log(`   Response status: ${priceError.response.status}`);
                  console.log(`   Response data:`, JSON.stringify(priceError.response.data, null, 2));
                }
              }
            }
            
            // 3. Get token pairs for volume/liquidity
            if (tokenData.volume24h === 0 || tokenData.liquidity === 0) {
              try {
                const pairsResponse = await axios.get(
                  `https://deep-index.moralis.io/api/v2.2/erc20/${address}/pairs`,
                  {
                    params: { chain: moralisChain },
                    headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                    timeout: 10000
                  }
                );
                
                console.log(`  📊 [WATCHLIST EVM] Pairs response for ${address}:`, JSON.stringify(pairsResponse.data, null, 2));
                
                // Handle different response structures
                let pairs = [];
                if (Array.isArray(pairsResponse.data)) {
                  pairs = pairsResponse.data;
                } else if (Array.isArray(pairsResponse.data?.pairs)) {
                  pairs = pairsResponse.data.pairs;
                } else if (Array.isArray(pairsResponse.data?.result)) {
                  pairs = pairsResponse.data.result;
                }
                
                if (pairs.length > 0) {
                  console.log(`  ✓ [WATCHLIST EVM] Found ${pairs.length} pairs`);
                  
                  const totalLiquidity = pairs.reduce((sum, pair) => 
                    sum + parseFloat(pair.totalLiquidity || pair.liquidity_usd || pair.liquidity || 0), 0);
                  const totalVolume = pairs.reduce((sum, pair) => 
                    sum + parseFloat(pair.total24hVolume || pair.volume_24h || pair.volume24h || 0), 0);
                  
                  console.log(`  ✓ [WATCHLIST EVM] Aggregated: liquidity=$${totalLiquidity}, volume24h=$${totalVolume}`);
                  
                  if (totalLiquidity > 0) tokenData.liquidity = totalLiquidity;
                  if (totalVolume > 0) tokenData.volume24h = totalVolume;
                } else {
                  console.log(`  ⚠ [WATCHLIST EVM] No pairs found or unexpected structure`);
                }
              } catch (pairsError) {
                console.log(`⚠ [WATCHLIST EVM] Could not fetch pairs:`, pairsError.message);
                if (pairsError.response) {
                  console.log(`   Response status: ${pairsError.response.status}`);
                  console.log(`   Response data:`, JSON.stringify(pairsError.response.data, null, 2));
                }
              }
            }
            
            // 4. Get holder stats
            if (tokenData.holders === 0) {
              try {
                const holderStatsResponse = await axios.get(
                  `https://deep-index.moralis.io/api/v2.2/erc20/${address}/holders`,
                  {
                    params: { chain: moralisChain },
                    headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                    timeout: 15000
                  }
                );
                
                if (holderStatsResponse.data) {
                  tokenData.holders = parseInt(holderStatsResponse.data.totalHolders || holderStatsResponse.data.total_holders || 0);
                }
              } catch (holderError) {
                console.log(`⚠ [WATCHLIST EVM] Could not fetch holder stats:`, holderError.message);
              }
            }
            
            // 5. Get analytics for price change if missing
            if (tokenData.priceChange24h === 0 && tokenData.price > 0) {
              try {
                const analyticsResponse = await axios.get(
                  `https://deep-index.moralis.io/api/v2.2/tokens/${address}/analytics`,
                  {
                    params: { chain: moralisChain },
                    headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                    timeout: 10000
                  }
                );
                
                if (analyticsResponse.data?.pricePercentChange?.['24h'] !== undefined) {
                  tokenData.priceChange24h = parseFloat(analyticsResponse.data.pricePercentChange['24h']);
                }
              } catch (analyticsError) {
                console.log(`⚠ [WATCHLIST EVM] Could not fetch analytics:`, analyticsError.message);
              }
            }
            
            console.log(`✅ [WATCHLIST EVM] Enriched ${address}: ${tokenData.name} (${tokenData.symbol}), price=$${tokenData.price}, holders=${tokenData.holders}`);
          } catch (error) {
            console.error(`❌ [WATCHLIST EVM] Error enriching ${address}:`, error.message);
          }
        } else {
          // Solana Token - Reuse the token-details endpoint logic for consistency
          console.log(`📊 [WATCHLIST SOLANA] Fetching data for ${address}...`);
          
          try {
            // Use the same logic as fetchLaunchpadTokens and token-details endpoint
            // Fetch metadata, price, analytics, and holders in parallel
            const [metadataResponse, priceResponse, analyticsResponse, holderResponse] = await Promise.allSettled([
              // Try regular metadata first
              axios.get(
                `https://solana-gateway.moralis.io/token/mainnet/${address}/metadata`,
                {
                  headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                  timeout: 10000
                }
              ).catch(() => {
                // Fallback to Pump.fun metadata
                return axios.get(
                  `https://solana-gateway.moralis.io/token/mainnet/${address}/metadata/pumpfun`,
                  {
                    headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                    timeout: 10000
                  }
                );
              }),
              // Try regular price first
              axios.get(
                `https://solana-gateway.moralis.io/token/mainnet/${address}/price`,
                {
                  headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                  timeout: 10000
                }
              ).catch(() => {
                // Fallback to Pump.fun price
                return axios.get(
                  `https://solana-gateway.moralis.io/token/mainnet/${address}/price/pumpfun`,
                  {
                    headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                    timeout: 10000
                  }
                );
              }),
              // Get analytics for price change and market cap
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/tokens/${address}/analytics`,
                {
                  params: { chain: 'solana' },
                  headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                  timeout: 10000
                }
              ),
              // Get holders
              axios.get(
                `https://solana-gateway.moralis.io/token/mainnet/holders/${address}`,
                {
                  headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                  timeout: 15000
                }
              )
            ]);
            
            // Extract metadata
            if (metadataResponse.status === 'fulfilled' && metadataResponse.value?.data) {
              const metadata = metadataResponse.value.data;
              tokenData.name = metadata.name || tokenData.name;
              tokenData.symbol = metadata.symbol || tokenData.symbol;
              tokenData.logo = metadata.logo || tokenData.logo;
              
              console.log(`  ✓ [WATCHLIST SOLANA] Metadata: ${tokenData.name} (${tokenData.symbol})`);
            }
            
            // Extract price and market cap (PRIORITIZE fullyDilutedValue like fetchLaunchpadTokens does)
            if (priceResponse.status === 'fulfilled' && priceResponse.value?.data) {
              const priceData = priceResponse.value.data;
              tokenData.price = parseFloat(priceData.usdPrice || priceData.price || 0);
              
              // Market cap extraction with same priority as fetchLaunchpadTokens
              // 1. First try metadata.fullyDilutedValue (most reliable for Solana)
              if (metadataResponse.status === 'fulfilled' && metadataResponse.value?.data?.fullyDilutedValue) {
                tokenData.marketCap = parseFloat(metadataResponse.value.data.fullyDilutedValue);
                console.log(`  ✓ [WATCHLIST SOLANA] Market cap from metadata.fullyDilutedValue: $${tokenData.marketCap}`);
              }
              // 2. Then try priceData fields
              else {
                tokenData.marketCap = parseFloat(
                  priceData.usdMarketCap || 
                  priceData.marketCap || 
                  priceData.marketCapUsd || 
                  0
                );
                
                // 3. Calculate from price * supply if market cap still 0
                if (tokenData.marketCap === 0 && tokenData.price > 0 && metadataResponse.status === 'fulfilled') {
                  const metadata = metadataResponse.value.data;
                  if (metadata.totalSupply) {
                    const totalSupply = parseFloat(metadata.totalSupply) || 0;
                    const decimals = parseInt(metadata.decimals) || 9;
                    const adjustedSupply = totalSupply / Math.pow(10, decimals);
                    tokenData.marketCap = tokenData.price * adjustedSupply;
                    console.log(`  ✓ [WATCHLIST SOLANA] Calculated market cap: $${tokenData.marketCap}`);
                  }
                }
              }
              
              console.log(`  ✓ [WATCHLIST SOLANA] Price: $${tokenData.price}, Market Cap: $${tokenData.marketCap}`);
            }
            
            // Extract price change from analytics (PRIORITIZE analytics API)
            if (analyticsResponse.status === 'fulfilled' && analyticsResponse.value?.data) {
              const analytics = analyticsResponse.value.data;
              
              if (analytics.pricePercentChange?.['24h'] !== undefined) {
                tokenData.priceChange24h = parseFloat(analytics.pricePercentChange['24h']);
                console.log(`  ✓ [WATCHLIST SOLANA] Price change 24h from analytics: ${tokenData.priceChange24h}%`);
              } else if (analytics.pricePercentChange?.['24hr'] !== undefined) {
                tokenData.priceChange24h = parseFloat(analytics.pricePercentChange['24hr']);
                console.log(`  ✓ [WATCHLIST SOLANA] Price change 24h from analytics (24hr): ${tokenData.priceChange24h}%`);
              }
              
              // Analytics might also have market cap
              if (tokenData.marketCap === 0 && analytics.marketCap) {
                tokenData.marketCap = parseFloat(analytics.marketCap);
                console.log(`  ✓ [WATCHLIST SOLANA] Market cap from analytics: $${tokenData.marketCap}`);
              }
            }
            
            // Extract holders
            if (holderResponse.status === 'fulfilled' && holderResponse.value?.data) {
              tokenData.holders = parseInt(holderResponse.value.data?.totalHolders || 0);
              console.log(`  ✓ [WATCHLIST SOLANA] Holders: ${tokenData.holders}`);
            }
            
            console.log(`✅ [WATCHLIST SOLANA] Enriched ${address}: ${tokenData.name} (${tokenData.symbol}), price=$${tokenData.price}, marketCap=$${tokenData.marketCap}, holders=${tokenData.holders}, change=${tokenData.priceChange24h}%`);
        tokenData.contractAddress = address;
          } catch (error) {
            console.error(`❌ [WATCHLIST SOLANA] Error enriching ${address}:`, error.message);
            if (error.response) {
              console.error(`   Response status: ${error.response.status}`);
              console.error(`   Response data:`, JSON.stringify(error.response.data, null, 2));
            }
          }
        }
        
        // Update cached data in the watchlist item with fresh data
        tokenData.contractAddress = address;
        const updatedWatched = {
          ...watched,
          tokenData,
          address: normalizeAddressForChain(watched.chain, address),
          originalAddress: address,
          cachedTokenData: tokenData,
          dataCachedAt: new Date().toISOString()
        };
        
        return updatedWatched;
      } catch (error) {
        console.error(`❌ Error enriching watchlist item ${address || watched.address}:`, error.message);
        return {
          ...watched,
          tokenData: {
            name: watched.name || 'Unknown',
            symbol: watched.symbol || 'UNKNOWN',
            error: 'Failed to fetch data'
          }
        };
      }
    }));
    
    // Save updated watchlist data back to database
    try {
      const users = await loadUsers();
      const userIndex = users.findIndex(u => u.id === userId);
      if (userIndex >= 0 && users[userIndex].watchlist) {
        // Update watchlist items with fresh data
        enrichedWatchlist.forEach((updatedItem, index) => {
          const normalizedAddress = normalizeAddressForChain(updatedItem.chain, updatedItem.address);
          const watchlistIndex = users[userIndex].watchlist.findIndex(
            w => w.chain === updatedItem.chain && normalizeAddressForChain(w.chain, w.address) === normalizedAddress
          );
          if (watchlistIndex >= 0 && updatedItem.cachedTokenData) {
            users[userIndex].watchlist[watchlistIndex] = updatedItem;
          }
        });
        await saveUsers(users);
        console.log(`💾 [WATCHLIST] Saved updated data for ${enrichedWatchlist.length} tokens`);
      }
    } catch (saveError) {
      console.error('⚠️ [WATCHLIST] Error saving updated data:', saveError.message);
      // Don't fail the request if save fails
    }
    
    res.json({ watchlist: enrichedWatchlist });
  } catch (error) {
    console.error('Error getting watchlist:', error);
    res.status(500).json({
      error: 'Failed to get watchlist',
      message: error.message
    });
  }
});

// Add token to watchlist
app.post('/api/watchlist/add', requireAuth, async (req, res) => {
  try {
    console.log('📝 [WATCHLIST ADD] Request body:', JSON.stringify(req.body, null, 2));
    console.log('📝 [WATCHLIST ADD] User:', req.user?.id);
    
    const userId = req.user.id;
    const { chain, address, name, symbol, tokenData } = req.body;
    
    console.log('📝 [WATCHLIST ADD] Extracted:', { chain, address, name, symbol, hasTokenData: !!tokenData });
    
    if (!chain || !address) {
      console.error('❌ [WATCHLIST ADD] Missing required fields:', { chain: !!chain, address: !!address });
      return res.status(400).json({ error: 'Missing required fields: chain, address' });
    }
    
    const users = await loadUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!users[userIndex].watchlist) {
      users[userIndex].watchlist = [];
    }
    
    // Check if already in watchlist
    const normalizedAddress = normalizeAddressForChain(chain, address);
    const exists = users[userIndex].watchlist.some(
      w => w.chain === chain && normalizeAddressForChain(w.chain, w.address) === normalizedAddress
    );
    
    if (exists) {
      return res.status(400).json({ error: 'Token already in watchlist' });
    }
    
    // Store token with full data if provided (from token card)
    const watchlistItem = {
      chain,
      address: normalizedAddress,
      originalAddress: address,
      name: name || 'Unknown Token',
      symbol: symbol || 'UNKNOWN',
      addedDate: new Date().toISOString(),
      cachedTokenData: tokenData || null,
      dataCachedAt: tokenData ? new Date().toISOString() : null
    };
    
    users[userIndex].watchlist.push(watchlistItem);
    
    await saveUsers(users);
    
    console.log(`✅ [WATCHLIST ADD] Added ${name} (${symbol}) with ${tokenData ? 'cached data' : 'no cached data'}`);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error adding to watchlist:', error);
    res.status(500).json({
      error: 'Failed to add to watchlist',
      message: error.message
    });
  }
});

// Remove token from watchlist
app.delete('/api/watchlist/remove', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { chain, address } = req.body;
    
    if (!chain || !address) {
      return res.status(400).json({ error: 'Missing required fields: chain, address' });
    }
    
    const users = await loadUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!users[userIndex].watchlist) {
      users[userIndex].watchlist = [];
    }
    
    const normalizedAddress = normalizeAddressForChain(chain, address);
    users[userIndex].watchlist = users[userIndex].watchlist.filter(
      w => !(w.chain === chain && normalizeAddressForChain(w.chain, w.address) === normalizedAddress)
    );
    
    await saveUsers(users);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing from watchlist:', error);
    res.status(500).json({
      error: 'Failed to remove from watchlist',
      message: error.message
    });
  }
});
// Debug endpoint to test Moralis API
app.get('/api/debug/moralis', async (req, res) => {
  console.log('🔍 Running Moralis API diagnostics...');
  
  const results = {
    timestamp: new Date().toISOString(),
    apiKeyConfigured: !!CONFIG.moralisApiKey,
    tests: []
  };

  if (!CONFIG.moralisApiKey) {
    results.error = 'Moralis API key not configured';
    return res.json(results);
  }

  // Test 1: Base USDC token metadata
  try {
    console.log('Test 1: Fetching Base USDC metadata...');
    const response = await axios.get(
      'https://deep-index.moralis.io/api/v2.2/erc20/metadata',
      {
        params: {
          chain: '0x2105',  // Base chain ID
          addresses: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']
        },
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 10000
      }
    );
    
    results.tests.push({
      name: 'Base USDC Metadata',
      status: 'success',
      data: response.data,
      endpoint: 'GET /erc20/metadata'
    });
    console.log('✓ Test 1 passed');
  } catch (error) {
    results.tests.push({
      name: 'Base USDC Metadata',
      status: 'failed',
      error: error.message,
      details: error.response?.data || null,
      statusCode: error.response?.status || null
    });
    console.error('✗ Test 1 failed:', error.message);
  }

  // Test 2: Base USDC price
  try {
    console.log('Test 2: Fetching Base USDC price...');
    const response = await axios.get(
      'https://deep-index.moralis.io/api/v2.2/erc20/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913/price',
      {
        params: { chain: '0x2105' },  // Base chain ID
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 10000
      }
    );
    
    results.tests.push({
      name: 'Base USDC Price',
      status: 'success',
      data: response.data,
      endpoint: 'GET /erc20/{address}/price'
    });
    console.log('✓ Test 2 passed');
  } catch (error) {
    results.tests.push({
      name: 'Base USDC Price',
      status: 'failed',
      error: error.message,
      details: error.response?.data || null,
      statusCode: error.response?.status || null
    });
    console.error('✗ Test 2 failed:', error.message);
  }

  // Test 3: Ethereum USDT metadata
  try {
    console.log('Test 3: Fetching Ethereum USDT metadata...');
    const response = await axios.get(
      'https://deep-index.moralis.io/api/v2.2/erc20/metadata',
      {
        params: {
          chain: '0x1',  // Ethereum chain ID
          addresses: ['0xdac17f958d2ee523a2206206994597c13d831ec7']
        },
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 10000
      }
    );
    
    results.tests.push({
      name: 'Ethereum USDT Metadata',
      status: 'success',
      data: response.data,
      endpoint: 'GET /erc20/metadata'
    });
    console.log('✓ Test 3 passed');
  } catch (error) {
    results.tests.push({
      name: 'Ethereum USDT Metadata',
      status: 'failed',
      error: error.message,
      details: error.response?.data || null,
      statusCode: error.response?.status || null
    });
    console.error('✗ Test 3 failed:', error.message);
  }

  // Test 4: BSC USDT metadata
  try {
    console.log('Test 4: Fetching BSC USDT metadata...');
    const response = await axios.get(
      'https://deep-index.moralis.io/api/v2.2/erc20/metadata',
      {
        params: {
          chain: '0x38',  // BNB Chain ID
          addresses: ['0x55d398326f99059ff775485246999027b3197955']
        },
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 10000
      }
    );
    
    results.tests.push({
      name: 'BSC USDT Metadata',
      status: 'success',
      data: response.data,
      endpoint: 'GET /erc20/metadata'
    });
    console.log('✓ Test 4 passed');
  } catch (error) {
    results.tests.push({
      name: 'BSC USDT Metadata',
      status: 'failed',
      error: error.message,
      details: error.response?.data || null,
      statusCode: error.response?.status || null
    });
    console.error('✗ Test 4 failed:', error.message);
  }

  // Summary
  const passed = results.tests.filter(t => t.status === 'success').length;
  const failed = results.tests.filter(t => t.status === 'failed').length;
  
  results.summary = {
    total: results.tests.length,
    passed,
    failed,
    successRate: `${Math.round((passed / results.tests.length) * 100)}%`
  };

  console.log(`\n📊 Moralis API Test Summary: ${passed}/${results.tests.length} passed\n`);

  res.json(results);
});
// Helper function to fetch tokens from a specific launchpad
async function fetchLaunchpadTokens(launchpadId) {
  const launchpad = LAUNCHPADS[launchpadId];
  if (!launchpad) {
    throw new Error(`Unknown launchpad: ${launchpadId}`);
  }

  const tokens = [];

  try {
    // Solana - Use graduated tokens API for Pump.fun
    if (launchpad.isSolana) {
      console.log(`📡 Fetching Solana ${launchpad.name} graduated tokens...`);
      const response = await axios.get(
        `https://solana-gateway.moralis.io/token/mainnet/exchange/${launchpad.exchangeId}/graduated`,
        {
          params: { limit: 20 },
          headers: { 
            'X-API-Key': CONFIG.moralisApiKey,
            'accept': 'application/json'
          },
          timeout: 15000
        }
      );

      if (response.data?.result && Array.isArray(response.data.result)) {
        console.log(`✓ Found ${response.data.result.length} ${launchpad.name} tokens`);
        
        // Fetch price data, analytics, metadata, and holder stats for each token in parallel
        const pricePromises = response.data.result.map(async (token) => {
          try {
            // Fetch price, analytics, metadata, and holder stats in parallel
            const [priceResponse, analyticsResponse, metadataResponse, holderResponse] = await Promise.allSettled([
              axios.get(
                `https://solana-gateway.moralis.io/token/mainnet/${token.tokenAddress}/price`,
                {
                  headers: { 
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 8000
                }
              ),
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/tokens/${token.tokenAddress}/analytics`,
                {
                  params: { chain: 'solana' },
                  headers: { 
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 8000
                }
              ),
              axios.get(
                `https://solana-gateway.moralis.io/token/mainnet/${token.tokenAddress}/metadata`,
                {
                  headers: { 
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 8000
                }
              ),
              axios.get(
                `https://solana-gateway.moralis.io/token/mainnet/holders/${token.tokenAddress}`,
                {
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 8000
                }
              )
            ]);
            
            let priceChange = 0;
            let marketCap = 0;
            let price = 0;
            
            // Extract price data
            if (priceResponse.status === 'fulfilled') {
              const priceData = priceResponse.value.data;
              price = parseFloat(priceData?.usdPrice || priceData?.price || 0);
              
              // Extract market cap from price data
              marketCap = parseFloat(
                priceData?.usdMarketCap || 
                priceData?.marketCap || 
                priceData?.marketCapUsd ||
                0
              );
              
              console.log(`  💰 ${token.symbol} price data: price=$${price}, marketCap=$${marketCap}`);
            }
            
            // Extract metadata for totalSupply to calculate market cap
            let totalSupply = 0;
            let decimals = parseInt(token.decimals) || 9;
            if (metadataResponse.status === 'fulfilled') {
              const metadata = metadataResponse.value.data;
              decimals = parseInt(metadata?.decimals || token.decimals || 9);
              // Solana metadata might have supply in different fields
              totalSupply = parseFloat(
                metadata?.supply || 
                metadata?.totalSupply || 
                metadata?.maxSupply ||
                token.supply ||
                token.totalSupply || 
                0
              );
              console.log(`  📊 ${token.symbol} metadata: totalSupply=${totalSupply}, decimals=${decimals}`);
              console.log(`  📊 ${token.symbol} metadata keys:`, Object.keys(metadata || {}));
            } else {
              console.log(`  ⚠ Metadata fetch failed for ${token.symbol}:`, metadataResponse.reason?.message || 'Unknown error');
            }
            
            // Calculate market cap from price and total supply if not already set
            if (marketCap === 0 && price > 0) {
              if (totalSupply > 0) {
                const adjustedSupply = totalSupply / Math.pow(10, decimals);
                marketCap = price * adjustedSupply;
                console.log(`  💰 Calculated market cap for ${token.symbol}: $${marketCap} (price: $${price}, supply: ${adjustedSupply})`);
              } else {
                // Try to use fullyDilutedValuation from token response as approximation
                if (token.fullyDilutedValuation) {
                  marketCap = parseFloat(token.fullyDilutedValuation);
                  console.log(`  💰 Using FDV as market cap approximation for ${token.symbol}: $${marketCap}`);
                }
              }
            }
            
            // Extract holder count - CRITICAL: Use correct API response format
            let holders = 0;
            if (holderResponse.status === 'fulfilled') {
              const holderData = holderResponse.value.data;
              // Try multiple possible response formats
              holders = parseInt(
                holderData?.totalHolders || 
                holderData?.holders || 
                holderData?.holderCount ||
                0
              );
              console.log(`  👥 ${token.symbol} holders response keys:`, Object.keys(holderData || {}));
              console.log(`  👥 ${token.symbol} holders response:`, JSON.stringify(holderData, null, 2));
              console.log(`  👥 ${token.symbol} holders extracted: ${holders}`);
              
              // If still 0, try to extract from nested structures
              if (holders === 0 && holderData) {
                // Check if it's an array with count
                if (Array.isArray(holderData) && holderData.length > 0) {
                  holders = holderData.length;
                  console.log(`  👥 ${token.symbol} holders from array length: ${holders}`);
                }
                // Check if there's a result object
                else if (holderData.result && Array.isArray(holderData.result)) {
                  holders = holderData.result.length;
                  console.log(`  👥 ${token.symbol} holders from result array: ${holders}`);
                }
              }
            } else {
              console.log(`  ⚠ Holder fetch failed for ${token.symbol}:`, holderResponse.reason?.message || 'Unknown error');
              if (holderResponse.reason?.response) {
                console.log(`     Status: ${holderResponse.reason.response.status}`);
                console.log(`     Data:`, JSON.stringify(holderResponse.reason.response.data, null, 2));
              }
            }
            
            // ALWAYS prioritize analytics API - it has the most reliable price percentage data
            if (analyticsResponse.status === 'fulfilled') {
              const analytics = analyticsResponse.value.data;
              console.log(`  📊 Analytics response for ${token.symbol}:`, JSON.stringify(analytics, null, 2));
              
              // Analytics API returns pricePercentChange.24h for 24-hour change
              if (analytics.pricePercentChange && analytics.pricePercentChange['24h'] !== undefined) {
                priceChange = parseFloat(analytics.pricePercentChange['24h']);
                console.log(`    ✓ Found pricePercentChange.24h: ${priceChange}%`);
              } else if (analytics.pricePercentChange && analytics.pricePercentChange['24hr'] !== undefined) {
                priceChange = parseFloat(analytics.pricePercentChange['24hr']);
                console.log(`    ✓ Found pricePercentChange.24hr: ${priceChange}%`);
              } else {
                console.log(`    ⚠ Analytics response missing pricePercentChange.24h`);
              }
              
              // Analytics might also have market cap
              if (marketCap === 0 && analytics.marketCap !== undefined) {
                marketCap = parseFloat(analytics.marketCap);
                console.log(`    ✓ Found marketCap from analytics: $${marketCap}`);
              }
            } else {
              console.log(`    ⚠ Analytics API call failed:`, analyticsResponse.reason?.message || 'Unknown error');
            }
            
            // Fallback to price endpoint only if analytics didn't provide data
            if (priceChange === 0 && priceResponse.status === 'fulfilled') {
              const priceData = priceResponse.value.data;
              console.log(`  🔍 Falling back to price endpoint for ${token.symbol}:`, JSON.stringify(priceData, null, 2));
              
              priceChange = parseFloat(
                priceData?.['24hrPercentChange'] || 
                priceData?.usdPriceChange24h || 
                priceData?.priceChange24h ||
                priceData?.price24hChange ||
                0
              );
              if (priceChange !== 0) {
                console.log(`    ✓ Got priceChange from price endpoint: ${priceChange}%`);
              }
            }
            
            console.log(`  📊 ${token.symbol} 24h change: ${priceChange}%, marketCap: $${marketCap}, price: $${price}`);
            
            return {
              address: token.tokenAddress,
              priceChange24h: priceChange,
              marketCap: marketCap,
              price: price,
              holders: holders
            };
          } catch (error) {
            console.log(`⚠ Could not fetch price/analytics/holders for ${token.symbol}:`, error.message);
            return { address: token.tokenAddress, priceChange24h: 0, marketCap: 0, price: 0, holders: 0 };
          }
        });
        
        const priceData = await Promise.all(pricePromises);
        const priceMap = Object.fromEntries(priceData.map(p => [p.address, p.priceChange24h]));
        const marketCapMap = Object.fromEntries(priceData.map(p => [p.address, p.marketCap]));
        const priceValueMap = Object.fromEntries(priceData.map(p => [p.address, p.price]));
        const holderMap = Object.fromEntries(priceData.map(p => [p.address, p.holders || 0]));
        
        // Debug: Log the priceMap to verify values
        console.log(`  📊 PriceMap for ${launchpad.name}:`, JSON.stringify(priceMap, null, 2));
        console.log(`  👥 HolderMap for ${launchpad.name}:`, JSON.stringify(holderMap, null, 2));
        
        for (const token of response.data.result) {
          const tokenPriceChange = priceMap[token.tokenAddress] || 0;
          const tokenHolders = holderMap[token.tokenAddress] || 0;
          const tokenMarketCap = marketCapMap[token.tokenAddress] || 0;
          const tokenPrice = priceValueMap[token.tokenAddress] || parseFloat(token.priceUsd || 0);
          
          // If market cap is still 0, try multiple fallback sources
          let finalMarketCap = tokenMarketCap;
          if (finalMarketCap === 0) {
            // Try from graduated tokens response
            finalMarketCap = parseFloat(
              token.marketCap || 
              token.fullyDilutedValuation || 
              token.fdv ||
              0
            );
            console.log(`  💰 Using FDV/fallback market cap for ${token.symbol}: $${finalMarketCap}`);
            
            // Last resort: if we have price and FDV, try to infer market cap
            // (FDV is usually close to market cap for new tokens)
            if (finalMarketCap === 0 && tokenPrice > 0 && token.fullyDilutedValuation) {
              finalMarketCap = parseFloat(token.fullyDilutedValuation);
              console.log(`  💰 Using fullyDilutedValuation as market cap: $${finalMarketCap}`);
            }
          }
          
          // For Solana tokens, calculate market cap as price × 1 billion if still 0
          if (finalMarketCap === 0 && tokenPrice > 0 && launchpad.chain === 'solana') {
            finalMarketCap = tokenPrice * 1000000000; // 1 billion supply
            console.log(`  💰 Calculated Solana market cap (price × 1B): $${finalMarketCap}`);
          }
          
          console.log(`  ✓ ${token.symbol} (${token.tokenAddress.slice(0, 8)}...): priceChange=${tokenPriceChange}%, holders=${tokenHolders}, marketCap=$${finalMarketCap}, price=$${tokenPrice}`);
          
          tokens.push({
            chain: launchpad.chain,
            address: token.tokenAddress,
            name: token.name || 'Solana Token',
            symbol: token.symbol || 'SOL',
            decimals: parseInt(token.decimals) || 9,
            logo: token.logo || null,
            price: tokenPrice,
            priceChange24h: tokenPriceChange,
            marketCap: finalMarketCap,
            liquidity: parseFloat(token.liquidity || 0),
            holders: tokenHolders,
            createdAt: token.graduatedAt || new Date().toISOString(),
            launchpad: launchpad.name
          });
        }
      } else {
        console.log(`⚠ No ${launchpad.name} graduated tokens found`);
      }
    } 
    // EVM chains - Fetch popular tokens with full metadata
    else {
      console.log(`📡 Fetching ${launchpad.name} popular tokens on ${launchpad.chain}...`);
      
      if (!launchpad.popularTokens || launchpad.popularTokens.length === 0) {
        console.log(`⚠ No popular tokens configured for ${launchpad.name}`);
        return tokens;
      }

      // Fetch metadata for all tokens
      const metadataResponse = await axios.get(
        `https://deep-index.moralis.io/api/v2.2/erc20/metadata`,
        {
          params: { 
            chain: launchpad.chainId,
            addresses: launchpad.popularTokens
          },
          headers: { 
            'X-API-Key': CONFIG.moralisApiKey,
            'accept': 'application/json'
          },
          timeout: 15000
        }
      );

      if (metadataResponse.data && Array.isArray(metadataResponse.data)) {
        console.log(`✓ Found ${metadataResponse.data.length} ${launchpad.name} tokens`);
        
        // Fetch price for each token
        for (const token of metadataResponse.data) {
          try {
            const priceResponse = await axios.get(
              `https://deep-index.moralis.io/api/v2.2/erc20/${token.address}/price`,
              {
                params: { chain: launchpad.chainId },
                headers: { 
                  'X-API-Key': CONFIG.moralisApiKey,
                  'accept': 'application/json'
                },
                timeout: 10000
              }
            );

            const priceData = priceResponse.data;

            // Try to get logo from multiple sources
            let logoUrl = token.logo || token.thumbnail;
            if (!logoUrl) {
              // Fallback to TrustWallet asset repository
              const trustWalletChainMap = {
                'bnb': 'smartchain',
                'ethereum': 'ethereum',
                'base': 'base'
              };
              const trustChain = trustWalletChainMap[launchpad.chain];
              if (trustChain) {
                logoUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${trustChain}/assets/${token.address}/logo.png`;
              }
            }

            tokens.push({
              chain: launchpad.chain,
              address: token.address,
              name: token.name || 'Unknown Token',
              symbol: token.symbol || 'UNKNOWN',
              decimals: parseInt(token.decimals) || 18,
              logo: logoUrl,
              price: parseFloat(priceData?.usdPrice || 0),
              priceChange24h: parseFloat(priceData?.['24hrPercentChange'] || 0),
              marketCap: priceData?.usdPrice ? parseFloat(priceData.usdPrice) * 1000000000 : 0,
              liquidity: 0,
              holders: 0,
              createdAt: new Date().toISOString(),
              launchpad: launchpad.name
            });
          } catch (priceError) {
            console.log(`⚠ Could not fetch price for ${token.symbol}:`, priceError.message);
            
            // Try to get logo from multiple sources
            let logoUrl = token.logo || token.thumbnail;
            if (!logoUrl) {
              // Fallback to TrustWallet asset repository
              const trustWalletChainMap = {
                'bnb': 'smartchain',
                'ethereum': 'ethereum',
                'base': 'base'
              };
              const trustChain = trustWalletChainMap[launchpad.chain];
              if (trustChain) {
                logoUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${trustChain}/assets/${token.address}/logo.png`;
              }
            }

            // Add token without price
            tokens.push({
              chain: launchpad.chain,
              address: token.address,
              name: token.name || 'Unknown Token',
              symbol: token.symbol || 'UNKNOWN',
              decimals: parseInt(token.decimals) || 18,
              logo: logoUrl,
              price: 0,
              priceChange24h: 0,
              marketCap: 0,
              liquidity: 0,
              holders: 0,
              createdAt: new Date().toISOString(),
              launchpad: launchpad.name
            });
          }
        }
      } else {
        console.log(`⚠ No ${launchpad.name} tokens found`);
      }
    }
  } catch (error) {
    console.error(`❌ Error fetching ${launchpad.name} tokens:`, error.response?.data || error.message);
    if (error.response?.status) {
      console.error(`   HTTP Status: ${error.response.status}`);
    }
  }

  return tokens;
}

// Helper function to fetch trending tokens from Moralis
async function fetchTrendingTokens(chain) {
  const chainMapping = {
    'bnb': 'binance',
    'base': 'base',
    'ethereum': 'ethereum',
    'eth': 'ethereum'
  };
  
  const moralisChain = chainMapping[chain] || chain;
  console.log(`📈 Fetching trending tokens for ${chain} (Moralis chain: ${moralisChain})...`);
  
  try {
    const response = await axios.get(
      'https://deep-index.moralis.io/api/v2.2/tokens/trending',
      {
        params: {
          chain: moralisChain,
          limit: 25
        },
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 15000
      }
    );

    const tokens = [];
    const trendingData = response.data || [];
    
    if (Array.isArray(trendingData)) {
      // Fetch holder stats for all tokens in parallel (only for EVM chains)
      const isEVM = ['bnb', 'base', 'ethereum', 'eth'].includes(chain.toLowerCase());
      
      const tokenPromises = trendingData.map(async (token) => {
        let holders = parseInt(token.holders || 0);
        
        // Fetch holder stats from Moralis if EVM chain
        if (isEVM && token.tokenAddress) {
          try {
            // Map chain to Moralis format for holder stats API (bsc, base, eth)
            const holderChainMap = {
              'bnb': 'bsc',
              'base': 'base',
              'ethereum': 'eth',
              'eth': 'eth'
            };
            const holderChain = holderChainMap[chain.toLowerCase()] || chain.toLowerCase();
            
            console.log(`  📊 Fetching holder stats for ${token.symbol} (${token.tokenAddress}) on ${chain} (chain: ${holderChain})`);
            
            const holderStatsResponse = await axios.get(
              `https://deep-index.moralis.io/api/v2.2/erc20/${token.tokenAddress}/holders`,
              {
                params: {
                  chain: holderChain
                },
                headers: {
                  'X-API-Key': CONFIG.moralisApiKey,
                  'accept': 'application/json'
                },
                timeout: 15000
              }
            );
            
            const stats = holderStatsResponse.data || {};
            holders = parseInt(stats.totalHolders) || 0;
            
            if (holders > 0) {
              console.log(`  ✓ ${token.symbol}: ${holders} holders (from API)`);
            } else {
              console.log(`  ⚠ ${token.symbol}: API returned 0 holders or missing totalHolders field`);
              console.log(`     Response keys:`, Object.keys(stats));
              if (Object.keys(stats).length === 0) {
                console.log(`     Empty response from API`);
              }
            }
          } catch (holderError) {
            // If holder stats fail, use default (0) - don't block token from being returned
            console.error(`  ❌ Could not fetch holders for ${token.symbol}:`);
            console.error(`     Error: ${holderError.message}`);
            if (holderError.response) {
              console.error(`     Status: ${holderError.response.status}`);
              console.error(`     Data:`, JSON.stringify(holderError.response.data, null, 2));
            }
            console.error(`     URL: ${holderError.config?.url}`);
            console.error(`     Params:`, JSON.stringify(holderError.config?.params, null, 2));
          }
        }
        
        return {
          chain: chain,
          address: token.tokenAddress || token.address,
          name: token.name || 'Unknown Token',
          symbol: token.symbol || 'UNKNOWN',
          decimals: parseInt(token.decimals) || 18,
          logo: token.logo || null,
          price: parseFloat(token.usdPrice || 0),
          priceChange24h: parseFloat(token.pricePercentChange?.['24h'] || 0),
          marketCap: parseFloat(token.marketCap || 0),
          liquidity: parseFloat(token.liquidityUsd || 0),
          holders: holders,
          volume24h: parseFloat(token.totalVolume?.['24h'] || 0),
          createdAt: new Date().toISOString(),
          launchpad: 'Trending'
        };
      });
      
      const tokenResults = await Promise.allSettled(tokenPromises);
      tokens.push(...tokenResults.filter(r => r.status === 'fulfilled').map(r => r.value));
    }
    
    console.log(`✓ Found ${tokens.length} trending tokens for ${chain}`);
    return tokens;
  } catch (error) {
    console.error(`❌ Error fetching trending tokens for ${chain}:`, error.response?.data || error.message);
    return [];
  }
}
// Fetch all launchpad tokens (grouped by launchpad)
// NOTE: This route MUST come before /:launchpadId to avoid "all" being treated as an ID
app.get('/api/launchpad/all', async (req, res) => {
  try {
    // Validate environment variables first
    if (!CONFIG.moralisApiKey) {
      console.error('❌ MORALIS_API_KEY is missing!');
      console.error('   NODE_ENV:', process.env.NODE_ENV || 'not set');
      console.error('   .env file loaded:', !!require('dotenv').config().parsed);
      return res.status(500).json({
        success: false,
        error: 'MORALIS_API_KEY is not configured. Please check your .env file.',
        debug: {
          nodeEnv: process.env.NODE_ENV || 'not set',
          hasMoralisKey: !!CONFIG.moralisApiKey,
          port: CONFIG.port
        },
        launchpads: {}
      });
    }

    // Check cache first (unless nocache is requested)
    const bypassCache = req.query && (req.query.nocache === '1' || req.query.nocache === 'true' || req.query.t);
    if (!bypassCache) {
      const cached = cache.get('all-launchpads');
      if (cached) {
        console.log('✓ Returning cached launchpad data');
        return res.json(cached);
      }
    } else {
      console.log('🔄 Bypassing cache (nocache parameter detected)');
      cache.del('all-launchpads'); // Clear cache before fetching fresh data
    }

    console.log('🔄 Fetching fresh token data...');
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔑 Moralis API Key: ${CONFIG.moralisApiKey ? '✓ Set' : '✗ Missing'}`);
    const launchpadData = {};
    let totalTokens = 0;

    // 1. First: Fetch Pump.fun tokens
    try {
      console.log(`📡 Fetching Pump.fun tokens...`);
      const pumpfunTokens = await fetchLaunchpadTokens('pumpfun');
      
      launchpadData['pumpfun'] = {
        info: LAUNCHPADS.pumpfun,
        tokens: pumpfunTokens,
        count: pumpfunTokens.length
      };
      
      totalTokens += pumpfunTokens.length;
      console.log(`✓ Pump.fun: ${pumpfunTokens.length} tokens`);
    } catch (error) {
      console.error(`❌ Error fetching Pump.fun:`, error.message);
      launchpadData['pumpfun'] = {
        info: LAUNCHPADS.pumpfun,
        tokens: [],
        count: 0,
        error: error.message
      };
    }

    // 2. Second: Fetch trending tokens for BNB Chain
    try {
      const bnbTokens = await fetchTrendingTokens('bnb');
      
      launchpadData['bnb_trending'] = {
        info: {
          name: 'BNB Chain Trending',
          chain: 'bnb',
          emoji: '🟡',
          description: 'Trending tokens on BNB Chain'
        },
        tokens: bnbTokens,
        count: bnbTokens.length
      };
      
      totalTokens += bnbTokens.length;
      console.log(`✓ BNB Chain Trending: ${bnbTokens.length} tokens`);
    } catch (error) {
      console.error(`❌ Error fetching BNB trending:`, error.message);
      launchpadData['bnb_trending'] = {
        info: {
          name: 'BNB Chain Trending',
          chain: 'bnb',
          emoji: '🟡',
          description: 'Trending tokens on BNB Chain'
        },
        tokens: [],
        count: 0,
        error: error.message
      };
    }

    // 3. Third: Fetch trending tokens for Base
    try {
      const baseTokens = await fetchTrendingTokens('base');
      
      launchpadData['base_trending'] = {
        info: {
          name: 'Base Trending',
          chain: 'base',
          emoji: '🔵',
          description: 'Trending tokens on Base'
        },
        tokens: baseTokens,
        count: baseTokens.length
      };
      
      totalTokens += baseTokens.length;
      console.log(`✓ Base Trending: ${baseTokens.length} tokens`);
    } catch (error) {
      console.error(`❌ Error fetching Base trending:`, error.message);
      launchpadData['base_trending'] = {
        info: {
          name: 'Base Trending',
          chain: 'base',
          emoji: '🔵',
          description: 'Trending tokens on Base'
        },
        tokens: [],
        count: 0,
        error: error.message
      };
    }

    // 4. Fourth: Fetch trending tokens for Ethereum
    try {
      const ethTokens = await fetchTrendingTokens('ethereum');
      
      launchpadData['eth_trending'] = {
        info: {
          name: 'Ethereum Trending',
          chain: 'ethereum',
          emoji: '⚫',
          description: 'Trending tokens on Ethereum'
        },
        tokens: ethTokens,
        count: ethTokens.length
      };
      
      totalTokens += ethTokens.length;
      console.log(`✓ Ethereum Trending: ${ethTokens.length} tokens`);
    } catch (error) {
      console.error(`❌ Error fetching Ethereum trending:`, error.message);
      launchpadData['eth_trending'] = {
        info: {
          name: 'Ethereum Trending',
          chain: 'ethereum',
          emoji: '⚫',
          description: 'Trending tokens on Ethereum'
        },
        tokens: [],
        count: 0,
        error: error.message
      };
    }

    const response = {
      success: true,
      launchpads: launchpadData,
      totalTokens,
      totalLaunchpads: Object.keys(launchpadData).length,
      timestamp: new Date().toISOString()
    };

    // Clear cache first to ensure fresh data
    cache.del('all-launchpads');
    
    // Cache the result for 10 minutes (frequently changing data)
    cache.set('all-launchpads', response, 600);

    console.log(`✓ Total tokens: ${totalTokens}`);
    res.json(response);
  } catch (error) {
    console.error('❌ Error in /api/launchpad/all:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      launchpads: {}
    });
  }
});

// Fetch tokens from a specific launchpad
app.get('/api/launchpad/:launchpadId', async (req, res) => {
  try {
    const { launchpadId } = req.params;
    const cacheKey = `launchpad-${launchpadId}`;
    
    // Check cache first
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log(`✓ Returning cached ${launchpadId} tokens`);
      return res.json(cached);
    }

    console.log(`🔄 Fetching ${launchpadId} tokens...`);
    const tokens = await fetchLaunchpadTokens(launchpadId);

    const response = {
      success: true,
      launchpad: LAUNCHPADS[launchpadId],
      tokens,
      count: tokens.length,
      timestamp: new Date().toISOString()
    };

    // Cache the result
    cache.set(cacheKey, response);

    res.json(response);
  } catch (error) {
    console.error(`❌ Error fetching launchpad tokens:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      tokens: []
    });
  }
});

// Legacy endpoint - fetch all tokens as flat array (for backward compatibility)
app.get('/api/tokens/flat', async (req, res) => {
  try {
    const launchpadResponse = await axios.get(`${req.protocol}://${req.get('host')}/api/launchpad/all`);
    const { launchpads } = launchpadResponse.data;
    
    const allTokens = [];
    for (const [launchpadId, data] of Object.entries(launchpads)) {
      allTokens.push(...data.tokens);
    }
    
    res.json(allTokens);
  } catch (error) {
    console.error('❌ Error in /api/tokens/flat:', error);
    res.json(DEMO_TOKENS);
  }
});

// Get detailed token information
app.get('/api/token-details/:chain/:address', async (req, res) => {
  const { chain, address } = req.params;

  try {
    console.log(`🔍 Fetching details for ${address} on ${chain}...`);

    // Check cache
    const cacheKey = `token-details-${chain}-${address}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✓ Returning cached token details');
      return res.json(cached);
    }

    const details = {
      address,
      chain,
      metadata: {},
      price: {},
      stats: {},
      pairs: [],
      holders: [],
      transfers: []
    };

    // Solana token details
    if (chain === 'solana') {
      try {
        // Get metadata
        const metadataResponse = await axios.get(
          `https://solana-gateway.moralis.io/token/mainnet/${address}/metadata`,
          {
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 10000
          }
        );
        details.metadata = metadataResponse.data;

        // Get price
        const priceResponse = await axios.get(
          `https://solana-gateway.moralis.io/token/mainnet/${address}/price`,
          {
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 10000
          }
        );
        details.price = priceResponse.data;

        // Get token analytics for price percentage data
        try {
          const analyticsResponse = await axios.get(
            `https://deep-index.moralis.io/api/v2.2/tokens/${address}/analytics`,
            {
              params: { chain: 'solana' },
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 10000
            }
          );
          
          const analytics = analyticsResponse.data || {};
          
          // Store analytics data
          details.analytics = analytics;
          
          // Extract price percentage change from analytics
          // Analytics API returns pricePercentChange.24h for 24-hour change
          let analyticsPriceChange = null;
          if (analytics.pricePercentChange && analytics.pricePercentChange['24h'] !== undefined) {
            analyticsPriceChange = parseFloat(analytics.pricePercentChange['24h']);
          } else if (analytics.pricePercentChange && analytics.pricePercentChange['24hr'] !== undefined) {
            analyticsPriceChange = parseFloat(analytics.pricePercentChange['24hr']);
          }
          
          // If we got price change from analytics, use it (it's more reliable)
          if (analyticsPriceChange !== null && !isNaN(analyticsPriceChange)) {
            details.price['24hrPercentChange'] = analyticsPriceChange;
            details.price.priceChange24h = analyticsPriceChange;
            details.price.usdPriceChange24h = analyticsPriceChange;
            console.log(`✓ Got price change from analytics.pricePercentChange.24h: ${analyticsPriceChange}%`);
          } else {
            console.log(`⚠ Analytics doesn't contain pricePercentChange.24h, using price endpoint data`);
          }
          
          console.log(`✓ Fetched token analytics`);
        } catch (analyticsError) {
          console.log(`⚠ Token analytics not available:`, analyticsError.message);
          // Don't fail if analytics unavailable - use price endpoint data
        }

        // Get holder statistics for Solana tokens
        try {
          const holderStatsResponse = await axios.get(
            `https://solana-gateway.moralis.io/token/mainnet/holders/${address}`,
            {
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 10000
            }
          );
          
          const stats = holderStatsResponse.data || {};
          details.holderStats = {
            totalHolders: stats.totalHolders || 0,
            holdersByAcquisition: stats.holdersByAcquisition || {
              swap: 0,
              transfer: 0,
              airdrop: 0
            }
          };
          console.log(`✓ Fetched holder stats: ${details.holderStats.totalHolders} holders`);
        } catch (holderStatsError) {
          console.log(`⚠ Holder stats not available:`, holderStatsError.message);
          details.holderStats = null;
        }

        console.log(`✓ Fetched Solana token details`);
      } catch (error) {
        console.error(`❌ Error fetching Solana token details:`, error.message);
      }
    } 
    // EVM token details
    else {
      const launchpad = Object.values(LAUNCHPADS).find(lp => lp.chain === chain && !lp.isSolana);
      if (!launchpad) {
        return res.status(400).json({ error: 'Invalid chain' });
      }

      try {
        // Get metadata
        const metadataResponse = await axios.get(
          `https://deep-index.moralis.io/api/v2.2/erc20/metadata`,
          {
            params: {
              chain: launchpad.chainId,
              addresses: [address]
            },
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 10000
          }
        );
        details.metadata = metadataResponse.data?.[0] || {};

        // Get price
        const priceResponse = await axios.get(
          `https://deep-index.moralis.io/api/v2.2/erc20/${address}/price`,
          {
            params: { chain: launchpad.chainId },
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 10000
          }
        );
        details.price = priceResponse.data;

        // Try to get stats (24h volume, transactions)
        try {
          const statsResponse = await axios.get(
            `https://deep-index.moralis.io/api/v2.2/erc20/${address}/stats`,
            {
              params: { chain: launchpad.chainId },
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 10000
            }
          );
          details.stats = statsResponse.data;
        } catch (statsError) {
          console.log(`⚠ Stats not available for ${address}`);
        }

        // Try to get pairs (liquidity pools)
        try {
          const pairsResponse = await axios.get(
            `https://deep-index.moralis.io/api/v2.2/erc20/${address}/pairs`,
            {
              params: { 
                chain: launchpad.chainId,
                limit: 5
              },
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 10000
            }
          );
          details.pairs = pairsResponse.data?.result || [];
        } catch (pairsError) {
          console.log(`⚠ Pairs not available for ${address}`);
        }

        // Try to get recent transfers
        try {
          const transfersResponse = await axios.get(
            `https://deep-index.moralis.io/api/v2.2/erc20/${address}/transfers`,
            {
              params: { 
                chain: launchpad.chainId,
                limit: 10
              },
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 10000
            }
          );
          details.transfers = transfersResponse.data?.result || [];
        } catch (transfersError) {
          console.log(`⚠ Transfers not available for ${address}`);
        }

        // Get holder statistics for EVM tokens - CRITICAL: Fetch from holder stats API
        try {
          // Map chain to Moralis format for holder stats API (bsc, base, eth)
          const holderChainMap = {
            'bnb': 'bsc',
            'base': 'base',
            'ethereum': 'eth',
            'eth': 'eth'
          };
          const holderChain = holderChainMap[chain.toLowerCase()] || chain.toLowerCase();
          
          // Use address exactly as provided (case-sensitive checksummed addresses)
          console.log(`📊 [HOLDER STATS] Fetching for ${address} on ${chain} (Moralis chain: ${holderChain})`);
          console.log(`📊 [HOLDER STATS] Full URL: https://deep-index.moralis.io/api/v2.2/erc20/${address}/holders?chain=${holderChain}`);
          
          const holderStatsResponse = await axios.get(
            `https://deep-index.moralis.io/api/v2.2/erc20/${address}/holders`,
            {
              params: {
                chain: holderChain
              },
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 15000
            }
          );
          
          console.log(`📊 [HOLDER STATS] Response status: ${holderStatsResponse.status}`);
          console.log(`📊 [HOLDER STATS] Response data:`, JSON.stringify(holderStatsResponse.data, null, 2));
          
          const stats = holderStatsResponse.data || {};
          
          if (!stats || Object.keys(stats).length === 0) {
            console.log(`⚠ [HOLDER STATS] Empty response for ${address}`);
            details.holderStats = null;
          } else if (!stats.totalHolders && stats.totalHolders !== 0) {
            console.log(`⚠ [HOLDER STATS] Response missing totalHolders field`);
            console.log(`   Available fields:`, Object.keys(stats));
            details.holderStats = null;
          } else {
            details.holderStats = {
              totalHolders: parseInt(stats.totalHolders) || 0,
              holdersByAcquisition: stats.holdersByAcquisition || {
                swap: 0,
                transfer: 0,
                airdrop: 0
              },
              holderChange: stats.holderChange || {},
              holderSupply: stats.holderSupply || {},
              holderDistribution: stats.holderDistribution || {}
            };
            console.log(`✓ [HOLDER STATS] Successfully fetched: ${details.holderStats.totalHolders} total holders`);
            if (details.holderStats.totalHolders > 0) {
              console.log(`   - Swap: ${details.holderStats.holdersByAcquisition.swap || 0}`);
              console.log(`   - Transfer: ${details.holderStats.holdersByAcquisition.transfer || 0}`);
              console.log(`   - Airdrop: ${details.holderStats.holdersByAcquisition.airdrop || 0}`);
            } else {
              console.log(`   ⚠ Warning: API returned totalHolders = 0`);
            }
          }
        } catch (holderStatsError) {
          console.error(`❌ [HOLDER STATS] Error fetching for ${address} on ${chain}:`, holderStatsError.message);
          if (holderStatsError.response) {
            console.error(`   Response status: ${holderStatsError.response.status}`);
            console.error(`   Response status text: ${holderStatsError.response.statusText}`);
            console.error(`   Response data:`, JSON.stringify(holderStatsError.response.data, null, 2));
            console.error(`   Request URL: ${holderStatsError.config?.url}`);
            console.error(`   Request params:`, holderStatsError.config?.params);
          }
          if (holderStatsError.request) {
            console.error(`   Request made but no response received`);
          }
          console.log(`⚠ [HOLDER STATS] Setting holderStats to null`);
          details.holderStats = null;
        }

        console.log(`✓ Fetched EVM token details`);
      } catch (error) {
        console.error(`❌ Error fetching EVM token details:`, error.message);
        return res.status(500).json({ 
          error: 'Failed to fetch token details',
          message: error.message 
        });
      }
    }

    // Add logo fallback for EVM chains if Moralis doesn't provide one
    if (chain !== 'solana' && details.metadata && !details.metadata.logo) {
      const trustWalletChainMap = {
        'bnb': 'smartchain',
        'ethereum': 'ethereum',
        'base': 'base'
      };
      const trustChain = trustWalletChainMap[chain];
      if (trustChain) {
        details.metadata.logo = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${trustChain}/assets/${address}/logo.png`;
      }
    }

    // Add explorer URLs
    details.explorerUrl = getExplorerUrl(chain, address);
    
    // DEXScreener uses different chain names
    const dexScreenerChainMap = {
      'bnb': 'bsc',        // BNB Chain is called 'bsc' on DEXScreener
      'base': 'base',
      'ethereum': 'ethereum',
      'solana': 'solana'
    };
    const dexChain = dexScreenerChainMap[chain] || chain;
    details.dexScreenerUrl = `https://dexscreener.com/${dexChain}/${address}`;

    // Cache for 2 minutes
    cache.set(cacheKey, details, 120);

    res.json(details);
  } catch (error) {
    console.error('❌ Error in token details endpoint:', error);
    res.status(500).json({ 
      error: 'Failed to fetch token details',
      message: error.message 
    });
  }
});

// Helper function to get explorer URL
function getExplorerUrl(chain, address) {
  const explorers = {
    'bnb': `https://bscscan.com/token/${address}`,
    'base': `https://basescan.org/token/${address}`,
    'ethereum': `https://etherscan.io/token/${address}`,
    'solana': `https://solscan.io/token/${address}`
  };
  return explorers[chain] || '#';
}
// Get bubble map data (holder distribution and transfer flows)
app.get('/api/bubble-map/:chain/:address', async (req, res) => {
  const { chain, address } = req.params;
  const { limit = 50 } = req.query; // Top N holders

  try {
    console.log(`🔵 Fetching bubble map data for ${address} on ${chain}...`);

    // Check cache
    const cacheKey = `bubble-map-${chain}-${address}-${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✓ Returning cached bubble map data');
      return res.json(cached);
    }

    const bubbleMapData = {
      nodes: [],
      edges: [],
      metadata: {}
    };

    // Solana bubble map
    if (chain === 'solana') {
      try {
        // Get top token holders (real data!)
        const holdersResponse = await axios.get(
          `https://solana-gateway.moralis.io/token/mainnet/${address}/top-holders`,
          {
            params: { limit: parseInt(limit) },
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 15000
          }
        );

        // Get token price for USD weights
        const priceResponse = await axios.get(
          `https://solana-gateway.moralis.io/token/mainnet/${address}/price`,
          {
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 10000
          }
        );

        const holders = holdersResponse.data?.result || [];
        const tokenPrice = parseFloat(priceResponse.data?.usdPrice || 0);
        
        // Calculate total supply from top holders
        const totalSupply = holders.reduce((sum, h) => sum + parseFloat(h.balance || 0), 0);

        console.log(`✓ Found ${holders.length} Solana top holders`);

        // Create nodes for holders
        holders.forEach((holder, index) => {
          const balance = parseFloat(holder.balance || 0);
          const percentage = totalSupply > 0 ? (balance / totalSupply) * 100 : 0;
          const usdValue = balance * tokenPrice;

          bubbleMapData.nodes.push({
            id: holder.ownerAddress || `holder-${index}`,
            label: holder.ownerAddress ? `${holder.ownerAddress.slice(0, 6)}...${holder.ownerAddress.slice(-4)}` : `Holder ${index + 1}`,
            value: percentage, // Node size
            balance: balance,
            usdValue: usdValue,
            percentage: percentage,
            rank: index + 1,
            group: identifyWalletType(holder.ownerAddress, index)
          });
        });

        bubbleMapData.metadata = {
          totalHolders: holders.length,
          totalSupply: totalSupply,
          tokenPrice: tokenPrice,
          topHolderPercentage: bubbleMapData.nodes[0]?.percentage || 0
        };

        console.log(`✓ Created real Solana holder distribution`);

      } catch (error) {
        console.error(`❌ Error fetching Solana bubble map:`, error.response?.data || error.message);
        throw new Error(`Solana holder data unavailable: ${error.message}`);
      }
    } 
    // EVM bubble map
    else {
      const launchpad = Object.values(LAUNCHPADS).find(lp => lp.chain === chain && !lp.isSolana);
      if (!launchpad) {
        return res.status(400).json({ error: 'Invalid chain' });
      }

      try {
        // Get token transfers to build holder balances
        const transfersResponse = await axios.get(
          `https://deep-index.moralis.io/api/v2.2/erc20/${address}/transfers`,
          {
            params: { 
              chain: launchpad.chainId,
              limit: 500 // Get more transfers for accurate balance calculation
            },
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 20000
          }
        );

        // Get token price
        const priceResponse = await axios.get(
          `https://deep-index.moralis.io/api/v2.2/erc20/${address}/price`,
          {
            params: { chain: launchpad.chainId },
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 10000
          }
        );

        // Get token metadata for decimals
        const metadataResponse = await axios.get(
          `https://deep-index.moralis.io/api/v2.2/erc20/metadata`,
          {
            params: {
              chain: launchpad.chainId,
              addresses: [address]
            },
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 10000
          }
        );

        const transfers = transfersResponse.data?.result || [];
        const tokenPrice = parseFloat(priceResponse.data?.usdPrice || 0);
        const decimals = parseInt(metadataResponse.data?.[0]?.decimals || 18);

        console.log(`✓ Processing ${transfers.length} EVM transfers`);

        // Build balance map from transfers
        const balances = {};
        const transferGraph = {}; // For edges: { from: { to: amount } }

        transfers.forEach(transfer => {
          const from = transfer.from_address?.toLowerCase();
          const to = transfer.to_address?.toLowerCase();
          const value = parseFloat(transfer.value) / Math.pow(10, decimals);

          // Update balances
          if (from && from !== '0x0000000000000000000000000000000000000000') {
            balances[from] = (balances[from] || 0) - value;
          }
          if (to && to !== '0x0000000000000000000000000000000000000000') {
            balances[to] = (balances[to] || 0) + value;
          }

          // Build transfer graph for edges
          if (from && to && from !== '0x0000000000000000000000000000000000000000') {
            if (!transferGraph[from]) transferGraph[from] = {};
            transferGraph[from][to] = (transferGraph[from][to] || 0) + (value * tokenPrice);
          }
        });

        // Sort holders by balance and take top N
        const topHolders = Object.entries(balances)
          .filter(([addr, balance]) => balance > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, parseInt(limit));

        const totalSupply = topHolders.reduce((sum, [_, balance]) => sum + balance, 0);

        console.log(`✓ Found ${topHolders.length} EVM holders`);

        // Create nodes
        topHolders.forEach(([holderAddress, balance], index) => {
          const percentage = totalSupply > 0 ? (balance / totalSupply) * 100 : 0;
          const usdValue = balance * tokenPrice;

          bubbleMapData.nodes.push({
            id: holderAddress,
            label: `${holderAddress.slice(0, 6)}...${holderAddress.slice(-4)}`,
            value: percentage,
            balance: balance,
            usdValue: usdValue,
            percentage: percentage,
            rank: index + 1,
            group: identifyWalletType(holderAddress, index)
          });
        });

        // Create edges between top holders based on transfer volume
        const topHolderAddresses = topHolders.map(([addr]) => addr);
        topHolderAddresses.forEach(fromAddr => {
          if (transferGraph[fromAddr]) {
            Object.entries(transferGraph[fromAddr]).forEach(([toAddr, usdAmount]) => {
              if (topHolderAddresses.includes(toAddr) && usdAmount > 0) {
                bubbleMapData.edges.push({
                  from: fromAddr,
                  to: toAddr,
                  value: usdAmount, // Edge thickness
                  label: `$${formatNumberShort(usdAmount)}`
                });
              }
            });
          }
        });

        bubbleMapData.metadata = {
          totalHolders: Object.keys(balances).filter(addr => balances[addr] > 0).length,
          totalSupply: totalSupply,
          tokenPrice: tokenPrice,
          topHolderPercentage: bubbleMapData.nodes[0]?.percentage || 0,
          transferCount: transfers.length
        };

      } catch (error) {
        console.error(`❌ Error fetching EVM bubble map:`, error.message);
        throw error;
      }
    }

    // Cache for 5 minutes
    cache.set(cacheKey, bubbleMapData, 300);

    console.log(`✓ Bubble map: ${bubbleMapData.nodes.length} nodes, ${bubbleMapData.edges.length} edges`);
    res.json(bubbleMapData);

  } catch (error) {
    console.error('❌ Error in bubble map endpoint:', error);
    res.status(500).json({ 
      error: 'Failed to fetch bubble map data',
      message: error.message 
    });
  }
});

// Helper function to identify wallet type
function identifyWalletType(address, rank) {
  if (!address) return 'unknown';
  
  const addr = address.toLowerCase();
  
  // Known CEX hot wallets (simplified)
  const cexWallets = [
    'binance', 'coinbase', 'kraken', 'okex', 'huobi', 'bitfinex',
    'gate', 'kucoin', 'bybit', 'crypto.com'
  ];
  
  // Check if it's a known CEX
  for (const cex of cexWallets) {
    if (addr.includes(cex)) {
      return 'cex';
    }
  }
  
  // Deployer (usually rank 0 or 1)
  if (rank === 0) return 'deployer';
  
  // Top 10 holders
  if (rank < 10) return 'whale';
  
  // Everyone else
  return 'holder';
}

// Helper function to format numbers with K, M, B suffix
function formatNumberShort(num) {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(2);
}

// Search tokens by address, name, or symbol
app.get('/api/search', async (req, res) => {
  const { query, chains } = req.query;

  try {
    if (!query) {
      return res.status(400).json({ error: 'Search query required' });
    }

    console.log(`🔍 Searching for: "${query}" on chains: ${chains || 'all'}`);

    // Check cache
    const cacheKey = `search-${query}-${chains || 'all'}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✓ Returning cached search results');
      return res.json(cached);
    }

    const searchResults = [];

    // Check if query is an EVM address (0x followed by 40 hex chars)
    const isEvmAddress = /^0x[a-fA-F0-9]{40}$/.test(query);

    if (isEvmAddress) {
      console.log('🔍 Detected EVM address, searching across all EVM chains...');
      
      // Search each EVM chain for this address
      const evmChains = [
        { name: 'bnb', moralisChain: 'bsc', searchChain: 'binance' },
        { name: 'base', moralisChain: 'base', searchChain: 'base' },
        { name: 'ethereum', moralisChain: 'eth', searchChain: 'ethereum' }
      ];

      for (const chain of evmChains) {
        try {
          console.log(`  🔍 Checking ${chain.name}...`);
          
          // Get token metadata
          const metadataResponse = await axios.get(
            'https://deep-index.moralis.io/api/v2.2/erc20/metadata',
            {
              params: {
                chain: chain.moralisChain,
                addresses: [query]
              },
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 10000
            }
          );

          if (metadataResponse.data && metadataResponse.data.length > 0) {
            const token = metadataResponse.data[0];
            
            // Verify token actually exists (has name and symbol)
            if (!token.name || !token.symbol || token.name === '' || token.symbol === '') {
              console.log(`  ⚠ Invalid token data on ${chain.name}, skipping`);
              continue;
            }
            
            // Verify the address matches (case-insensitive)
            if (token.address.toLowerCase() !== query.toLowerCase()) {
              console.log(`  ⚠ Address mismatch on ${chain.name}, skipping`);
              continue;
            }
            
            console.log(`  ✓ Found on ${chain.name}: ${token.name} (${token.symbol})`);

            // Fetch comprehensive token data in parallel
            const [priceResponse, holderStatsResponse, tokenPairsResponse, discoveryResponse] = await Promise.allSettled([
              // Get token price
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/erc20/${query}/price`,
                {
                  params: { chain: chain.moralisChain },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 10000
                }
              ),
              // Get holder stats
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/erc20/${query}/holders`,
                {
                  params: { chain: chain.moralisChain },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 10000
                }
              ),
              // Get token pairs (volume and liquidity)
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/erc20/${query}/pairs`,
                {
                  params: { chain: chain.moralisChain, limit: 25 },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 10000
                }
              ),
              // Get comprehensive token discovery data
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/discovery/token`,
                {
                  params: { 
                    chain: chain.moralisChain,
                    address: query
                  },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 10000
                }
              )
            ]);

            // Extract price data
            let price = 0;
            let priceChange = 0;
            if (priceResponse.status === 'fulfilled') {
              price = parseFloat(priceResponse.value.data?.usdPrice || 0);
              priceChange = parseFloat(priceResponse.value.data?.['24hrPercentChange'] || 0);
            }

            // Extract holder stats
            let holders = 0;
            if (holderStatsResponse.status === 'fulfilled') {
              holders = parseInt(holderStatsResponse.value.data?.totalHolders || 0);
            }

            // Extract volume and liquidity from pairs
            let liquidity = 0;
            let volume24h = 0;
            if (tokenPairsResponse.status === 'fulfilled') {
              const pairs = tokenPairsResponse.value.data?.pairs || [];
              pairs.forEach(pair => {
                liquidity += parseFloat(pair.liquidity_usd || 0);
                volume24h += parseFloat(pair.volume_24h || 0);
              });
            }

            // Extract market cap and other data from discovery API
            let marketCap = 0;
            let createdAt = token.block_timestamp || new Date().toISOString();
            if (discoveryResponse.status === 'fulfilled') {
              const discoveryData = discoveryResponse.value.data;
              marketCap = parseFloat(discoveryData?.market_cap || discoveryData?.usdMarketCap || 0);
              // Try to get better creation date from discovery API
              if (discoveryData?.block_timestamp || discoveryData?.token_block_timestamp) {
                createdAt = discoveryData.block_timestamp || discoveryData.token_block_timestamp;
              }
            }

            // Fallback market cap calculation if discovery API didn't provide it
            if (marketCap === 0 && price > 0) {
              // Use price * supply estimate (if available from metadata)
              const totalSupply = parseFloat(token.total_supply || 0);
              if (totalSupply > 0) {
                const decimals = parseInt(token.decimals) || 18;
                marketCap = (totalSupply / Math.pow(10, decimals)) * price;
              }
            }

            // Try to get logo from multiple sources
            let logoUrl = token.logo || token.logoURI;
            if (!logoUrl) {
              // Fallback to TrustWallet asset repository
              const trustWalletChainMap = {
                'bnb': 'smartchain',
                'ethereum': 'ethereum',
                'base': 'base'
              };
              const trustChain = trustWalletChainMap[chain.name];
              if (trustChain) {
                logoUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${trustChain}/assets/${token.address}/logo.png`;
              }
            }

            searchResults.push({
              chain: chain.name,
              address: token.address,
              name: token.name,
              symbol: token.symbol,
              decimals: parseInt(token.decimals) || 18,
              logo: logoUrl,
              price: price,
              priceChange24h: priceChange,
              marketCap: marketCap,
              liquidity: liquidity,
              volume24h: volume24h,
              holders: holders,
              verified: token.isVerifiedContract !== undefined ? token.isVerifiedContract : true,
              createdAt: createdAt,
              launchpad: 'Direct Address'
            });
          } else {
            console.log(`  ⚠ No metadata returned for ${chain.name}`);
          }
        } catch (chainError) {
          // Token doesn't exist on this chain, continue to next
          console.log(`  ⚠ Not found on ${chain.name}:`, chainError.response?.status || chainError.message);
        }
      }
    } else {
      // Search by name/symbol using token search API
      console.log('🔍 Searching by name/symbol across EVM chains...');
      
      // Moralis API chain names EXACTLY: eth (not ethereum), binance (not bsc), base
      const chainsToSearch = chains ? chains.split(',') : ['eth', 'binance', 'base'];

      try {
        console.log(`  Using chains: ${chainsToSearch.join(',')}`);
        
        const response = await axios.get(
          'https://deep-index.moralis.io/api/v2.2/tokens/search',
          {
            params: {
              query: query,
              chains: chainsToSearch.join(','),
              limit: 25,
              isVerifiedContract: true,
              boostVerifiedContracts: true
            },
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 15000
          }
        );

        console.log(`✓ Token search returned ${response.data?.result?.length || 0} results`);
        console.log(`  Total: ${response.data?.total || 0}`);

        if (response.data?.result && Array.isArray(response.data.result)) {
          // Process all tokens in parallel for better performance
          const tokenPromises = response.data.result.map(async (token) => {
            // Determine chain name from chainId
            let chainName = 'ethereum';
            let moralisChain = 'eth';
            if (token.chainId === '0x38') {
              chainName = 'bnb';
              moralisChain = 'bsc';
            } else if (token.chainId === '0x2105') {
              chainName = 'base';
              moralisChain = 'base';
            } else if (token.chainId === '0x1') {
              chainName = 'ethereum';
              moralisChain = 'eth';
            }

            console.log(`    Found: ${token.name} (${token.symbol}) on ${chainName} - $${token.usdPrice || 0}`);

            // Fetch comprehensive data in parallel
            const [holderStatsResponse, tokenPairsResponse, discoveryResponse] = await Promise.allSettled([
              // Get holder stats
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/erc20/${token.tokenAddress}/holders`,
                {
                  params: { chain: moralisChain },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 10000
                }
              ),
              // Get token pairs (volume and liquidity)
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/erc20/${token.tokenAddress}/pairs`,
                {
                  params: { chain: moralisChain, limit: 25 },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 10000
                }
              ),
              // Get comprehensive token discovery data
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/discovery/token`,
                {
                  params: { 
                    chain: moralisChain,
                    address: token.tokenAddress
                  },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 10000
                }
              )
            ]);

            // Extract holder stats
            let holders = 0;
            if (holderStatsResponse.status === 'fulfilled') {
              holders = parseInt(holderStatsResponse.value.data?.totalHolders || 0);
            }

            // Extract volume and liquidity from pairs
            let liquidity = 0;
            let volume24h = 0;
            if (tokenPairsResponse.status === 'fulfilled') {
              const pairs = tokenPairsResponse.value.data?.pairs || [];
              pairs.forEach(pair => {
                liquidity += parseFloat(pair.liquidity_usd || 0);
                volume24h += parseFloat(pair.volume_24h || 0);
              });
            }

            // Extract market cap and creation date from discovery API
            let marketCap = parseFloat(token.marketcap || 0);
            let createdAt = token.blockTimestamp || new Date().toISOString();
            let priceChange24h = parseFloat(token.pricePercentChange?.['24h'] || token.pricePercentChange?.['24hr'] || 0);
            
            if (discoveryResponse.status === 'fulfilled') {
              const discoveryData = discoveryResponse.value.data;
              if (discoveryData?.market_cap || discoveryData?.usdMarketCap) {
                marketCap = parseFloat(discoveryData.market_cap || discoveryData.usdMarketCap || 0);
              }
              if (discoveryData?.block_timestamp || discoveryData?.token_block_timestamp) {
                createdAt = discoveryData.block_timestamp || discoveryData.token_block_timestamp;
              }
              if (discoveryData?.priceChange24h !== undefined) {
                priceChange24h = parseFloat(discoveryData.priceChange24h);
              }
            }

            // Try to get logo from multiple sources
            let logoUrl = token.logo || token.logoURI;
            if (!logoUrl) {
              // Fallback to TrustWallet asset repository
              const trustWalletChainMap = {
                'bnb': 'smartchain',
                'ethereum': 'ethereum',
                'base': 'base'
              };
              const trustChain = trustWalletChainMap[chainName];
              if (trustChain) {
                logoUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${trustChain}/assets/${token.tokenAddress}/logo.png`;
              }
            }

            return {
              chain: chainName,
              address: token.tokenAddress,
              name: token.name || 'Unknown Token',
              symbol: token.symbol || 'UNKNOWN',
              decimals: parseInt(token.decimals) || 18,
              logo: logoUrl,
              price: parseFloat(token.usdPrice || 0),
              priceChange24h: priceChange24h,
              marketCap: marketCap,
              liquidity: liquidity,
              volume24h: volume24h,
              holders: holders,
              verified: token.isVerifiedContract || false,
              createdAt: createdAt,
              launchpad: 'Search Result'
            };
          });

          const tokenResults = await Promise.allSettled(tokenPromises);
          searchResults.push(...tokenResults.filter(r => r.status === 'fulfilled').map(r => r.value));
        }
      } catch (evmError) {
        console.error('Error searching EVM chains:', evmError.message);
        console.error('Error details:', evmError.response?.data || evmError.message);
      }
    }

    // Search Solana if query looks like a Solana address (base58, ~44 chars)
    if (query.length > 30 && query.length < 50 && !query.startsWith('0x')) {
      try {
        console.log('🔍 Searching Solana...');
        
        // Fetch comprehensive Solana data in parallel
        const [metadataResponse, priceResponse, analyticsResponse, holderStatsResponse] = await Promise.allSettled([
          // Get metadata
          axios.get(
            `https://solana-gateway.moralis.io/token/mainnet/${query}/metadata`,
            {
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 10000
            }
          ),
          // Get price
          axios.get(
            `https://solana-gateway.moralis.io/token/mainnet/${query}/price`,
            {
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 10000
            }
          ),
          // Get analytics for 24h price change
          axios.get(
            `https://deep-index.moralis.io/api/v2.2/tokens/${query}/analytics`,
            {
              params: { chain: 'solana' },
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 10000
            }
          ),
          // Get holder stats
          axios.get(
            `https://solana-gateway.moralis.io/token/mainnet/holders/${query}`,
            {
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 10000
            }
          )
        ]);

        if (metadataResponse.status === 'fulfilled' && metadataResponse.value.data) {
          const metadata = metadataResponse.value.data;
          
          // Extract price
          let price = 0;
          let marketCap = 0;
          let liquidity = 0;
          if (priceResponse.status === 'fulfilled') {
            const priceData = priceResponse.value.data;
            price = parseFloat(priceData?.usdPrice || 0);
            marketCap = parseFloat(priceData?.usdMarketCap || 0);
            liquidity = parseFloat(priceData?.liquidity || 0);
          }

          // Extract 24h price change (prioritize analytics API)
          let priceChange24h = 0;
          if (analyticsResponse.status === 'fulfilled') {
            const analytics = analyticsResponse.value.data;
            if (analytics?.pricePercentChange?.['24h'] !== undefined) {
              priceChange24h = parseFloat(analytics.pricePercentChange['24h']);
            } else if (analytics?.pricePercentChange?.['24hr'] !== undefined) {
              priceChange24h = parseFloat(analytics.pricePercentChange['24hr']);
            }
          }
          // Fallback to price endpoint
          if (priceChange24h === 0 && priceResponse.status === 'fulfilled') {
            const priceData = priceResponse.value.data;
            priceChange24h = parseFloat(
              priceData?.['24hrPercentChange'] || 
              priceData?.usdPriceChange24h || 
              priceData?.priceChange24h || 
              0
            );
          }

          // Extract holder count
          let holders = 0;
          if (holderStatsResponse.status === 'fulfilled') {
            holders = parseInt(holderStatsResponse.value.data?.totalHolders || 0);
          }

          searchResults.push({
            chain: 'solana',
            address: query,
            name: metadata.name || 'Solana Token',
            symbol: metadata.symbol || 'SOL',
            decimals: metadata.decimals || 9,
            logo: metadata.logo || null,
            price: price,
            priceChange24h: priceChange24h,
            marketCap: marketCap,
            liquidity: liquidity,
            holders: holders,
            verified: false,
            createdAt: new Date().toISOString()
          });
          console.log(`✓ Found Solana token: ${metadata.name} (${metadata.symbol}) - ${holders} holders, $${price}`);
        }
      } catch (solanaError) {
        console.log('⚠ Solana search: no results', solanaError.message);
      }
    }

    const result = {
      query,
      total: searchResults.length,
      results: searchResults
    };

    // Cache results for 5 minutes
    cache.set(cacheKey, result);

    res.json(result);
  } catch (error) {
    console.error('❌ Search error:', error);
    res.status(500).json({ 
      error: 'Search failed', 
      message: error.message 
    });
  }
});

// Get specific token details
app.get('/api/token/:chain/:address', async (req, res) => {
  const { chain, address } = req.params;

  try {
    const chainConfig = CHAINS[chain];
    if (!chainConfig) {
      return res.status(400).json({ error: 'Invalid chain' });
    }

    const cacheKey = `token-${chain}-${address}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log(`✓ Returning cached token details for ${address}`);
      return res.json(cached);
    }

    console.log(`📡 Fetching details for token ${address} on ${chain}...`);
    let tokenData = {};

    if (chain === 'solana') {
      // Fetch Solana token data using correct Moralis endpoint
      try {
        const metadataResponse = await axios.get(
          `https://solana-gateway.moralis.io/token/mainnet/${address}/metadata`,
          {
            headers: { 
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 10000
          }
        );

        const metadata = metadataResponse.data;

        tokenData = {
          chain,
          address,
          name: metadata?.name || 'Unknown Solana Token',
          symbol: metadata?.symbol || 'UNKNOWN',
          decimals: metadata?.decimals || 9,
          logo: metadata?.logo || null,
          price: 0,
          priceChange24h: 0,
          marketCap: 0,
          holders: 0
        };

        console.log(`✓ Fetched Solana token: ${metadata?.name} (${metadata?.symbol})`);
      } catch (error) {
        console.error('Error fetching Solana token:', error.message);
        tokenData = {
          chain,
          address,
          name: 'Unknown Solana Token',
          symbol: 'UNKNOWN',
          decimals: 9,
          logo: null,
          price: 0,
          priceChange24h: 0,
          marketCap: 0,
          holders: 0
        };
      }
    } else {
      // Fetch EVM token data
      try {
        // Get metadata
        const metadataResponse = await axios.get(
          `https://deep-index.moralis.io/api/v2.2/erc20/metadata`,
          {
            params: { 
              chain: chainConfig.id, 
              addresses: [address]
            },
            headers: { 
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 10000
          }
        );

        const metadata = Array.isArray(metadataResponse.data) ? metadataResponse.data[0] : metadataResponse.data;

        // Get price data
        let priceData = {};
        try {
          const priceResponse = await axios.get(
            `https://deep-index.moralis.io/api/v2.2/erc20/${address}/price`,
            {
              params: { chain: chainConfig.id },
              headers: { 
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 10000
            }
          );
          priceData = priceResponse.data;
        } catch (priceError) {
          console.log(`⚠ Could not fetch price data:`, priceError.message);
        }

        tokenData = {
          chain,
          address,
          name: metadata?.name || 'Unknown Token',
          symbol: metadata?.symbol || 'UNKNOWN',
          decimals: metadata?.decimals || 18,
          logo: metadata?.logo || metadata?.thumbnail || null,
          price: priceData?.usdPrice || 0,
          priceChange24h: priceData?.['24hrPercentChange'] || 0,
          marketCap: priceData?.usdPrice ? parseFloat(priceData.usdPrice) * 1000000000 : 0,
          holders: 0
        };

        console.log(`✓ Fetched token: ${tokenData.name} (${tokenData.symbol})`);
      } catch (error) {
        console.error('Error fetching EVM token:', error.response?.data || error.message);
        tokenData = {
          chain,
          address,
          name: 'Unknown Token',
          symbol: 'UNKNOWN',
          decimals: 18,
          logo: null,
          price: 0,
          priceChange24h: 0,
          marketCap: 0,
          holders: 0
        };
      }
    }

    cache.set(cacheKey, tokenData);
    res.json(tokenData);
  } catch (error) {
    console.error('❌ Error fetching token details:', error);
    res.status(500).json({ 
      error: 'Failed to fetch token details',
      message: error.message 
    });
  }
});

// Clear cache endpoint (for debugging)
app.post('/api/cache/clear', (req, res) => {
  try {
    cache.flushAll();
    console.log('✓ Cache cleared successfully');
    res.json({ 
      success: true, 
      message: 'Cache cleared successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error clearing cache:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Debug endpoint to test analytics API directly
app.get('/api/debug/analytics/:address', async (req, res) => {
  const { address } = req.params;
  
  try {
    console.log(`🔍 DEBUG: Testing analytics API for ${address}`);
    
    const response = await axios.get(
      `https://deep-index.moralis.io/api/v2.2/tokens/${address}/analytics`,
      {
        params: { chain: 'solana' },
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 10000
      }
    );
    
    console.log(`✓ Analytics API response:`, JSON.stringify(response.data, null, 2));
    
    res.json({
      success: true,
      address,
      analytics: response.data,
      pricePercentChange24h: response.data?.pricePercentChange?.['24h'] || null
    });
    
  } catch (error) {
    console.error(`❌ Analytics API error:`, error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      response: error.response?.data || null
    });
  }
});
// Get Trending Tokens
app.get('/api/tokens/trending', async (req, res) => {
  const { chain, limit = 25 } = req.query;

  try {
    if (!chain) {
      return res.status(400).json({ error: 'Chain parameter is required' });
    }

    console.log(`📈 Fetching trending tokens for chain: ${chain}`);

    // Map chain names to Moralis chain IDs
    const chainMap = {
      'solana': 'solana',
      'bnb': '0x38',
      'base': '0x2105',
      'ethereum': '0x1'
    };

    const moralisChain = chainMap[chain.toLowerCase()];
    if (!moralisChain) {
      return res.status(400).json({ error: `Unsupported chain: ${chain}` });
    }

    // Check cache
    const cacheKey = `trending-${chain}-${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✓ Returning cached trending tokens');
      return res.json(cached);
    }

    // Call Moralis Trending Tokens API
    const response = await axios.get(
      'https://deep-index.moralis.io/api/v2.2/tokens/trending',
      {
        params: {
          chain: moralisChain,
          limit: parseInt(limit)
        },
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 15000
      }
    );

    const trendingTokens = [];
    
    if (Array.isArray(response.data)) {
      console.log(`  📊 Found ${response.data.length} trending tokens`);
      
      // Fetch all price data in parallel for better performance
      const pricePromises = response.data.map(async (token) => {
        // Determine chain name
        let chainName = chain.toLowerCase();
        if (token.chainId === '0x38') chainName = 'bnb';
        else if (token.chainId === '0x2105') chainName = 'base';
        else if (token.chainId === '0x1') chainName = 'ethereum';
        else if (token.chainId === 'solana') chainName = 'solana';

        // Fetch price and market data for each token
        let priceData = {
          usdPrice: 0,
          priceChange24h: 0,
          marketCap: 0
        };
        
        try {
          if (chainName === 'solana') {
            // Fetch both price and analytics in parallel for Solana
            const [priceResponse, analyticsResponse] = await Promise.allSettled([
              axios.get(
                `https://solana-gateway.moralis.io/token/mainnet/${token.tokenAddress}/price`,
                {
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 5000
                }
              ),
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/tokens/${token.tokenAddress}/analytics`,
                {
                  params: { chain: 'solana' },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 5000
                }
              )
            ]);
            
            let priceChange = 0;
            
            // ALWAYS prioritize analytics API - it has the most reliable price percentage data
            if (analyticsResponse.status === 'fulfilled') {
              const analytics = analyticsResponse.value.data;
              console.log(`  📊 Analytics for trending ${token.symbol}:`, JSON.stringify(analytics, null, 2));
              
              // Analytics API returns pricePercentChange.24h for 24-hour change
              if (analytics.pricePercentChange && analytics.pricePercentChange['24h'] !== undefined) {
                priceChange = parseFloat(analytics.pricePercentChange['24h']);
                console.log(`    ✓ Found pricePercentChange.24h: ${priceChange}%`);
              } else if (analytics.pricePercentChange && analytics.pricePercentChange['24hr'] !== undefined) {
                priceChange = parseFloat(analytics.pricePercentChange['24hr']);
                console.log(`    ✓ Found pricePercentChange.24hr: ${priceChange}%`);
              } else {
                console.log(`    ⚠ Analytics response missing pricePercentChange.24h`);
              }
            } else {
              console.log(`    ⚠ Analytics API call failed:`, analyticsResponse.reason?.message || 'Unknown error');
            }
            
            // Fallback to price endpoint only if analytics didn't provide data
            if (priceChange === 0 && priceResponse.status === 'fulfilled') {
              const priceResponseData = priceResponse.value.data;
              priceChange = parseFloat(
                priceResponseData?.['24hrPercentChange'] || 
                priceResponseData?.usdPriceChange24h || 
                priceResponseData?.priceChange24h ||
                priceResponseData?.price24hChange ||
                0
              );
              if (priceChange !== 0) {
                console.log(`    ✓ Got priceChange from price endpoint: ${priceChange}%`);
              }
            }
            
            if (priceResponse.status === 'fulfilled') {
              const priceResponseData = priceResponse.value.data;
              console.log(`  🔍 Solana price data for ${token.symbol}:`, JSON.stringify(priceResponseData, null, 2));
              
              priceData = {
                usdPrice: parseFloat(priceResponseData?.usdPrice || 0),
                priceChange24h: priceChange || parseFloat(priceResponseData?.['24hrPercentChange'] || priceResponseData?.usdPriceChange24h || 0),
                marketCap: parseFloat(priceResponseData?.usdMarketCap || 0)
              };
            } else {
              priceData = {
                usdPrice: 0,
                priceChange24h: priceChange,
                marketCap: 0
              };
            }
          } else {
            // Fetch price data
            const priceResponse = await axios.get(
              `https://deep-index.moralis.io/api/v2.2/erc20/${token.tokenAddress}/price?chain=${moralisChain}`,
              {
                headers: {
                  'X-API-Key': CONFIG.moralisApiKey,
                  'accept': 'application/json'
                },
                timeout: 5000
              }
            );
            
            const data = priceResponse.data;
            let marketCap = parseFloat(data?.usdMarketCap || 0);
            
            // If market cap not provided, try to calculate from fully diluted valuation
            if (marketCap === 0 && data?.tokenAddress) {
              // Fetch metadata for total supply
              try {
                const metadataResponse = await axios.get(
                  `https://deep-index.moralis.io/api/v2.2/erc20/metadata`,
                  {
                    params: {
                      chain: moralisChain,
                      addresses: [token.tokenAddress]
                    },
                    headers: {
                      'X-API-Key': CONFIG.moralisApiKey,
                      'accept': 'application/json'
                    },
                    timeout: 3000
                  }
                );
                
                const metadata = metadataResponse.data?.[0];
                if (metadata?.total_supply && data.usdPrice) {
                  // Calculate market cap from total supply * price
                  const totalSupply = parseFloat(metadata.total_supply) / Math.pow(10, parseInt(metadata.decimals || 18));
                  marketCap = totalSupply * parseFloat(data.usdPrice);
                }
              } catch (metaError) {
                console.log(`  ⚠️ Could not fetch metadata for ${token.symbol}`);
              }
            }
            
            priceData = {
              usdPrice: parseFloat(data?.usdPrice || 0),
              priceChange24h: parseFloat(data?.['24hrPercentChange'] || 0),
              marketCap: marketCap
            };
            
            console.log(`  💰 ${token.symbol}: $${priceData.usdPrice.toFixed(6)} (${priceData.priceChange24h >= 0 ? '+' : ''}${priceData.priceChange24h.toFixed(2)}%) MC: $${(priceData.marketCap / 1000000).toFixed(2)}M`);
          }
        } catch (priceError) {
          console.log(`⚠️ Could not fetch price for ${token.tokenAddress}`);
        }

        // Fetch holder stats for EVM chains
        let holders = 0;
        if (chainName !== 'solana' && token.tokenAddress) {
          try {
            // Map chain to Moralis format for holder stats API
            const holderChainMap = {
              'bnb': 'bsc',
              'base': 'base',
              'ethereum': 'eth',
              'eth': 'eth'
            };
            const holderChain = holderChainMap[chainName] || chainName;
            
            const holderStatsResponse = await axios.get(
              `https://deep-index.moralis.io/api/v2.2/erc20/${token.tokenAddress}/holders`,
              {
                params: {
                  chain: holderChain
                },
                headers: {
                  'X-API-Key': CONFIG.moralisApiKey,
                  'accept': 'application/json'
                },
                timeout: 5000
              }
            );
            
            holders = holderStatsResponse.data?.totalHolders || 0;
            if (holders > 0) {
              console.log(`  ✓ ${token.symbol}: ${holders} holders`);
            }
          } catch (holderError) {
            // If holder stats fail, use default (0) - don't block token from being returned
            console.log(`  ⚠ Could not fetch holders for ${token.symbol}:`, holderError.response?.status || holderError.message);
          }
        }

        // Try to get logo from multiple sources
        let logoUrl = token.logo;
        if (!logoUrl && chainName !== 'solana') {
          // Fallback to TrustWallet asset repository for EVM chains
          const trustWalletChainMap = {
            'bnb': 'smartchain',
            'ethereum': 'ethereum',
            'base': 'base'
          };
          const trustChain = trustWalletChainMap[chainName];
          if (trustChain) {
            logoUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${trustChain}/assets/${token.tokenAddress}/logo.png`;
          }
        }

        return {
          chain: chainName,
          address: token.tokenAddress,
          name: token.name || 'Unknown Token',
          symbol: token.symbol || 'UNKNOWN',
          decimals: parseInt(token.decimals) || (chainName === 'solana' ? 9 : 18),
          logo: logoUrl,
          price: priceData.usdPrice,
          priceChange24h: priceData.priceChange24h,
          marketCap: priceData.marketCap,
          liquidity: 0,
          holders: holders,
          verified: token.isVerifiedContract || false,
          createdAt: new Date().toISOString(),
          launchpad: 'Trending'
        };
      });
      
      // Wait for all price fetches to complete in parallel
      const tokenDataArray = await Promise.all(pricePromises);
      trendingTokens.push(...tokenDataArray);
    }

    console.log(`✓ Found ${trendingTokens.length} trending tokens with price data`);

    // Cache for 10 minutes (trending tokens don't change that fast)
    cache.set(cacheKey, trendingTokens, 600);

    res.json(trendingTokens);

  } catch (error) {
    console.error('❌ Error fetching trending tokens:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch trending tokens',
      message: error.message
    });
  }
});

// AI Analysis endpoint (subscription-gated)
app.post('/api/analyze', async (req, res) => {
  try {
    const { tokenData, chain, address } = req.body;

    if (!tokenData) {
      return res.status(400).json({ error: 'Token data required' });
    }

    const isPreview = req.headers['x-preview'] === 'true' || req.body.preview === true;
    let subscriptionStatus = null;
    let userId = null;

    if (!isPreview) {
      // Open-source: Authentication optional, no subscription required
      // Users provide their own API keys
    });
      }

      // Open-source: No CU checks);
      }
    }

    const { analysis, llmUsed, comprehensiveData } = await performTokenAnalysis({
      tokenData,
      chain,
      address,
      isPreview
    });

    // Save analysis to user's saved analyses (if user is authenticated)
    if (req.isAuthenticated && req.isAuthenticated()) {
      try {
        const userId = req.user.id;
        const users = await loadUsers();
        const userIndex = users.findIndex(u => u.id === userId);
        
        if (userIndex >= 0) {
          // Initialize savedAnalyses if it doesn't exist
          if (!users[userIndex].savedAnalyses) {
            users[userIndex].savedAnalyses = [];
          }
          
          // Create saved analysis entry
          const savedAnalysis = {
            tokenData: {
              name: tokenData.name || comprehensiveData.name || 'Unknown Token',
              symbol: tokenData.symbol || comprehensiveData.symbol || 'UNKNOWN',
              address: tokenData.address || address,
              chain: tokenData.chain || chain,
              logo: tokenData.logo || comprehensiveData.logo || null,
              price: tokenData.price || comprehensiveData.price || 0,
              marketCap: tokenData.marketCap || comprehensiveData.marketCap || 0,
              holders: tokenData.holders || comprehensiveData.holders || 0,
              volume24h: tokenData.volume24h || comprehensiveData.volume24h || 0,
              liquidity: tokenData.liquidity || comprehensiveData.liquidity || 0
            },
            analysis: analysis,
            llmUsed: llmUsed,
            createdAt: new Date().toISOString(),
            isPreview: isPreview,
            chain: chain || tokenData.chain,
            address: address || tokenData.address
          };
          
          // Add to saved analyses (prepend so newest is first)
          users[userIndex].savedAnalyses.unshift(savedAnalysis);
          
          // Keep only last 50 analyses to prevent database bloat
          if (users[userIndex].savedAnalyses.length > 50) {
            users[userIndex].savedAnalyses = users[userIndex].savedAnalyses.slice(0, 50);
          }
          
          await saveUsers(users);
          console.log(`💾 Saved analysis for user ${userId} (${isPreview ? 'preview' : 'paid'})`);
        }
      } catch (saveError) {
        console.error('⚠️ Error saving analysis:', saveError.message);
        // Don't fail the request if saving fails
      }
    }
    
    let usageRecord = null;
    if (!isPreview && userId) {
      try {
        usageRecord = await subscriptionService.consumeComputeUnits(userId, ANALYSIS_CU_COST, {
          source: 'web-analysis',
          chain: chain || tokenData.chain || comprehensiveData.chain || null,
          contractAddress: address || tokenData.address || comprehensiveData.address || null,
          llmUsed
        });
      } catch (usageError) {
        console.error('⚠️ Failed to record subscription usage:', usageError);
      }
    }
    
    res.json({
      success: true,
      analysis,
      llmUsed,
      timestamp: new Date().toISOString(),
      subscription: usageRecord
        ? {
            remainingCu: usageRecord.remaining,
            usageId: usageRecord.usage.id,
            plan: usageRecord.plan ? {
              id: usageRecord.plan.id,
              name: usageRecord.plan.name,
              monthlyCu: usageRecord.plan.monthlyCu,
              monthlyPriceUsd: usageRecord.plan.monthlyPriceUsd
            } : null
          }
        : subscriptionStatus
        ? {
            remainingCu: subscriptionStatus.cuBalance,
            planId: subscriptionStatus.planId,
            planName: subscriptionStatus.planName
          }
        : null
    });
  } catch (error) {
    console.error('Error in /api/analyze:', error);
    res.status(500).json({ error: 'Analysis failed', message: error.message });
  }
});

// SDK AI Analysis endpoint (API key required)
app.post('/api/sdk/analyze', async (req, res) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'] || req.headers['x-api-key'.toLowerCase()];
    let apiKey = apiKeyHeader;

    if (!apiKey && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        apiKey = authHeader.slice(7).trim();
      }
    }

    if (!apiKey) {
      return res.status(401).json({
        error: 'api_key_required',
        message: 'Provide your API key in the X-API-Key header or Authorization bearer token.'
      });
    }

    const verification = await subscriptionService.verifyApiKey(apiKey);
    if (!verification) {
      return res.status(401).json({
        error: 'invalid_api_key',
        message: 'The provided API key is invalid or has been revoked.'
      });
    }

    const { user, keyRecord } = verification;
    const { tokenData, chain, address } = req.body || {};

    if (!tokenData) {
      return res.status(400).json({ error: 'Token data required' });
    }

    const subscriptionStatus = await subscriptionService.getSubscriptionStatus(user.id);
    if (!subscriptionStatus || subscriptionStatus.status !== 'active' || !subscriptionStatus.planId) {
      return res.status(402).json({
        error: 'subscription_required',
        message: 'Active subscription required to access the SDK endpoint.',
        plans: subscriptionService.getPlans()
      });
    }

    // Open-source: No CU checks);
    }

    const { analysis, llmUsed, comprehensiveData } = await performTokenAnalysis({
      tokenData,
      chain,
      address,
      isPreview: false
    });

    let usageRecord = null;
    try {
      usageRecord = await subscriptionService.consumeComputeUnits(user.id, ANALYSIS_CU_COST, {
        source: 'sdk',
        chain: chain || tokenData.chain || comprehensiveData.chain || null,
        contractAddress: address || tokenData.address || comprehensiveData.address || null,
        apiKeyId: keyRecord.id,
        llmUsed
      });
    } catch (usageError) {
      console.error('⚠️ Failed to record SDK subscription usage:', usageError);
    }

    res.json({
      success: true,
      analysis,
      llmUsed,
      timestamp: new Date().toISOString(),
      subscription: usageRecord
        ? {
            remainingCu: usageRecord.remaining,
            usageId: usageRecord.usage.id,
            plan: usageRecord.plan ? {
              id: usageRecord.plan.id,
              name: usageRecord.plan.name,
              monthlyCu: usageRecord.plan.monthlyCu,
              monthlyPriceUsd: usageRecord.plan.monthlyPriceUsd
            } : null
          }
        : {
            remainingCu: Math.max(0, (subscriptionStatus.cuBalance || 0) - ANALYSIS_CU_COST),
            planId: subscriptionStatus.planId,
            planName: subscriptionStatus.planName
          }
    });
  } catch (error) {
    console.error('Error in /api/sdk/analyze:', error);
    res.status(500).json({ error: 'Analysis failed', message: error.message });
  }
});

// ===== AI Trading Assistant Endpoint =====

const AI_CHAT_INSTRUCTIONS = `You are an expert crypto trading assistant specializing in token analysis, market trends, and trading strategies. You have access to blockchain insights through Moralis AI and can analyze tokens across multiple blockchains (Solana, BNB Chain, Base, Ethereum) from popular launchpads like Pump.fun, PancakeSwap, Aerodrome, and Uniswap.

IMPORTANT - FREE RESPONSE LIMITATIONS:
- This is a FREE chat response - you can only provide 1-2 key data points or brief answers
- Do NOT provide comprehensive analysis, detailed risk assessments, or extensive trading strategies
- For comprehensive AI analysis with all available data, users must purchase AI Analysis (0.30 USDC)
- Keep responses brief and focused - mention only the most relevant metric or answer the specific question concisely
- If asked for detailed analysis, politely suggest purchasing AI Analysis for comprehensive insights

Your responsibilities (within free limits):
- Answer simple questions about tokens, chains, or basic concepts
- Provide 1-2 key metrics if asked (e.g., current price, market cap, or volume)
- Give brief explanations of blockchain concepts
- Direct users to purchase AI Analysis for comprehensive analysis

Always be helpful, accurate, and transparent about limitations of free responses.`;

const AI_CHAT_INSTRUCTIONS_PRO = `You are an expert crypto trading assistant with PRO access, specializing in comprehensive token analysis, market trends, and advanced trading strategies. You have full access to blockchain insights through Moralis AI, Grok Twitter/X sentiment analysis, and Gemini AI, enabling you to analyze tokens across multiple blockchains (Solana, BNB Chain, Base, Ethereum) from popular launchpads like Pump.fun, PancakeSwap, Aerodrome, and Uniswap.

PRO ACCESS CAPABILITIES:
- Provide comprehensive, detailed analysis with no limitations
- Include full risk assessments, trading strategies, and market insights
- Integrate real-time Twitter/X sentiment analysis via Grok
- Use advanced AI models (Moralis Grok, Gemini) for multi-perspective analysis
- Deliver in-depth token research, holder analysis, and liquidity assessments
- Provide actionable trading recommendations with entry/exit strategies

Your responsibilities (PRO mode):
- Deliver complete, detailed analysis for any token or market question
- Integrate Grok Twitter insights when analyzing specific tokens
- Provide comprehensive risk assessments and trading strategies
- Use multiple AI perspectives (Moralis + Gemini) for well-rounded analysis
- Include technical analysis, fundamental analysis, and sentiment analysis
- Offer actionable trading recommendations with clear reasoning

Always provide thorough, professional analysis that helps users make informed trading decisions.`;

function buildMoralisConversation(history, message, isPro = false) {
  const instructions = isPro ? AI_CHAT_INSTRUCTIONS_PRO : AI_CHAT_INSTRUCTIONS;
  let conversationContext = `${instructions}\n\n`;

  if (history.length > 0) {
    conversationContext += 'Previous conversation:\n';
    history.forEach(msg => {
      conversationContext += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
    });
    conversationContext += '\n';
  }

  conversationContext += `User: ${message}\n\nAssistant:`;
  return conversationContext;
}
async function callMoralisChat(conversationContext) {
    console.log('📤 Sending request to Moralis Chat API...');
    console.log('   URL: https://cortex-api.moralis.io/chat');
    console.log('   API Key present:', !!CONFIG.moralisApiKey);
    console.log('   Prompt length:', conversationContext.length);
    
    const moralisResponse = await axios.post(
      'https://cortex-api.moralis.io/chat',
      {
        prompt: conversationContext,
        model: 'gpt-4.1-mini',
        stream: false
      },
      {
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json',
          'content-type': 'application/json'
        },
        timeout: 30000,
        validateStatus: function (status) {
        return status < 500;
        }
      }
    );

    console.log('📥 Moralis Chat API response status:', moralisResponse.status);
    console.log('📥 Response headers:', Object.keys(moralisResponse.headers || {}));
    console.log('📥 Response data keys:', Object.keys(moralisResponse.data || {}));

    if (moralisResponse.status !== 200) {
      throw new Error(`Moralis Chat API returned status ${moralisResponse.status}: ${JSON.stringify(moralisResponse.data)}`);
    }

    let responseText = '';
    if (moralisResponse.data?.text) {
      responseText = moralisResponse.data.text;
      console.log('✓ Found response in data.text');
    } else if (moralisResponse.data?.response) {
      responseText = moralisResponse.data.response;
      console.log('✓ Found response in data.response');
    } else if (moralisResponse.data?.message) {
      responseText = moralisResponse.data.message;
      console.log('✓ Found response in data.message');
    } else if (moralisResponse.data?.content) {
      responseText = moralisResponse.data.content;
      console.log('✓ Found response in data.content');
    } else if (typeof moralisResponse.data === 'string') {
      responseText = moralisResponse.data;
      console.log('✓ Response is direct string');
    } else if (moralisResponse.data?.choices?.[0]?.message?.content) {
      responseText = moralisResponse.data.choices[0].message.content;
      console.log('✓ Found response in OpenAI-style format');
    } else if (moralisResponse.data) {
      console.log('⚠️ Unexpected Moralis Chat API response format:', JSON.stringify(moralisResponse.data, null, 2));
      throw new Error(`Unexpected response format from Moralis Chat API: ${JSON.stringify(moralisResponse.data)}`);
    }

    if (!responseText || responseText.trim() === '') {
      throw new Error('Empty response from Moralis Chat API');
    }

    console.log('✓ Successfully extracted response text, length:', responseText.length);
  return responseText;
}

function convertHistoryForGemini(history) {
  return history.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  }));
}

async function callGeminiChat(history, message) {
  if (!CONFIG.geminiApiKey) {
    throw new Error('Gemini API key not configured');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.geminiApiKey}`;
  const convertedHistory = convertHistoryForGemini(history);

  const payload = {
    contents: [
      ...convertedHistory,
      {
        role: 'user',
        parts: [{ text: message }]
      }
    ],
    systemInstruction: {
      role: 'system',
      parts: [{ text: AI_CHAT_INSTRUCTIONS }]
    },
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 256,
      topP: 0.95
    }
  };

  console.log('📤 Sending request to Gemini API...');
  const geminiResponse = await axios.post(endpoint, payload, {
    headers: {
      'Content-Type': 'application/json'
    },
    timeout: 30000,
    validateStatus: status => status < 500
  });

  console.log('📥 Gemini API response status:', geminiResponse.status);

  if (geminiResponse.status !== 200) {
    throw new Error(`Gemini API returned status ${geminiResponse.status}: ${JSON.stringify(geminiResponse.data)}`);
  }

  const parts = geminiResponse.data?.candidates?.[0]?.content?.parts || [];
  const responseText = parts.map(part => part.text || '').join('\n').trim();

  if (!responseText) {
    throw new Error('Empty response from Gemini API');
  }

  console.log('✓ Successfully extracted response text from Gemini, length:', responseText.length);
  return responseText;
}

// AI Chat using Moralis Chat API with Gemini fallback
// PRO mode: Full analysis with Grok + Moralis + Gemini (requires active subscription)
app.post('/api/ai-chat', async (req, res) => {
  const { message, history = [], mode = 'auto' } = req.body; // mode: 'auto', 'free', 'pro'

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (!CONFIG.moralisApiKey && !CONFIG.geminiApiKey) {
    return res.status(500).json({
      error: 'AI providers not configured',
      message: 'Please add MORALIS_API_KEY and/or GEMINI_API_KEY to the .env file'
    });
  }

  // Check if user has active subscription for PRO mode
  let isPro = false;
  let subscriptionStatus = null;
  
  if (req.isAuthenticated && req.isAuthenticated()) {
    try {
      subscriptionStatus = await subscriptionService.getSubscriptionStatus(req.user.id);
      isPro = subscriptionStatus && subscriptionStatus.status === 'active';
      
      // Override with explicit mode if provided
      if (mode === 'pro') {
        if (!isPro) {
          return res.status(402).json({
            error: 'subscription_required',
            message: 'PRO chat requires an active subscription. Please purchase a package to access PRO features.',
            requiresPayment: true
          });
        }
      } else if (mode === 'free') {
        isPro = false;
      }
      // 'auto' mode: use subscription status
    } catch (subError) {
      console.warn('Could not check subscription status:', subError.message);
      isPro = false;
    }
  }

  console.log(`🤖 AI Chat request (${isPro ? 'PRO' : 'FREE'} mode): "${message.substring(0, 50)}..."`);

  // For PRO mode: Try to extract token info and fetch Grok insights
  let grokInsights = null;
  if (isPro && CONFIG.grokApiKey) {
    try {
      // Try to detect if message is about a token (look for token symbols, addresses, or common patterns)
      const tokenPattern = /(?:token|coin|price|analysis|analyze|research|sentiment|holder|liquidity|market cap|volume)/i;
      const addressPattern = /[A-Za-z0-9]{26,44}/; // Solana address pattern
      const symbolPattern = /\$[A-Z]{2,10}\b/; // Token symbol like $SOL, $USDC
      
      if (tokenPattern.test(message) || addressPattern.test(message) || symbolPattern.test(message)) {
        console.log('🔍 PRO mode: Detected potential token query, fetching Grok insights...');
        
        // Extract potential token symbol or name
        const symbolMatch = message.match(/\$([A-Z]{2,10})\b/);
        const tokenSymbol = symbolMatch ? symbolMatch[1] : null;
        const tokenName = tokenSymbol || 'token';
        
        grokInsights = await fetchGrokTwitterInsights(tokenName, tokenSymbol || 'UNKNOWN', null, {});
        
        if (grokInsights && grokInsights.trim().length > 0) {
          console.log(`✅ Grok insights retrieved (${grokInsights.length} chars)`);
        } else {
          console.log('⚠️ Grok insights returned empty');
        }
      }
    } catch (grokError) {
      console.warn('⚠️ Could not fetch Grok insights:', grokError.message);
      // Continue without Grok - not critical
    }
  }

  // Build conversation context with PRO instructions if applicable
  let conversationContext = buildMoralisConversation(history, message, isPro);
  
  // Add Grok insights to context if available (PRO mode only)
  if (isPro && grokInsights && grokInsights.trim().length > 0) {
    conversationContext = conversationContext.replace(
      'Assistant:',
      `TWITTER/X SENTIMENT ANALYSIS (via Grok):\n${grokInsights}\n\n---\n\nAssistant:`
    );
  }

  let responseText = '';
  let providerUsed = '';
  let moralisError = null;
  let geminiResponse = null;

  // PRO mode: Try both Moralis and Gemini, combine responses
  if (isPro) {
    console.log('🚀 PRO mode: Using enhanced AI analysis (Moralis + Gemini)');
    
    // Try Moralis first
    if (CONFIG.moralisApiKey) {
      try {
        const moralisText = await callMoralisChat(conversationContext);
        responseText = moralisText;
        providerUsed = 'moralis';
        console.log('✅ Moralis response received');
      } catch (error) {
        moralisError = error;
        console.error('❌ Moralis Chat API failed:', error.message);
      }
    }

    // Also try Gemini for multi-perspective analysis
    if (CONFIG.geminiApiKey) {
      try {
        geminiResponse = await callGeminiChat(history, message);
        console.log('✅ Gemini response received');
        
        // Combine responses if both succeeded
        if (responseText && geminiResponse) {
          responseText = `**Moralis AI Analysis:**\n\n${responseText}\n\n---\n\n**Gemini AI Analysis:**\n\n${geminiResponse}`;
          providerUsed = 'moralis+gemini';
        } else if (!responseText && geminiResponse) {
          responseText = geminiResponse;
          providerUsed = 'gemini';
        }
      } catch (geminiError) {
        console.error('❌ Gemini API failed:', geminiError.message);
      }
    }
  } else {
    // FREE mode: Standard flow (Moralis with Gemini fallback)
    if (CONFIG.moralisApiKey) {
      try {
        responseText = await callMoralisChat(conversationContext);
        providerUsed = 'moralis';
      } catch (error) {
        moralisError = error;
        console.error('❌ Moralis Chat API failed:', error.message);
        console.error('   Response data:', JSON.stringify(error.response?.data, null, 2));
      }
    }

    if (!responseText && CONFIG.geminiApiKey) {
      try {
        responseText = await callGeminiChat(history, message);
        providerUsed = 'gemini';
      } catch (geminiError) {
        console.error('❌ Gemini API fallback failed:', geminiError.message);
        console.error('   Response data:', JSON.stringify(geminiError.response?.data, null, 2));

        const combinedMessage = [];
        if (moralisError) combinedMessage.push(`Moralis: ${moralisError.message}`);
        combinedMessage.push(`Gemini: ${geminiError.message}`);

        return res.status(500).json({
          error: 'AI chat failed',
          message: combinedMessage.join(' | ')
        });
      }
    }
  }

  if (!responseText) {
    const fallbackMessage = moralisError
      ? `Moralis provider failed: ${moralisError.message}`
      : 'No AI provider produced a response';

    return res.status(500).json({
      error: 'AI chat failed',
      message: fallbackMessage
    });
  }

  const updatedHistory = [
    ...history,
    { role: 'user', content: message },
    { role: 'assistant', content: responseText }
  ];

  console.log(`✓ AI response generated via ${providerUsed} provider (${isPro ? 'PRO' : 'FREE'} mode)`);

  res.json({
    response: responseText,
    history: updatedHistory,
    provider: providerUsed,
    mode: isPro ? 'pro' : 'free',
    hasGrokInsights: !!(grokInsights && grokInsights.trim().length > 0),
    subscription: subscriptionStatus ? {
      status: subscriptionStatus.status,
      planName: subscriptionStatus.planName
    } : null
  });
});

// ===== Chain Volume Stats Endpoint =====

// Get volume stats by chain
app.get('/api/chain-volume', async (req, res) => {
  try {
    console.log(`📊 Fetching chain volume stats...`);

    // Check cache (5 minutes)
    const cacheKey = 'chain-volume-stats';
    const cached = cache.get(cacheKey);
    // Allow bypassing cache with ?nocache=1
    const bypassCache = req.query && (req.query.nocache === '1' || req.query.nocache === 'true');
    if (cached && !bypassCache) {
      console.log('✓ Returning cached chain volume stats');
      return res.json(cached);
    }

    if (!CONFIG.moralisApiKey) {
      return res.status(500).json({
        error: 'Moralis API key not configured'
      });
    }

    // Fetch volume stats from Moralis
    // Using exact format from Moralis documentation
    console.log(`📊 Fetching volume stats from Moralis API...`);
    console.log(`   URL: https://deep-index.moralis.io/api/v2.2/volume/chains`);
    console.log(`   API Key present: ${!!CONFIG.moralisApiKey}`);
    
    const response = await axios.get(
      'https://deep-index.moralis.io/api/v2.2/volume/chains',
      {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'X-API-Key': CONFIG.moralisApiKey
        },
        timeout: 15000,
        validateStatus: function (status) {
          return status < 500; // Don't throw on 4xx errors
        }
      }
    );

    console.log(`📊 API Response Status: ${response.status}`);
    console.log(`📊 Full Response Data:`, JSON.stringify(response.data, null, 2));
    
    // Check if response has chains array directly or nested
    const chains = response.data?.chains || (Array.isArray(response.data) ? response.data : []);
    
    console.log(`📊 Raw API response - ${chains.length} chains received`);
    if (chains.length > 0) {
      console.log(`📊 Sample chain data (first chain):`, JSON.stringify(chains[0], null, 2));
      console.log(`📊 Sample chain keys:`, Object.keys(chains[0]));
    } else {
      console.log(`⚠️ No chains found in response`);
      console.log(`   Response structure:`, Object.keys(response.data || {}));
    }
    
    // Map chain IDs to friendly names
    const chainIdMap = {
      '0x1': { name: 'Ethereum', logo: 'eth_light_3.png' },
      '0x38': { name: 'BNB Chain', logo: 'bnb-logo.png' },
      '0x2105': { name: 'Base', logo: 'base-logo.png' },
      '0x89': { name: 'Polygon', logo: null },
      '0xa86a': { name: 'Avalanche', logo: null },
      '0xa4b1': { name: 'Arbitrum', logo: null },
      '0xa': { name: 'Optimism', logo: null },
      '0x19': { name: 'Cronos', logo: null },
      '0xfa': { name: 'Fantom', logo: null },
      '0xe708': { name: 'Linea', logo: null }, // Linea Mainnet (59144)
      '0x531': { name: 'Celo', logo: null }, // Celo Mainnet (1329)
      '0x171': { name: 'Chain 0x171', logo: null }, // Unknown chain
      '0x7e4': { name: 'Chain 0x7e4', logo: null }, // Unknown chain
      // Non-EVM identifier returned by Moralis
      'solana': { name: 'Solana', logo: 'solana-logo.png' }
    };

    // Process and map chain data
    // Note: API returns lowercase 'totalvolume' and 'activeWallets' (camelCase)
    const processedChains = chains
      .map(chain => {
        const chainInfo = chainIdMap[chain.chainId] || { 
          name: `Chain ${chain.chainId}`, 
          logo: null 
        };
        
        // API returns 'totalVolume' (camelCase) - handle both formats
        const totalVolume = chain.totalVolume || chain.totalvolume || {};
        const activeWallets = chain.activeWallets || {};
        
        return {
          chainId: chain.chainId,
          name: chainInfo.name,
          logo: chainInfo.logo,
          volume24h: parseFloat(totalVolume['24h'] || totalVolume?.['24h'] || 0),
          activeWallets24h: parseInt(activeWallets['24h'] || activeWallets?.['24h'] || 0),
          totalTransactions24h: parseInt(chain.totalTransactions?.['24h'] || chain.totaltransactions?.['24h'] || 0),
          volume1h: parseFloat(totalVolume['1h'] || totalVolume?.['1h'] || 0),
          volume6h: parseFloat(totalVolume['6h'] || totalVolume?.['6h'] || 0),
          volume5m: parseFloat(totalVolume['5m'] || totalVolume?.['5m'] || 0),
          activeWallets1h: parseInt(activeWallets['1h'] || activeWallets?.['1h'] || 0),
          activeWallets6h: parseInt(activeWallets['6h'] || activeWallets?.['6h'] || 0)
        };
      })
      .filter(chain => chain.volume24h > 0) // Only chains with volume
      .sort((a, b) => b.volume24h - a.volume24h) // Sort by volume descending
      .slice(0, 5); // Only top 5 chains

    console.log(`✓ Found ${processedChains.length} chains with volume data`);

    const result = {
      chains: processedChains,
      timestamp: new Date().toISOString()
    };

    // Cache for 5 minutes
    cache.set(cacheKey, result, 300);

    res.json(result);

  } catch (error) {
    console.error('❌ Error fetching chain volume stats:', error.response?.data || error.message);
    console.error('   Error status:', error.response?.status);
    console.error('   Error headers:', error.response?.headers);
    console.error('   Full error:', JSON.stringify(error.response?.data || error.message, null, 2));
    
    // Return error details for debugging
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch chain volume stats',
      message: error.message,
      status: error.response?.status,
      errorDetails: error.response?.data,
      chains: []
    });
  }
});

// ===== Token Holders Endpoints =====

// Get top EVM token holders
app.get('/api/evm-holders/:chain/:address', async (req, res) => {
  const { chain, address } = req.params;
  const { limit = 25 } = req.query;

  try {
    console.log(`👥 Fetching EVM holders for ${address} on ${chain}...`);

    // Map chain names to Moralis chain IDs
    const chainMap = {
      'bnb': '0x38',
      'base': '0x2105',
      'ethereum': '0x1'
    };

    const moralisChain = chainMap[chain];
    if (!moralisChain) {
      return res.status(400).json({ error: `Unsupported chain: ${chain}` });
    }

    // Check cache
    const cacheKey = `evm-holders-${chain}-${address}-${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✓ Returning cached EVM holders');
      return res.json(cached);
    }

    // Fetch holders from Moralis
    const response = await axios.get(
      `https://deep-index.moralis.io/api/v2.2/erc20/${address}/owners`,
      {
        params: {
          chain: moralisChain,
          limit: parseInt(limit)
        },
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 15000
      }
    );

    const holders = response.data?.result || [];
    console.log(`✓ Found ${holders.length} EVM holders`);

    const result = {
      holders: holders.map(holder => ({
        owner_address: holder.owner_address,
        balance: holder.balance,
        percentage_relative_to_total_supply: parseFloat(holder.percentage_relative_to_total_supply || 0)
      }))
    };

    // Cache for 5 minutes
    cache.set(cacheKey, result, 300);

    res.json(result);

  } catch (error) {
    console.error('❌ Error fetching EVM holders:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch holders',
      message: error.message
    });
  }
});

// Get top Solana token holders
app.get('/api/solana-holders/:address', async (req, res) => {
  const { address } = req.params;
  const { limit = 25 } = req.query;

  try {
    console.log(`👥 Fetching Solana holders for ${address}...`);

    // Check cache
    const cacheKey = `solana-holders-${address}-${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✓ Returning cached Solana holders');
      return res.json(cached);
    }

    // Fetch holders from Moralis Solana API
    const response = await axios.get(
      `https://solana-gateway.moralis.io/token/mainnet/${address}/top-holders`,
      {
        params: {
          limit: parseInt(limit)
        },
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 15000
      }
    );

    const holders = response.data?.result || [];
    console.log(`✓ Found ${holders.length} Solana holders`);

    const result = {
      holders: holders.map(holder => ({
        owner: holder.owner,
        value: holder.value,
        percentage: parseFloat(holder.percentage || 0)
      }))
    };

    // Cache for 5 minutes
    cache.set(cacheKey, result, 300);

    res.json(result);

  } catch (error) {
    console.error('❌ Error fetching Solana holders:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch holders',
      message: error.message
    });
  }
});

// ===== Token Holder Stats Endpoints =====

// Get token holder statistics for Solana
app.get('/api/holder-stats/solana/:address', async (req, res) => {
  const { address } = req.params;

  try {
    console.log(`📊 Fetching holder stats for Solana token ${address}...`);

    // Check cache
    const cacheKey = `holder-stats-solana-${address}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✓ Returning cached holder stats');
      return res.json(cached);
    }

    // Fetch holder stats from Moralis
    const response = await axios.get(
      `https://solana-gateway.moralis.io/token/mainnet/holders/${address}`,
      {
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 15000
      }
    );

    const stats = response.data || {};
    console.log(`✓ Found holder stats: ${stats.totalHolders || 0} total holders`);

    const result = {
      totalHolders: stats.totalHolders || 0,
      holdersByAcquisition: stats.holdersByAcquisition || {
        swap: 0,
        transfer: 0,
        airdrop: 0
      }
    };

    // Cache for 10 minutes
    cache.set(cacheKey, result, 600);

    res.json(result);

  } catch (error) {
    console.error('❌ Error fetching holder stats:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch holder stats',
      message: error.message
    });
  }
});

// Get token holder statistics for EVM chains
app.get('/api/holder-stats/evm/:chain/:address', async (req, res) => {
  const { chain, address } = req.params;

  try {
    console.log(`📊 Fetching holder stats for EVM token ${address} on ${chain}...`);

    // Check cache
    const cacheKey = `holder-stats-evm-${chain}-${address}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✓ Returning cached EVM holder stats');
      return res.json(cached);
    }

    // Map chain names to Moralis format (eth, bsc, base)
    const chainMap = {
      'bnb': 'bsc',
      'eth': 'eth',
      'ethereum': 'eth',
      'base': 'base'
    };

    const moralisChain = chainMap[chain.toLowerCase()];
    if (!moralisChain) {
      return res.status(400).json({ error: `Unsupported chain: ${chain}` });
    }

    // Fetch holder stats from Moralis ERC20 Token Holder Stats API
    console.log(`📊 Calling Moralis API: https://deep-index.moralis.io/api/v2.2/erc20/${address}/holders?chain=${moralisChain}`);
    
    const response = await axios.get(
      `https://deep-index.moralis.io/api/v2.2/erc20/${address}/holders`,
      {
        params: {
          chain: moralisChain
        },
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 15000
      }
    );

    console.log(`📊 Holder stats API response status: ${response.status}`);
    console.log(`📊 Holder stats API response data:`, JSON.stringify(response.data, null, 2));

    const stats = response.data || {};
    
    if (!stats || Object.keys(stats).length === 0) {
      console.log(`⚠ Empty response from Moralis holder stats API for ${address} on ${chain}`);
      console.log(`   Chain used: ${moralisChain}`);
      console.log(`   Full URL: https://deep-index.moralis.io/api/v2.2/erc20/${address}/holders?chain=${moralisChain}`);
      return res.json({
        totalHolders: 0,
        holdersByAcquisition: {
          swap: 0,
          transfer: 0,
          airdrop: 0
        },
        holderChange: {},
        holderSupply: {},
        holderDistribution: {},
        note: 'No holder stats data returned from API'
      });
    }
    
    if (!stats.totalHolders && stats.totalHolders !== 0) {
      console.log(`⚠ Response missing totalHolders field`);
      console.log(`   Available fields:`, Object.keys(stats));
      console.log(`   Full response:`, JSON.stringify(stats, null, 2));
    }
    
    console.log(`✓ Found holder stats: ${stats.totalHolders || 0} total holders`);

    const result = {
      totalHolders: stats.totalHolders || 0,
      holdersByAcquisition: stats.holdersByAcquisition || {
        swap: 0,
        transfer: 0,
        airdrop: 0
      },
      holderChange: stats.holderChange || {},
      holderSupply: stats.holderSupply || {},
      holderDistribution: stats.holderDistribution || {}
    };

    // Cache for 10 minutes
    cache.set(cacheKey, result, 600);

    res.json(result);

  } catch (error) {
    console.error('❌ Error fetching EVM holder stats:', error.response?.data || error.message);
    
    // If it's a 404, token might not have holder stats yet
    if (error.response?.status === 404) {
      return res.json({
        totalHolders: 0,
        holdersByAcquisition: {
          swap: 0,
          transfer: 0,
          airdrop: 0
        },
        holderChange: {},
        note: 'Holder stats not available for this token'
      });
    }
    
    res.status(500).json({
      error: 'Failed to fetch holder stats',
      message: error.message
    });
  }
});
// ===== RugCheck API Endpoints =====


// Get token pairs data for EVM tokens (volume and liquidity)
app.get('/api/token-pairs/:chain/:address', async (req, res) => {
  const { chain, address } = req.params;

  try {
    console.log(`📊 Fetching token pairs for ${address} on ${chain}...`);

    // Check cache
    const cacheKey = `token-pairs-${chain}-${address}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✓ Returning cached token pairs data');
      return res.json(cached);
    }

    // Map chain names to Moralis format
    const chainMapping = {
      'bnb': 'bsc',
      'eth': 'eth',
      'base': 'base'
    };
    
    const moralisChain = chainMapping[chain] || chain;
    
    console.log(`Using chain: ${moralisChain} for address: ${address}`);
    
    // Use the correct Moralis endpoint for token pairs (direct REST API)
    const response = await axios.get(
      `https://deep-index.moralis.io/api/v2.2/erc20/${address}/pairs`,
      {
        params: {
          chain: moralisChain,
          limit: 25
        },
        headers: {
          'Accept': 'application/json',
          'X-API-Key': CONFIG.moralisApiKey
        },
        timeout: 15000
      }
    );

    const pairs = response.data.pairs || [];
    console.log(`✓ Retrieved ${pairs.length} pairs`);

    // Aggregate volume and liquidity from all pairs
    let totalLiquidity = 0;
    let total24hVolume = 0;

    pairs.forEach(pair => {
      if (pair.liquidity_usd) {
        totalLiquidity += parseFloat(pair.liquidity_usd);
      }
      if (pair.volume_24h) {
        total24hVolume += parseFloat(pair.volume_24h);
      }
    });

    const result = {
      address: address,
      chain: chain,
      pairCount: pairs.length,
      totalLiquidity: totalLiquidity,
      total24hVolume: total24hVolume,
      pairs: pairs.slice(0, 5), // Include top 5 pairs for reference
      timestamp: new Date().toISOString()
    };

    // Cache for 5 minutes (pairs data changes frequently)
    cache.set(cacheKey, result, 300);

    res.json(result);

  } catch (error) {
    console.error('❌ Error fetching token pairs:', error.response?.data || error.message);
    
    res.status(500).json({
      address: address,
      chain: chain,
      error: 'Failed to fetch token pairs',
      message: error.message,
      totalLiquidity: 0,
      total24hVolume: 0,
      pairCount: 0
    });
  }
});

// Get RugCheck report for a Solana token
app.get('/api/rugcheck/:address', async (req, res) => {
  const { address } = req.params;

  console.log(`🔍 Fetching RugCheck report for ${address}...`);

  const result = await fetchRugCheckAnalysis(address, { allowCached: true });

  if (result.errorCode === 401 || result.errorCode === 403) {
    return res.status(200).json({
      address,
      error: 'RugCheck API authentication required',
      message: 'Please add RUGCHECK_API_KEY to .env file',
      available: false
    });
  }

  if (result.error) {
    console.error('❌ Error fetching RugCheck report:', result.error);
    return res.status(500).json({
      address,
      error: 'Failed to fetch RugCheck report',
      message: result.error,
      available: false
    });
  }

  console.log(`✓ RugCheck status: ${result.status} (score: ${result.score ?? 'N/A'})`);
  res.json(result);
});
// ===== Twitter API Endpoints =====
// Get community tweets
app.get('/api/twitter/community/:communityId', async (req, res) => {
  const { communityId } = req.params;
  const { cursor, limit = 20 } = req.query;

  try {
    console.log(`🐦 Fetching tweets from community: ${communityId}`);

    const params = new URLSearchParams({
      community_id: communityId,
      ...(cursor && { cursor }),
      ...(limit && { limit })
    });

    const response = await axios.get(
      `https://api.twitterapi.io/twitter/community/tweets?${params}`,
      {
        headers: {
          'X-API-Key': CONFIG.twitterApiKey
        },
        timeout: 15000
      }
    );

    console.log(`✓ Found ${response.data?.tweets?.length || 0} tweets`);
    res.json(response.data);

  } catch (error) {
    console.error('❌ Error fetching community tweets:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch tweets',
      message: error.message
    });
  }
});

// Search tweets
app.get('/api/twitter/search', async (req, res) => {
  const { query, count = 20 } = req.query;

  try {
    if (!query) {
      return res.status(400).json({ error: 'Query parameter required' });
    }

    console.log(`🐦 Searching tweets: "${query}"`);

    const response = await axios.get(
      'https://api.twitterapi.io/search',
      {
        params: {
          query,
          count
        },
        headers: {
          'X-API-Key': CONFIG.twitterApiKey,
          'accept': 'application/json'
        },
        timeout: 15000
      }
    );

    console.log(`✓ Found ${response.data?.data?.length || 0} tweets`);
    
    // Format response to match expected structure
    res.json({
      tweets: response.data?.data || [],
      results: response.data?.data || []
    });

  } catch (error) {
    console.error('❌ Error searching tweets:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to search tweets',
      message: error.message,
      tweets: []
    });
  }
});

// Get user timeline (last tweets)
app.get('/api/twitter/user/:username', async (req, res) => {
  const { username } = req.params;
  const { cursor = '', includeReplies = false } = req.query;

  try {
    console.log(`🐦 Fetching tweets from user: @${username}`);

    const response = await axios.get(
      `https://api.twitterapi.io/twitter/user/last_tweets`,
      {
        params: { 
          userName: username,
          cursor,
          includeReplies
        },
        headers: {
          'X-API-Key': CONFIG.twitterApiKey,
          'accept': 'application/json'
        },
        timeout: 15000
      }
    );

    // The API returns tweets nested in data.data.tweets
    const tweetsData = response.data?.data || {};
    const tweets = tweetsData.tweets || [];
    
    console.log(`✓ Found ${tweets.length} tweets`);
    
    // Format response to match expected structure
    res.json({
      tweets: tweets,
      has_next_page: tweetsData.has_next_page || false,
      next_cursor: tweetsData.next_cursor || ''
    });

  } catch (error) {
    console.error('❌ Error fetching user timeline:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch user timeline',
      message: error.message,
      tweets: []
    });
  }
});

// ====================
// QUEST SYSTEM
// ====================

// Get user quest progress
app.get('/api/quests', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Initialize quests if they don't exist
    if (!user.quests) {
      user.quests = {
        twitterFollow: { completed: false, completedAt: null, twitterHandle: null }
      };
      const users = await loadUsers();
      const userIndex = users.findIndex(u => u.id === userId);
      if (userIndex >= 0) {
        users[userIndex].quests = user.quests;
        await saveUsers(users);
      }
    }
    
    // Count completed quests (only follow quest now)
    const completedQuests = user.quests?.twitterFollow?.completed ? 1 : 0;
    const totalQuests = 1; // Only follow quest
    const allQuestsCompleted = completedQuests === totalQuests;
    
    res.json({
      quests: user.quests,
      points: user.points || 0,
      completedCount: completedQuests,
      totalCount: totalQuests,
      allCompleted: allQuestsCompleted,
      rewards: {
        pointsPerQuest: 100, // Points per completed quest
        totalPoints: allQuestsCompleted ? 100 : completedQuests * 100, // 100 points for follow quest
        alreadyGranted: (user.points || 0) > 0
      }
    });
  } catch (error) {
    console.error('Error getting quests:', error);
    res.status(500).json({
      error: 'Failed to get quest progress',
      message: error.message
    });
  }
});

// Get user's saved AI analyses
app.get('/api/ai-analyses', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Initialize savedAnalyses if it doesn't exist
    if (!user.savedAnalyses) {
      user.savedAnalyses = [];
      const users = await loadUsers();
      const userIndex = users.findIndex(u => u.id === userId);
      if (userIndex >= 0) {
        users[userIndex].savedAnalyses = [];
        await saveUsers(users);
      }
    }
    
    // Sort by creation date (newest first) and return
    const sortedAnalyses = (user.savedAnalyses || []).sort((a, b) => {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    
    res.json({
      analyses: sortedAnalyses,
      totalCount: sortedAnalyses.length,
      paidCount: sortedAnalyses.filter(a => !a.isPreview).length,
      previewCount: sortedAnalyses.filter(a => a.isPreview).length
    });
  } catch (error) {
    console.error('Error getting saved analyses:', error);
    res.status(500).json({
      error: 'Failed to get saved analyses',
      message: error.message
    });
  }
});

// ====================
// TWITTER QUEST VERIFICATION HELPERS
// ====================

/**
 * Get Twitter user ID from username using Twitter API
 */
async function getTwitterUserId(username) {
  try {
    if (!CONFIG.twitterApiKey) {
      console.log(`⚠ Twitter API key not configured`);
      return null;
    }
    
    // Remove @ if present
    const cleanUsername = username.replace('@', '').trim();
    
    console.log(`🔍 Getting Twitter user ID for: ${cleanUsername}`);
    
    // Try using twitterapi.io to get user info
    const response = await axios.get(
      `https://api.twitterapi.io/twitter/user/by_username`,
      {
        params: { username: cleanUsername },
        headers: {
          'X-API-Key': CONFIG.twitterApiKey,
          'accept': 'application/json'
        },
        timeout: 10000,
        validateStatus: (status) => status < 500
      }
    );
    
    console.log(`📊 Twitter user API response for ${cleanUsername}:`, {
      status: response.status,
      dataKeys: Object.keys(response.data || {}),
      hasData: !!response.data?.data,
      userId: response.data?.data?.id,
      error: response.data?.error,
      message: response.data?.message
    });
    
    // Check for credit/authorization errors
    if (response.status === 402 || (response.data?.error && response.data?.message?.includes('Credits'))) {
      console.error(`❌ TwitterAPI.io account needs credits: ${response.data?.message || 'Insufficient credits'}`);
      return null;
    }
    
    if (response.data?.data?.id) {
      console.log(`✅ Found Twitter user ID: ${response.data.data.id} for @${cleanUsername}`);
      return response.data.data.id;
    }
    
    // Try alternative response structure
    if (response.data?.id) {
      console.log(`✅ Found Twitter user ID (alt): ${response.data.id} for @${cleanUsername}`);
      return response.data.id;
    }
    
    console.log(`❌ No user ID found in response for @${cleanUsername}`);
    return null;
  } catch (error) {
    console.error(`❌ Error getting Twitter user ID for ${username}:`, {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    return null;
  }
}

/**
 * Verify if a user follows @YunaraX402
 * STRICT MODE: Only returns true if API verification succeeds
 * Returns false if API unavailable, out of credits, or user not found
 */
async function verifyTwitterFollow(twitterHandle) {
  try {
    if (!CONFIG.twitterApiKey) {
      console.error('❌ Twitter API key not configured - verification unavailable');
      return false;
    }
    
    const cleanHandle = twitterHandle.replace('@', '').trim();
    const targetUsername = CONFIG.twitterUsername.replace('@', '').trim();
    
    console.log(`🔍 [verifyTwitterFollow] Input: twitterHandle="${twitterHandle}", cleanHandle="${cleanHandle}", targetUsername="${targetUsername}"`);
    
    // Get user's Twitter ID (but don't rely on it if API returns wrong data)
    // We'll prioritize username matching in followers list
    const userId = await getTwitterUserId(cleanHandle);
    console.log(`📋 User ID lookup result for @${cleanHandle}: ${userId || 'NOT FOUND'}`);
    
    // Note: The user ID lookup API may return incorrect data for some usernames
    // We'll rely primarily on username matching in the followers list
    
    // Get target user ID (yunaraX402) - this is just for logging
    const targetUserId = await getTwitterUserId(targetUsername);
    console.log(`📋 Target user ID lookup result for @${targetUsername}: ${targetUserId || 'NOT FOUND'}`);
    
    // Check if user is in yunaraX402's followers (reverse check)
    try {
      console.log(`🔍 Checking followers of @${targetUsername} for @${cleanHandle}...`);
      
      const followersResponse = await axios.get(
        `https://api.twitterapi.io/twitter/user/followers`,
        {
          params: { 
            userName: targetUsername,
            limit: 1000 // Check up to 1000 followers
          },
          headers: {
            'X-API-Key': CONFIG.twitterApiKey,
            'accept': 'application/json'
          },
          timeout: 15000,
          validateStatus: (status) => status < 500
        }
      );
      
      console.log(`📊 Followers API response:`, {
        status: followersResponse.status,
        hasData: !!followersResponse.data,
        dataKeys: Object.keys(followersResponse.data || {}),
        followersCount: followersResponse.data?.data?.followers?.length || followersResponse.data?.followers?.length || 0,
        error: followersResponse.data?.error,
        message: followersResponse.data?.message
      });
      
      // STRICT: Check for credit/authorization errors - NO VERIFICATION if API unavailable
      if (followersResponse.status === 402 || (followersResponse.data?.error && followersResponse.data?.message?.includes('Credits'))) {
        console.error(`❌ TwitterAPI.io account needs credits: ${followersResponse.data?.message || 'Insufficient credits'}`);
        console.error(`❌ VERIFICATION UNAVAILABLE - No points will be awarded`);
        console.error(`   Please recharge your Twitter API credits at https://twitterapi.io/`);
        console.error(`   Until then, automatic verification will not work.`);
        return false;
      }
      
      // STRICT: Check for other API errors
      if (followersResponse.status !== 200 || !followersResponse.data) {
        console.error(`❌ API returned error status ${followersResponse.status} - verification unavailable`);
        return false;
      }
      
      // Try multiple response structures - prioritize direct followers array
      const followers = followersResponse.data?.followers || 
                       followersResponse.data?.data?.followers || 
                       followersResponse.data?.data || 
                       [];
      
      // STRICT: If no followers data structure found, fail verification
      if (!Array.isArray(followers) || followers.length === 0) {
        console.error(`❌ Invalid followers response structure - verification unavailable`);
        console.error(`   Response data:`, JSON.stringify(followersResponse.data, null, 2));
        return false;
      }
      
      console.log(`📋 Found ${followers.length} followers, checking for @${cleanHandle} (ID: ${userId})...`);
      
      // Improved matching: prioritize username matching since user ID lookup may be unreliable
      // Handle various response formats
      const normalizedHandle = cleanHandle.toLowerCase().replace('@', '').trim();
      console.log(`🔍 [Matching] Looking for normalized handle: "${normalizedHandle}" (from cleanHandle: "${cleanHandle}")`);
      console.log(`   Total followers to check: ${followers.length}`);
      
      let userInFollowers = false;
      let matchDetails = null;
      
      for (let i = 0; i < followers.length; i++) {
        const f = followers[i];
        // Try multiple possible response structures
        const followerUsernameRaw = f.username || f.user?.username || f.screen_name || f.userName || '';
        const followerUsername = followerUsernameRaw.toString().toLowerCase().replace('@', '').trim();
        const followerId = (f.id || f.user?.id || f.user_id || '').toString();
        
        const usernameMatch = followerUsername === normalizedHandle;
        const idMatch = userId && followerId === userId.toString();
        
        // Log first few for debugging
        if (i < 3) {
          console.log(`   Follower ${i + 1}: raw="${followerUsernameRaw}", normalized="${followerUsername}", id="${followerId}", match=${usernameMatch}`);
        }
        
        // Prioritize username match (more reliable than ID match due to API issues)
        if (usernameMatch) {
          userInFollowers = true;
          matchDetails = {
            username: f.username || f.user?.username || f.screen_name || f.userName || 'N/A',
            id: followerId,
            lookupUserId: userId,
            matchType: 'username'
          };
          console.log(`  ✅ USERNAME MATCH FOUND! username="${matchDetails.username}" (normalized: "${followerUsername}"), id="${followerId}"`);
          console.log(`     Lookup returned userId="${userId}" but we're using username match (more reliable)`);
          break; // Found match, exit early
        } else if (idMatch && userId) {
          // ID match as fallback (but user ID lookup may be unreliable)
          userInFollowers = true;
          matchDetails = {
            username: f.username || f.user?.username || f.screen_name || f.userName || 'N/A',
            id: followerId,
            lookupUserId: userId,
            matchType: 'id'
          };
          console.log(`  ✅ ID MATCH FOUND! username="${matchDetails.username}", id="${followerId}", lookupUserId="${userId}"`);
          break; // Found match, exit early
        }
      }
      
      // If no match found, log detailed debug info
      if (!userInFollowers && matchDetails === null) {
        console.log(`  ❌ No match found after checking all ${followers.length} followers`);
        console.log(`     Searched for: "${normalizedHandle}"`);
        console.log(`     All follower usernames (normalized):`);
        followers.forEach((f, idx) => {
          const fUsername = (f.username || f.user?.username || f.screen_name || f.userName || 'N/A').toString().toLowerCase().replace('@', '').trim();
          console.log(`       ${idx + 1}. "${fUsername}"`);
        });
      }
      
      if (userInFollowers) {
        console.log(`✅ VERIFIED: @${cleanHandle} follows @${targetUsername}`);
        return true;
      }
      
      console.log(`❌ NOT VERIFIED: @${cleanHandle} is not in followers list of @${targetUsername}`);
      console.log(`   Looking for: username="${cleanHandle}" (normalized: "${cleanHandle.toLowerCase().replace('@', '').trim()}"), ID="${userId}"`);
      console.log(`   Sample followers (first 5):`);
      followers.slice(0, 5).forEach((f, i) => {
        const fUsername = f.username || f.user?.username || f.screen_name || 'N/A';
        const fId = f.id || f.user?.id || f.user_id || 'N/A';
        console.log(`     ${i + 1}. username="${fUsername}" (normalized: "${fUsername.toString().toLowerCase().replace('@', '').trim()}"), id="${fId}"`);
      });
      return false;
    } catch (error) {
      console.error(`❌ Error checking followers - verification unavailable:`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      return false;
    }
  } catch (error) {
    console.error('❌ Error verifying Twitter follow - verification unavailable:', error.message);
    return false;
  }
}
/**
 * Verify if a user liked a specific tweet
 * STRICT MODE: Only returns true if API verification succeeds
 * Returns false if API unavailable, out of credits, or user not found
 */
async function verifyTwitterLike(twitterHandle, tweetId) {
  try {
    if (!CONFIG.twitterApiKey) {
      console.error('❌ Twitter API key not configured - verification unavailable');
      return false;
    }
    
    if (!tweetId) {
      console.error('❌ Tweet ID required - verification unavailable');
      return false;
    }
    
    const cleanHandle = twitterHandle.replace('@', '').trim();
    
    // Get user's Twitter ID
    const userId = await getTwitterUserId(cleanHandle);
    if (!userId) {
      console.error(`❌ Could not get Twitter ID for ${cleanHandle} - verification unavailable`);
      return false;
    }
    
    // Try to get tweet likes using twitterapi.io
    try {
      console.log(`🔍 Checking likes for tweet ${tweetId}...`);
      
      const likesResponse = await axios.get(
        `https://api.twitterapi.io/twitter/tweet/likes`,
        {
          params: { 
            tweetId: tweetId,
            limit: 1000 // Check up to 1000 likes
          },
          headers: {
            'X-API-Key': CONFIG.twitterApiKey,
            'accept': 'application/json'
          },
          timeout: 15000,
          validateStatus: (status) => status < 500
        }
      );
      
      console.log(`📊 Likes API response:`, {
        status: likesResponse.status,
        hasData: !!likesResponse.data,
        dataKeys: Object.keys(likesResponse.data || {}),
        likesCount: likesResponse.data?.data?.likes?.length || likesResponse.data?.likes?.length || 0,
        error: likesResponse.data?.error,
        message: likesResponse.data?.message
      });
      
      // STRICT: Check for credit/authorization errors - NO VERIFICATION if API unavailable
      if (likesResponse.status === 402 || (likesResponse.data?.error && likesResponse.data?.message?.includes('Credits'))) {
        console.error(`❌ TwitterAPI.io account needs credits: ${likesResponse.data?.message || 'Insufficient credits'}`);
        console.error(`❌ VERIFICATION UNAVAILABLE - No points will be awarded`);
        return false;
      }
      
      // STRICT: Check for other API errors
      if (likesResponse.status !== 200 || !likesResponse.data) {
        console.error(`❌ API returned error status ${likesResponse.status} - verification unavailable`);
        return false;
      }
      
      // Try multiple response structures
      const likes = likesResponse.data?.data?.likes || 
                   likesResponse.data?.likes || 
                   likesResponse.data?.data || 
                   [];
      
      // STRICT: If no likes data structure found, fail verification
      if (!Array.isArray(likes)) {
        console.error(`❌ Invalid likes response structure - verification unavailable`);
        console.error(`   Response data:`, JSON.stringify(likesResponse.data, null, 2));
        return false;
      }
      
      console.log(`📋 Found ${likes.length} likes, checking for @${cleanHandle} (ID: ${userId})...`);
      
      const userLiked = likes.some(like => {
        const likeUsername = like.username || like.user?.username || '';
        const likeId = like.id || like.user?.id || '';
        const matches = likeUsername.toLowerCase() === cleanHandle.toLowerCase() || likeId === userId;
        if (matches) {
          console.log(`  ✓ Match found: username=${likeUsername}, id=${likeId}`);
        }
        return matches;
      });
      
      if (userLiked) {
        console.log(`✅ VERIFIED: @${cleanHandle} liked tweet ${tweetId}`);
        return true;
      }
      
      console.log(`❌ NOT VERIFIED: @${cleanHandle} did not like tweet ${tweetId}`);
      console.log(`   Sample likes:`, likes.slice(0, 3).map(l => ({ username: l.username || l.user?.username, id: l.id || l.user?.id })));
      return false;
    } catch (error) {
      console.error(`❌ Error checking likes - verification unavailable:`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      return false;
    }
  } catch (error) {
    console.error('❌ Error verifying Twitter like - verification unavailable:', error.message);
    return false;
  }
}

/**
 * Verify if a user commented/replied to a specific tweet
 * STRICT MODE: Only returns true if API verification succeeds
 * Returns false if API unavailable, out of credits, or user not found
 */
async function verifyTwitterComment(twitterHandle, tweetId) {
  try {
    if (!CONFIG.twitterApiKey) {
      console.error('❌ Twitter API key not configured - verification unavailable');
      return false;
    }
    
    if (!tweetId) {
      console.error('❌ Tweet ID required - verification unavailable');
      return false;
    }
    
    const cleanHandle = twitterHandle.replace('@', '').trim();
    
    // Get user's Twitter ID
    const userId = await getTwitterUserId(cleanHandle);
    if (!userId) {
      console.error(`❌ Could not get Twitter ID for ${cleanHandle} - verification unavailable`);
      return false;
    }
    
    // Try to get tweet replies using twitterapi.io
    try {
      console.log(`🔍 Checking replies to tweet ${tweetId}...`);
      
      const repliesResponse = await axios.get(
        `https://api.twitterapi.io/twitter/tweet/replies`,
        {
          params: { 
            tweetId: tweetId,
            limit: 1000 // Check up to 1000 replies
          },
          headers: {
            'X-API-Key': CONFIG.twitterApiKey,
            'accept': 'application/json'
          },
          timeout: 15000,
          validateStatus: (status) => status < 500
        }
      );
      
      console.log(`📊 Replies API response:`, {
        status: repliesResponse.status,
        hasData: !!repliesResponse.data,
        dataKeys: Object.keys(repliesResponse.data || {}),
        repliesCount: repliesResponse.data?.data?.replies?.length || repliesResponse.data?.replies?.length || repliesResponse.data?.data?.length || 0,
        error: repliesResponse.data?.error,
        message: repliesResponse.data?.message
      });
      
      // STRICT: Check for credit/authorization errors - NO VERIFICATION if API unavailable
      if (repliesResponse.status === 402 || (repliesResponse.data?.error && repliesResponse.data?.message?.includes('Credits'))) {
        console.error(`❌ TwitterAPI.io account needs credits: ${repliesResponse.data?.message || 'Insufficient credits'}`);
        console.error(`❌ VERIFICATION UNAVAILABLE - No points will be awarded`);
        return false;
      }
      
      // STRICT: Check for other API errors
      if (repliesResponse.status !== 200 || !repliesResponse.data) {
        console.error(`❌ API returned error status ${repliesResponse.status} - verification unavailable`);
        return false;
      }
      
      // Try multiple response structures
      const replies = repliesResponse.data?.data?.replies || 
                     repliesResponse.data?.replies || 
                     repliesResponse.data?.data || 
                     [];
      
      // STRICT: If no replies data structure found, fail verification
      if (!Array.isArray(replies)) {
        console.error(`❌ Invalid replies response structure - verification unavailable`);
        console.error(`   Response data:`, JSON.stringify(repliesResponse.data, null, 2));
        return false;
      }
      
      console.log(`📋 Found ${replies.length} replies, checking for @${cleanHandle} (ID: ${userId})...`);
      
      const userReplied = replies.some(reply => {
        const replyUsername = reply.username || reply.user?.username || reply.author?.username || '';
        const replyId = reply.author_id || reply.user?.id || reply.author?.id || '';
        const matches = replyUsername.toLowerCase() === cleanHandle.toLowerCase() || replyId === userId;
        if (matches) {
          console.log(`  ✓ Match found: username=${replyUsername}, id=${replyId}`);
        }
        return matches;
      });
      
      if (userReplied) {
        console.log(`✅ VERIFIED: @${cleanHandle} replied to tweet ${tweetId}`);
        return true;
      }
      
      console.log(`❌ NOT VERIFIED: @${cleanHandle} did not reply to tweet ${tweetId}`);
      console.log(`   Sample replies:`, replies.slice(0, 3).map(r => ({ 
        username: r.username || r.user?.username || r.author?.username, 
        id: r.author_id || r.user?.id || r.author?.id 
      })));
      return false;
    } catch (error) {
      console.error(`❌ Error checking replies - verification unavailable:`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      return false;
    }
  } catch (error) {
    console.error('❌ Error verifying Twitter comment - verification unavailable:', error.message);
    return false;
  }
}

// Verify Twitter follow quest
app.post('/api/quests/verify-follow', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { twitterHandle } = req.body; // User's Twitter handle
    
    if (!twitterHandle) {
      return res.status(400).json({ error: 'Twitter handle is required' });
    }
    
    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if already completed
    if (user.quests?.twitterFollow?.completed) {
      return res.json({
        success: true,
        message: 'Follow quest already completed',
        quest: user.quests.twitterFollow
      });
    }
    
    console.log(`🔍 Verifying Twitter follow: @${twitterHandle} follows @${CONFIG.twitterUsername}`);
    console.log(`   Received twitterHandle: "${twitterHandle}" (type: ${typeof twitterHandle}, length: ${twitterHandle?.length})`);
    
    // Automatically verify using Twitter API
    const isFollowing = await verifyTwitterFollow(twitterHandle);
    
    console.log(`   Verification result: ${isFollowing ? '✅ PASSED' : '❌ FAILED'}`);
    
    if (!isFollowing) {
      // STRICT: Only allow quest completion if verification succeeds
      // No fallback, no trust - verification must pass
      
      // Check if it's a credits issue (would have been logged in verifyTwitterFollow)
      // Provide helpful error message
      const errorMessage = `We couldn't verify that @${twitterHandle} follows @${CONFIG.twitterUsername}. ` +
        `Please ensure:\n` +
        `1. You follow @${CONFIG.twitterUsername} on Twitter/X\n` +
        `2. You entered your Twitter handle correctly (case-sensitive)\n` +
        `3. Wait a few seconds after following and try again (API may need time to update)\n` +
        `4. If the issue persists, the verification service may need credits - contact support`;
      
      return res.status(400).json({
        success: false,
        error: 'Follow not verified',
        message: errorMessage
      });
    }
    
    const users = await loadUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex >= 0) {
      if (!users[userIndex].quests) {
        users[userIndex].quests = {
          twitterFollow: { completed: false, completedAt: null, twitterHandle: null }
        };
      }
      
      users[userIndex].quests.twitterFollow = {
        completed: true,
        completedAt: new Date().toISOString(),
        twitterHandle: twitterHandle.replace('@', '').trim(),
        verified: true
      };
      
      // Check if all quests are now completed and grant rewards
      await checkAndGrantQuestRewards(users[userIndex], users, userIndex);
      
      await saveUsers(users);
      
      res.json({
        success: true,
        message: 'Follow quest verified and completed!',
        quest: users[userIndex].quests.twitterFollow,
        points: users[userIndex].points || 0
      });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    console.error('Error verifying follow quest:', error);
    res.status(500).json({
      error: 'Failed to verify follow quest',
      message: error.message
    });
  }
});
// Verify Twitter like quest
app.post('/api/quests/verify-like', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { tweetId, twitterHandle } = req.body; // Tweet ID and user's Twitter handle
    
    if (!tweetId) {
      return res.status(400).json({ error: 'Tweet ID is required' });
    }
    
    if (!twitterHandle) {
      return res.status(400).json({ error: 'Twitter handle is required for verification' });
    }
    
    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if already completed
    if (user.quests?.twitterLike?.completed) {
      return res.json({
        success: true,
        message: 'Like quest already completed',
        quest: user.quests.twitterLike
      });
    }
    
    console.log(`🔍 Verifying Twitter like: @${twitterHandle} liked tweet ${tweetId}`);
    
    // Automatically verify using Twitter API
    const isLiked = await verifyTwitterLike(twitterHandle, tweetId);
    
    if (!isLiked) {
      // STRICT: Only allow quest completion if verification succeeds
      // No fallback, no trust - verification must pass
      return res.status(400).json({
        success: false,
        error: 'Like not verified',
        message: `We couldn't verify that @${twitterHandle} liked the tweet. Verification failed - please make sure you liked the tweet and try again.`
      });
    }
    
    const users = await loadUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex >= 0) {
      if (!users[userIndex].quests) {
        users[userIndex].quests = {
          twitterFollow: { completed: false, completedAt: null, twitterHandle: null }
        };
      }
      
      users[userIndex].quests.twitterLike = {
        completed: true,
        completedAt: new Date().toISOString(),
        tweetId: tweetId,
        twitterHandle: twitterHandle.replace('@', '').trim(),
        verified: true
      };
      
      // Check if all quests are now completed and grant rewards
      await checkAndGrantQuestRewards(users[userIndex], users, userIndex);
      
      await saveUsers(users);
      
      res.json({
        success: true,
        message: 'Like quest verified and completed!',
        quest: users[userIndex].quests.twitterLike,
        points: users[userIndex].points || 0
      });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    console.error('Error verifying like quest:', error);
    res.status(500).json({
      error: 'Failed to verify like quest',
      message: error.message
    });
  }
});

// Verify Twitter comment quest
app.post('/api/quests/verify-comment', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { tweetId, commentId, twitterHandle } = req.body; // Tweet ID, comment/reply ID, and user's Twitter handle
    
    if (!tweetId) {
      return res.status(400).json({ error: 'Tweet ID is required' });
    }
    
    if (!twitterHandle) {
      return res.status(400).json({ error: 'Twitter handle is required for verification' });
    }
    
    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if already completed
    if (user.quests?.twitterComment?.completed) {
      return res.json({
        success: true,
        message: 'Comment quest already completed',
        quest: user.quests.twitterComment
      });
    }
    
    console.log(`🔍 Verifying Twitter comment: @${twitterHandle} replied to tweet ${tweetId}`);
    
    // Automatically verify using Twitter API
    const isCommented = await verifyTwitterComment(twitterHandle, tweetId);
    
    if (!isCommented) {
      // STRICT: Only allow quest completion if verification succeeds
      // No fallback, no trust - verification must pass
      return res.status(400).json({
        success: false,
        error: 'Comment not verified',
        message: `We couldn't verify that @${twitterHandle} replied to the tweet. Verification failed - please make sure you replied to the tweet and try again.`
      });
    }
    
    const users = await loadUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    
    if (userIndex >= 0) {
      if (!users[userIndex].quests) {
        users[userIndex].quests = {
          twitterFollow: { completed: false, completedAt: null, twitterHandle: null }
        };
      }
      
      users[userIndex].quests.twitterComment = {
        completed: true,
        completedAt: new Date().toISOString(),
        tweetId: tweetId,
        commentId: commentId || null,
        twitterHandle: twitterHandle.replace('@', '').trim(),
        verified: true
      };
      
      // Check if all quests are now completed and grant rewards
      await checkAndGrantQuestRewards(users[userIndex], users, userIndex);
      
      await saveUsers(users);
      
      res.json({
        success: true,
        message: 'Comment quest verified and completed!',
        quest: users[userIndex].quests.twitterComment,
        points: users[userIndex].points || 0
      });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    console.error('Error verifying comment quest:', error);
    res.status(500).json({
      error: 'Failed to verify comment quest',
      message: error.message
    });
  }
});

// Helper function to check and grant quest rewards
async function checkAndGrantQuestRewards(user, users, userIndex) {
  if (!user.quests) return;
  
  // Only follow quest exists now
  const completedQuests = user.quests?.twitterFollow?.completed ? 1 : 0;
  
  // Grant points: 100 points for completing the follow quest
  const pointsToGrant = completedQuests * 100;
  const currentPoints = user.points || 0;
  
  // Only grant points if user hasn't already received them for this quest
  if (pointsToGrant > currentPoints) {
    users[userIndex].points = pointsToGrant;
    console.log(`🎁 Granted ${pointsToGrant} points to user ${user.email} for completing the follow quest!`);
    console.log(`   Total points: ${pointsToGrant} (will be used for airdrop later)`);
  }
}

// ====================
// GROK API INTEGRATION
// ====================

/**
 * Fetch Grok Twitter insights for a token
 * Analyzes Twitter/X community sentiment, trends, and discussions about the token
 */
async function fetchGrokTwitterInsights(tokenName, tokenSymbol, tokenAddress, tokenData = {}) {
  try {
    if (!CONFIG.grokApiKey) {
      console.log('⚠ Grok API key not configured');
      return null;
    }

    console.log(`🤖 Fetching Grok insights for ${tokenName} (${tokenSymbol})...`);
    
    // Extract token metrics from tokenData
    const price = tokenData.price || tokenData.usdPrice || 0;
    const marketCap = tokenData.marketCap || tokenData.market_cap || 0;
    const volume24h = tokenData.volume24h || tokenData.volume_24h || 0;
    const liquidity = tokenData.liquidity || tokenData.liquidityUSD || 0;
    const holders = tokenData.holders || tokenData.totalHolders || 0;
    const priceChange24h = tokenData.priceChange24h || tokenData.price_change_24h || 0;
    const chain = tokenData.chain || 'unknown';
    
    // Build concise, readable prompt with token data
    const grokPrompt = `Analyze Twitter/X community sentiment for "${tokenName}" (${tokenSymbol})${tokenAddress ? ` [${tokenAddress.substring(0, 8)}...]` : ''}.
TOKEN METRICS:
${price > 0 ? `Price: $${price.toFixed(8)}` : ''} | ${marketCap > 0 ? `MCap: $${(marketCap / 1000000).toFixed(2)}M` : ''} | ${volume24h > 0 ? `24h Vol: $${(volume24h / 1000).toFixed(2)}K` : ''} | ${liquidity > 0 ? `Liq: $${(liquidity / 1000).toFixed(2)}K` : ''} | ${holders > 0 ? `Holders: ${holders.toLocaleString()}` : ''} | ${priceChange24h !== 0 ? `24h: ${priceChange24h > 0 ? '+' : ''}${priceChange24h.toFixed(2)}%` : ''}

Provide a SHORT, CONCISE analysis (max 400 words) in this format:

**Sentiment:** [Bullish/Bearish/Neutral] - [1-2 sentence summary]

**Key Points:**
• [Most important finding - 1 sentence]
• [Second key finding - 1 sentence]
• [Third key finding - 1 sentence]

**Top Influencers:** [2-3 account names with brief note]

**Red Flags:** [Any concerns - 1-2 sentences if applicable]

**Verdict:** [1-2 sentence actionable conclusion]

Keep it brief, scannable, and actionable. No long paragraphs.`;

    // Use grok-4-fast-reasoning model as specified, fallback to grok-3 (grok-beta was deprecated)
    const modelsToTry = ['grok-4-fast-reasoning', 'grok-3', 'grok-2'];
    
    console.log(`📤 Making Grok API request to https://api.x.ai/v1/chat/completions`);
    console.log(`   API Key: ${CONFIG.grokApiKey ? CONFIG.grokApiKey.substring(0, 10) + '...' : 'MISSING'}`);
    console.log(`   Prompt length: ${grokPrompt.length} chars`);
    
    for (const modelName of modelsToTry) {
      try {
        console.log(`🔄 Trying Grok API with model: ${modelName}...`);
        
        // Follow official Grok API format from docs.x.ai
        const requestBody = {
          model: modelName,
          messages: [
            {
              role: 'user',
              content: grokPrompt
            }
          ],
          temperature: 0.7,
          max_tokens: 500, // Reduced for shorter, more readable responses
          stream: false // Explicitly set to false for non-streaming
        };
        
        console.log(`   Request body keys:`, Object.keys(requestBody));
        
        const grokResponse = await axios.post(
          'https://api.x.ai/v1/chat/completions',
          requestBody,
          {
            headers: {
              'Authorization': `Bearer ${CONFIG.grokApiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 45000,
            validateStatus: () => true // Don't throw on any status
          }
        );

        console.log(`📥 Grok API Response for ${modelName}:`);
        console.log(`   Status: ${grokResponse.status}`);
        console.log(`   Status Text: ${grokResponse.statusText}`);
        console.log(`   Response headers:`, Object.keys(grokResponse.headers || {}));
        console.log(`   Response data keys:`, Object.keys(grokResponse.data || {}));
        console.log(`   Full response data:`, JSON.stringify(grokResponse.data, null, 2));

        if (grokResponse.status === 200) {
          // Grok API follows OpenAI format: response.data.choices[0].message.content
          const grokContent = grokResponse.data?.choices?.[0]?.message?.content || 
                             null;

          console.log(`   Extracted content:`, grokContent ? `${grokContent.substring(0, 200)}...` : 'NULL');

          if (grokContent && grokContent.trim().length > 0) {
            console.log(`✅ Grok insights received with model ${modelName} (${grokContent.length} chars)`);
            console.log(`   Preview: ${grokContent.substring(0, 200)}...`);
            return grokContent.trim();
          } else {
            console.log(`⚠️ Model ${modelName} returned empty content`);
            console.log(`   Response structure:`, JSON.stringify(grokResponse.data, null, 2));
          }
        } else {
          console.log(`⚠️ Model ${modelName} returned status ${grokResponse.status}`);
          if (grokResponse.data) {
            console.log(`   Error details:`, JSON.stringify(grokResponse.data, null, 2));
          }
          // If it's a 401/403, the API key is wrong, stop trying
          if (grokResponse.status === 401 || grokResponse.status === 403) {
            console.error(`❌ Authentication failed - API key may be invalid`);
            return null;
          }
          // If it's a 404, the model doesn't exist, continue to next
          if (grokResponse.status === 404) {
            console.log(`   Model ${modelName} not found, trying next...`);
            continue;
          }
        }
      } catch (modelError) {
        console.error(`❌ Error with model ${modelName}:`, modelError.message);
        console.error(`   Error stack:`, modelError.stack);
        if (modelError.response) {
          console.error(`   Response status: ${modelError.response.status}`);
          console.error(`   Response data:`, JSON.stringify(modelError.response.data, null, 2));
        }
        // Continue to next model
        continue;
      }
    }
    
    console.error('❌ All Grok models failed - no insights available');
    return null;

  } catch (error) {
    console.error('❌ Error fetching Grok insights:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    return null;
  }
}

// ====================
// ENHANCED SOLANA METADATA FETCHING
// ====================

/**
 * Enhanced metadata fetching for Solana tokens with multiple fallbacks
 * Specifically designed to handle very new Pump.fun tokens that may not be indexed yet
 * 
 * Fallback order:
 * 1. Moralis regular metadata API
 * 2. Moralis Pump.fun metadata API
 * 3. DEXScreener API (great for new tokens that are trading)
 * 4. Helius DAS API (if API key is available)
 * 5. Return minimal metadata with pairLabel as fallback
 */
async function fetchSolanaTokenMetadataEnhanced(tokenAddress) {
  try {
    // Try 1: Moralis regular metadata
    try {
      const response = await axios.get(
        `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/metadata`,
        {
          headers: {
            'X-API-Key': CONFIG.moralisApiKey,
            'accept': 'application/json'
          },
          timeout: 6000
        }
      );
      
      if (response.data && (response.data.name || response.data.symbol)) {
        console.log(`  ✅ [METADATA] Moralis regular API: ${response.data.name || 'Unknown'}`);
        return { status: 'fulfilled', value: { data: response.data, config: { url: response.config?.url } } };
      }
    } catch (err) {
      // Continue to next fallback
    }
    
    // Try 2: Moralis Pump.fun metadata
    try {
      const response = await axios.get(
        `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/metadata/pumpfun`,
        {
          headers: {
            'X-API-Key': CONFIG.moralisApiKey,
            'accept': 'application/json'
          },
          timeout: 6000
        }
      );
      
      if (response.data && (response.data.name || response.data.symbol)) {
        console.log(`  ✅ [METADATA] Moralis Pump.fun API: ${response.data.name || 'Unknown'}`);
        return { status: 'fulfilled', value: { data: response.data, config: { url: response.config?.url } } };
      }
    } catch (err) {
      // Continue to next fallback
    }
    
    // Try 3: DEXScreener API - Great for new tokens that are actively trading
    try {
      const response = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
        {
          timeout: 6000,
          validateStatus: (status) => status < 500 // Accept 4xx errors, don't throw
        }
      );
      
      if (response.data && response.data.pairs && response.data.pairs.length > 0) {
        const pair = response.data.pairs[0]; // Get first pair (usually most liquid)
        const metadata = {
          name: pair.baseToken?.name || null,
          symbol: pair.baseToken?.symbol || null,
          logo: pair.baseToken?.logoURI || null,
          decimals: pair.baseToken?.decimals || 9,
          totalSupply: null,
          fullyDilutedValue: null
        };
        
        if (metadata.name || metadata.symbol) {
          console.log(`  ✅ [METADATA] DEXScreener API: ${metadata.name || metadata.symbol || 'Unknown'}`);
          return { status: 'fulfilled', value: { data: metadata, config: { url: 'dexscreener' } } };
        }
      }
    } catch (err) {
      console.log(`  ⚠ [METADATA] DEXScreener failed: ${err.message}`);
      // Continue to next fallback
    }
    
    // Try 4: Helius DAS API (Digital Asset Standard) - Best for new tokens
    if (CONFIG.heliusApiKey) {
      try {
        const response = await axios.post(
          `https://mainnet.helius-rpc.com/?api-key=${CONFIG.heliusApiKey}`,
          {
            jsonrpc: '2.0',
            id: 'helius-metadata-fetch',
            method: 'getAsset',
            params: {
              id: tokenAddress,
              displayOptions: {
                showFungible: true
              }
            }
          },
          {
            headers: {
              'Content-Type': 'application/json'
            },
            timeout: 6000
          }
        );
        
        if (response.data && response.data.result) {
          const asset = response.data.result;
          const metadata = {
            name: asset.content?.metadata?.name || asset.name || null,
            symbol: asset.content?.metadata?.symbol || null,
            logo: asset.content?.metadata?.image || asset.content?.files?.[0]?.uri || null,
            decimals: asset.token_info?.decimals || 9,
            totalSupply: asset.token_info?.supply || null,
            fullyDilutedValue: null
          };
          
          if (metadata.name || metadata.symbol) {
            console.log(`  ✅ [METADATA] Helius DAS API: ${metadata.name || metadata.symbol || 'Unknown'}`);
            return { status: 'fulfilled', value: { data: metadata, config: { url: 'helius-das' } } };
          }
        }
      } catch (err) {
        console.log(`  ⚠ [METADATA] Helius DAS failed: ${err.message}`);
        // Continue to next fallback
      }
    } else {
      console.log(`  ℹ️ [METADATA] Helius API key not configured, skipping DAS API`);
    }
    
    // All fallbacks failed - return empty metadata
    console.log(`  ❌ [METADATA] All fallbacks failed for ${tokenAddress}`);
    return { 
      status: 'rejected', 
      reason: { message: 'All metadata sources failed' },
      value: { data: {}, config: { url: 'none' } }
    };
    
  } catch (error) {
    console.error(`  ❌ [METADATA] Error in enhanced fetch: ${error.message}`);
    return { 
      status: 'rejected', 
      reason: { message: error.message },
      value: { data: {}, config: { url: 'none' } }
    };
  }
}
// ====================
// KOL ACTIVITY TRACKER
// ====================
// Get live KOL trading activity (what tokens they're buying/selling)
app.get('/api/kol-activity', async (req, res) => {
  try {
    console.log(`👥 Fetching live KOL trading activity...`);
    
    // Check cache first (2 minutes for live data)
    const cacheKey = 'kol-live-activity';
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log('✓ Returning cached KOL trading activity');
      return res.json(cached);
    }
    
    // Get recent swaps from all KOLs in parallel
    const kolPromises = TOP_KOLS.map(async (kol) => {
      try {
        // Get wallet swap history using the correct Moralis endpoint
        const response = await axios.get(
          `https://solana-gateway.moralis.io/account/mainnet/${kol.address}/swaps`,
          {
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            params: {
              limit: 20 // Last 20 swaps
            },
            timeout: 10000
          }
        );
        
        const swaps = response.data?.result || [];
        console.log(`✓ ${kol.name}: Found ${swaps.length} recent swaps`);
        
        return {
          kol: {
            name: kol.name,
            rank: kol.rank,
            address: kol.address
          },
          swaps: swaps,
          lastActivity: swaps.length > 0 ? swaps[0].blockTimestamp : null
        };
        
      } catch (error) {
        console.log(`⚠ Could not fetch swaps for ${kol.name}:`, error.message);
        return {
          kol: {
            name: kol.name,
            rank: kol.rank,
            address: kol.address
          },
          swaps: [],
          lastActivity: null,
          error: error.message
        };
      }
    });
    
    const results = await Promise.all(kolPromises);
    
    // Aggregate token activity from swaps
    const tokenActivity = {};
    
    results.forEach(result => {
      result.swaps.forEach(swap => {
        // Extract token address from swap
        // The pairAddress contains the token being traded
        const tokenAddress = swap.pairAddress;
        const exchangeName = swap.exchangeName || 'Unknown DEX';
        const swapType = swap.transactionType; // "buy" or "sell"
        
        if (tokenAddress) {
          if (!tokenActivity[tokenAddress]) {
            tokenActivity[tokenAddress] = {
              tokenAddress: tokenAddress,
              pairLabel: swap.pairLabel || 'Unknown Token',
              exchangeName: exchangeName,
              kolsTrading: [],
              totalSwaps: 0,
              buys: 0,
              sells: 0,
              lastSwapTime: swap.blockTimestamp
            };
          }
          
          // Add KOL to this token's activity if not already there
          const existingKOL = tokenActivity[tokenAddress].kolsTrading.find(k => k.address === result.kol.address);
          if (!existingKOL) {
            // Find the full KOL object with image
            const fullKOL = TOP_KOLS.find(k => k.address === result.kol.address);
            tokenActivity[tokenAddress].kolsTrading.push({
              ...result.kol,
              swapType: swapType,
              image: fullKOL?.image || null
            });
          }
          
          tokenActivity[tokenAddress].totalSwaps++;
          
          // Count buys and sells
          if (swapType === 'buy') {
            tokenActivity[tokenAddress].buys++;
          } else if (swapType === 'sell') {
            tokenActivity[tokenAddress].sells++;
          }
          
          // Update last swap time if newer
          if (swap.blockTimestamp > tokenActivity[tokenAddress].lastSwapTime) {
            tokenActivity[tokenAddress].lastSwapTime = swap.blockTimestamp;
          }
        }
      });
    });
    
    // Convert to array and sort by number of KOLs trading and recency
    const topTokens = Object.values(tokenActivity)
      .sort((a, b) => {
        // First sort by number of KOLs trading (more is better)
        if (b.kolsTrading.length !== a.kolsTrading.length) {
          return b.kolsTrading.length - a.kolsTrading.length;
        }
        // Then by last swap time (more recent is better)
        return new Date(b.lastSwapTime) - new Date(a.lastSwapTime);
      })
      .slice(0, 20); // Top 20 most traded by KOLs
    console.log(`✓ Found ${topTokens.length} tokens being actively traded by KOLs`);
    
    // Enrich tokens with comprehensive metadata (logo, price, holders, RugCheck, etc.)
    const enrichedTokens = await Promise.all(topTokens.map(async (token) => {
      try {
        console.log(`📊 Enriching token: ${token.pairLabel} (${token.tokenAddress})`);
        
        // Determine if token is EVM (starts with 0x) or Solana
        const isEVM = token.tokenAddress && token.tokenAddress.startsWith('0x');
        let chain = 'solana';
        let chainId = null;
        
        if (isEVM) {
          // For EVM chains, we need to determine which chain (could be bnb, base, eth)
          // Try to get chain info from token discovery API or default to checking all
          // For now, we'll try to fetch from the token discovery endpoint which can detect the chain
          console.log(`  🔍 Detected EVM token (0x address), will detect chain automatically`);
          // We'll determine chain dynamically by trying token discovery
        }
        
        // Fetch comprehensive data in parallel - different APIs for Solana vs EVM
        let metadataResponse, priceResponse, analyticsResponse, holderStatsResponse, rugCheckResponse, pairsResponse;
        
        if (isEVM) {
          // EVM token - use EVM APIs
          // First, try to get token details which will tell us the chain and provide comprehensive data
          [metadataResponse, priceResponse, pairsResponse, holderStatsResponse] = await Promise.allSettled([
            // Token discovery API to get metadata and chain info
            axios.get(
              `https://deep-index.moralis.io/api/v2.2/discovery/token`,
              {
                params: {
                  address: token.tokenAddress
                },
                headers: {
                  'X-API-Key': CONFIG.moralisApiKey,
                  'accept': 'application/json'
                },
                timeout: 8000
              }
            ),
            // Price API (need to determine chain first)
            Promise.resolve({ status: 'pending' }), // Will fetch after chain detection
            // Token pairs for volume and liquidity
            Promise.resolve({ status: 'pending' }), // Will fetch after chain detection
            // Holder stats
            Promise.resolve({ status: 'pending' }) // Will fetch after chain detection
          ]);
          
          // Extract chain from discovery API if available
          if (metadataResponse.status === 'fulfilled' && metadataResponse.value.data) {
            const discoveryData = metadataResponse.value.data;
            const chainIdHex = discoveryData.chainId;
            if (chainIdHex === '0x38') {
              chain = 'bnb';
              chainId = '0x38';
            } else if (chainIdHex === '0x2105') {
              chain = 'base';
              chainId = '0x2105';
            } else if (chainIdHex === '0x1') {
              chain = 'ethereum';
              chainId = '0x1';
            }
            console.log(`  ✓ Detected EVM chain: ${chain} (${chainIdHex})`);
          }
          
          // Now fetch EVM-specific data with detected chain
          if (chainId) {
            const chainMap = {
              'bnb': 'bsc',
              'base': 'base',
              'ethereum': 'eth'
            };
            const moralisChain = chainMap[chain] || chain;
            
            [priceResponse, pairsResponse, holderStatsResponse, analyticsResponse] = await Promise.allSettled([
              // Price
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/erc20/${token.tokenAddress}/price`,
                {
                  params: { chain: chainId },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 8000
                }
              ),
              // Pairs for volume and liquidity
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/erc20/${token.tokenAddress}/pairs`,
                {
                  params: { chain: moralisChain },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 8000
                }
              ),
              // Holder stats
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/erc20/${token.tokenAddress}/holders`,
                {
                  params: { chain: moralisChain },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 8000
                }
              ),
              // Analytics for 24h change
              axios.get(
                `https://deep-index.moralis.io/api/v2.2/tokens/${token.tokenAddress}/analytics`,
                {
                  params: { chain: moralisChain },
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 8000
                }
              )
            ]);
          }
          
          // RugCheck doesn't work for EVM tokens (Solana only)
          rugCheckResponse = { status: 'rejected', reason: { message: 'RugCheck only for Solana' } };
        } else {
          // Solana token - use Solana APIs with multiple fallbacks for new Pump.fun tokens
          [metadataResponse, priceResponse, analyticsResponse, holderStatsResponse, rugCheckResponse] = await Promise.allSettled([
            // Enhanced metadata fetching with multiple fallbacks for new Pump.fun tokens
            fetchSolanaTokenMetadataEnhanced(token.tokenAddress),
            // Try regular Solana price first, then Pump.fun
            axios.get(
              `https://solana-gateway.moralis.io/token/mainnet/${token.tokenAddress}/price`,
              {
                headers: {
                  'X-API-Key': CONFIG.moralisApiKey,
                  'accept': 'application/json'
                },
                timeout: 8000
              }
            ).catch(() => {
              // Fallback to Pump.fun
              return axios.get(
                `https://solana-gateway.moralis.io/token/mainnet/${token.tokenAddress}/price/pumpfun`,
                {
                  headers: {
                    'X-API-Key': CONFIG.moralisApiKey,
                    'accept': 'application/json'
                  },
                  timeout: 8000
                }
              );
            }),
            // Analytics for 24h change (only for regular tokens)
            axios.get(
              `https://deep-index.moralis.io/api/v2.2/tokens/${token.tokenAddress}/analytics`,
              {
                params: { chain: 'solana' },
                headers: {
                  'X-API-Key': CONFIG.moralisApiKey,
                  'accept': 'application/json'
                },
                timeout: 8000
              }
            ),
            // Holder stats
            axios.get(
              `https://solana-gateway.moralis.io/token/mainnet/holders/${token.tokenAddress}`,
              {
                headers: {
                  'X-API-Key': CONFIG.moralisApiKey,
                  'accept': 'application/json'
                },
                timeout: 8000
              }
            ),
            // RugCheck report (Solana only)
            axios.get(
              `https://api.rugcheck.xyz/v1/tokens/${token.tokenAddress}/report`,
              {
                headers: { 'Accept': 'application/json' },
                timeout: 8000
              }
            )
          ]);
          
          pairsResponse = { status: 'rejected' }; // No pairs API for Solana in this context
        }
        
        // Extract data based on chain type
        let metadata = {};
        let priceData = {};
        let analytics = {};
        let isPumpFun = false;
        let discoveryData = null;
        let pairsData = null;
        
        if (isEVM) {
          // Extract EVM data
          if (metadataResponse.status === 'fulfilled') {
            discoveryData = metadataResponse.value.data || {};
            metadata = {
              name: discoveryData.token_name || token.pairLabel,
              symbol: discoveryData.token_symbol || token.pairLabel,
              logo: discoveryData.token_logo || null,
              decimals: discoveryData.token_decimals || 18
            };
            console.log(`  ✓ EVM Metadata: name=${metadata.name}, symbol=${metadata.symbol}`);
          }
          
          if (priceResponse.status === 'fulfilled') {
            priceData = priceResponse.value.data || {};
            console.log(`  ✓ EVM Price: usdPrice=${priceData.usdPrice}`);
          }
          
          if (pairsResponse.status === 'fulfilled' && pairsResponse.value.data) {
            pairsData = Array.isArray(pairsResponse.value.data) ? pairsResponse.value.data : [];
            console.log(`  ✓ EVM Pairs: ${pairsData.length} pairs found`);
          }
          
          if (analyticsResponse.status === 'fulfilled') {
            analytics = analyticsResponse.value.data || {};
            console.log(`  ✓ EVM Analytics: pricePercentChange.24h=${analytics.pricePercentChange?.['24h']}`);
          }
        } else {
          // Extract Solana data
          if (metadataResponse.status === 'fulfilled' && metadataResponse.value && metadataResponse.value.data) {
            metadata = metadataResponse.value.data || {};
            const responseUrl = metadataResponse.value.config?.url || '';
            // Determine if it's Pump.fun based on URL or source
            isPumpFun = responseUrl.includes('/pumpfun') || responseUrl.includes('pumpfun');
            console.log(`  ✓ Solana Metadata: name=${metadata.name}, symbol=${metadata.symbol}, source=${responseUrl}, isPumpFun=${isPumpFun}`);
            console.log(`     Full metadata keys:`, Object.keys(metadata));
            if (metadata.fullyDilutedValue !== undefined) {
              console.log(`     fullyDilutedValue: ${metadata.fullyDilutedValue}`);
            }
            if (metadata.totalSupply !== undefined) {
              console.log(`     totalSupply: ${metadata.totalSupply}`);
            }
          } else {
            console.log(`  ⚠ Solana Metadata: No metadata found from enhanced fetch`);
          }
          
          if (priceResponse.status === 'fulfilled') {
            priceData = priceResponse.value.data || {};
            const priceUrl = priceResponse.value.config?.url || '';
            if (priceUrl.includes('/pumpfun')) isPumpFun = true;
            console.log(`  ✓ Solana Price data:`, JSON.stringify(priceData, null, 2));
            console.log(`     usdPrice: ${priceData.usdPrice}, price: ${priceData.price}`);
            console.log(`     marketCap fields: usdMarketCap=${priceData.usdMarketCap}, marketCapUsd=${priceData.marketCapUsd}, marketCap=${priceData.marketCap}`);
            console.log(`     liquidity: ${priceData.liquidity}`);
            console.log(`     volume fields: volume24h=${priceData.volume24h}, volume_24h=${priceData.volume_24h}`);
          }
          
          if (analyticsResponse.status === 'fulfilled' && !isPumpFun) {
            analytics = analyticsResponse.value.data || {};
            console.log(`  ✓ Solana Analytics:`, JSON.stringify(analytics, null, 2));
          }
        }
        
        // Extract holder stats
        let holders = 0;
        let holderStats = null;
        if (holderStatsResponse.status === 'fulfilled') {
          if (isEVM) {
            holderStats = holderStatsResponse.value.data || {};
            holders = parseInt(holderStats.totalHolders || 0);
          } else {
            holderStats = holderStatsResponse.value.data || {};
            holders = parseInt(holderStats.totalHolders || 0);
          }
          console.log(`  ✓ Holder stats: ${holders} holders`);
        }
        
        // Extract RugCheck data (Solana only)
        let rugCheckData = null;
        if (!isEVM && rugCheckResponse.status === 'fulfilled' && rugCheckResponse.value.data && !rugCheckResponse.value.data.error) {
          rugCheckData = rugCheckResponse.value.data;
          console.log(`  ✓ RugCheck: score=${rugCheckData.report?.score_normalised || rugCheckData.report?.score || 'N/A'}`);
        }
        
        // Extract 24h price change
        let priceChange24h = 0;
        
        if (isEVM) {
          // EVM: prioritize analytics
          if (analytics.pricePercentChange && analytics.pricePercentChange['24h'] !== undefined) {
            priceChange24h = parseFloat(analytics.pricePercentChange['24h']);
          } else if (priceData['24hrPercentChange'] !== undefined) {
            priceChange24h = parseFloat(priceData['24hrPercentChange']);
          } else if (discoveryData && discoveryData.price_change_usd?.['24h']) {
            priceChange24h = parseFloat(discoveryData.price_change_usd['24h']);
          }
        } else {
          // Solana: For Pump.fun tokens, use their specific field
          if (isPumpFun && priceData.priceChange24h !== undefined) {
            priceChange24h = parseFloat(priceData.priceChange24h);
          } else if (isPumpFun && priceData.price24hChange !== undefined) {
            priceChange24h = parseFloat(priceData.price24hChange);
          }
          // For regular tokens, prioritize analytics
          else if (analytics.pricePercentChange && analytics.pricePercentChange['24h'] !== undefined) {
            priceChange24h = parseFloat(analytics.pricePercentChange['24h']);
          } else if (analytics.pricePercentChange && analytics.pricePercentChange['24hr'] !== undefined) {
            priceChange24h = parseFloat(analytics.pricePercentChange['24hr']);
          } else if (priceData['24hrPercentChange'] !== undefined) {
            priceChange24h = parseFloat(priceData['24hrPercentChange']);
          } else if (priceData.usdPriceChange24h !== undefined) {
            priceChange24h = parseFloat(priceData.usdPriceChange24h);
          }
        }
        
        console.log(`  📈 Final 24h change: ${priceChange24h}%`);
        
        // Extract market cap
        let marketCap = 0;
        if (isEVM) {
          // EVM: try discovery data first, then price data
          if (discoveryData && discoveryData.market_cap) {
            marketCap = parseFloat(discoveryData.market_cap);
          } else if (discoveryData && discoveryData.fully_diluted_valuation) {
            marketCap = parseFloat(discoveryData.fully_diluted_valuation);
          } else if (priceData && priceData.usdPrice) {
            // Fallback: calculate from price * supply (if we have decimals)
            const supply = discoveryData?.token_supply || 0;
            const decimals = discoveryData?.token_decimals || 18;
            if (supply > 0) {
              marketCap = parseFloat(priceData.usdPrice) * (supply / Math.pow(10, decimals));
            }
          }
        } else {
          // Solana: try metadata fullyDilutedValue first (most reliable for Solana)
          if (metadata.fullyDilutedValue !== undefined) {
            marketCap = parseFloat(metadata.fullyDilutedValue);
            console.log(`  💰 Using marketCap from metadata.fullyDilutedValue: $${marketCap}`);
          }
          // Then try Pump.fun specific fields
          else if (isPumpFun && priceData.marketCapUsd !== undefined) {
            marketCap = parseFloat(priceData.marketCapUsd);
            console.log(`  💰 Using marketCap from priceData.marketCapUsd (Pump.fun): $${marketCap}`);
          }
          // Then try other price data fields
          else if (priceData.usdMarketCap !== undefined) {
            marketCap = parseFloat(priceData.usdMarketCap);
            console.log(`  💰 Using marketCap from priceData.usdMarketCap: $${marketCap}`);
          } else if (priceData.marketCap !== undefined) {
            marketCap = parseFloat(priceData.marketCap);
            console.log(`  💰 Using marketCap from priceData.marketCap: $${marketCap}`);
          }
          // Last resort: calculate from price * supply if available
          else if (metadata.totalSupply && priceData.usdPrice) {
            const totalSupply = parseFloat(metadata.totalSupply) || 0;
            const decimals = parseInt(metadata.decimals || 9);
            const adjustedSupply = totalSupply / Math.pow(10, decimals);
            marketCap = parseFloat(priceData.usdPrice || priceData.price || 0) * adjustedSupply;
            console.log(`  💰 Calculated marketCap from price * supply: $${marketCap}`);
          }
        }
        
        // Extract volume and liquidity
        let volume24h = 0;
        let liquidity = 0;
        
        if (isEVM) {
          // EVM: aggregate from pairs
          if (pairsData && Array.isArray(pairsData) && pairsData.length > 0) {
            volume24h = pairsData.reduce((sum, pair) => sum + parseFloat(pair.total24hVolume || 0), 0);
            liquidity = pairsData.reduce((sum, pair) => sum + parseFloat(pair.totalLiquidity || 0), 0);
          }
          // Fallback to discovery data
          if (volume24h === 0 && discoveryData && discoveryData.volume_change_usd?.['24h']) {
            volume24h = Math.abs(parseFloat(discoveryData.volume_change_usd['24h']));
          }
          if (liquidity === 0 && discoveryData && discoveryData.liquidity) {
            liquidity = parseFloat(discoveryData.liquidity);
          }
        } else {
          // Solana: from price data or analytics
          volume24h = parseFloat(priceData.volume24h || priceData.volume_24h || priceData.volume || analytics.totalVolume?.['24h'] || analytics.volume24h || 0);
          liquidity = parseFloat(priceData.liquidity || priceData.liquidityUSD || 0);
          
          console.log(`  📊 Volume 24h: $${volume24h}, Liquidity: $${liquidity}`);
        }
        
        return {
          ...token,
          logo: metadata.logo || metadata.image || (discoveryData?.token_logo) || null,
          name: metadata.name || discoveryData?.token_name || token.pairLabel,
          symbol: metadata.symbol || discoveryData?.token_symbol || token.pairLabel,
          price: parseFloat(priceData.usdPrice || priceData.price || priceData.usd || discoveryData?.price_usd || 0),
          priceChange24h: priceChange24h,
          marketCap: marketCap,
          liquidity: liquidity,
          volume24h: volume24h,
          holders: holders,
          holderStats: holderStats,
          rugCheck: rugCheckData,
          isPumpFun: isPumpFun,
          chain: isEVM ? chain : 'solana'
        };
        
      } catch (error) {
        console.log(`❌ Could not enrich token ${token.tokenAddress}:`, error.message);
        return {
          ...token,
          logo: null,
          name: token.pairLabel,
          symbol: token.pairLabel,
          price: 0,
          priceChange24h: 0,
          marketCap: 0,
          liquidity: 0
        };
      }
    }));
    
    const response = {
      kols: results,
      topTokens: enrichedTokens,
      totalKOLs: TOP_KOLS.length,
      activeKOLs: results.filter(r => r.swaps.length > 0).length,
      checkedAt: new Date().toISOString()
    };
    
    // Cache for 2 minutes
    cache.set(cacheKey, response, 120);
    
    res.json(response);
    
  } catch (error) {
    console.error('❌ Error fetching KOL activity:', error.message);
    res.status(500).json({
      error: 'Failed to fetch KOL activity',
      message: error.message,
      kols: [],
      topTokens: []
    });
  }
});

// ===== AI Token Calls - Global State =====
const AI_CALLS_DB_PATH = path.join(__dirname, 'data', 'ai-token-calls.json');
const STOP_LOSS_THRESHOLD_PERCENT = -40;
const STOP_LOSS_MULTIPLIER = 1 + (STOP_LOSS_THRESHOLD_PERCENT / 100);
const TAKE_PROFIT_MULTIPLIER = 2;
const TAKE_PROFIT_PERCENT = 100;

// Ensure data directory exists and initialize AI calls storage
async function ensureAICallsStorage() {
  const dataDir = path.join(__dirname, 'data');
  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch (error) {
    // Directory already exists
  }
  
  // Initialize ai-token-calls.json if it doesn't exist
  try {
    await fs.access(AI_CALLS_DB_PATH);
  } catch {
    const initialData = {
      currentCall: null,
      callHistory: [],
      lastScanTime: null
    };
    await fs.writeFile(AI_CALLS_DB_PATH, JSON.stringify(initialData, null, 2));
  }
}

// Load AI token calls from file
async function loadAITokenCalls() {
  try {
    await ensureAICallsStorage();
    const data = await fs.readFile(AI_CALLS_DB_PATH, 'utf8');
    const loaded = JSON.parse(data);
    return {
      currentCall: loaded.currentCall || null,
      callHistory: loaded.callHistory || [],
      lastScanTime: loaded.lastScanTime || null,
      isScanning: false,
      autoScanInterval: null
    };
  } catch (error) {
    console.error('Error loading AI token calls:', error);
    return {
      currentCall: null,
      callHistory: [],
      lastScanTime: null,
      isScanning: false,
      autoScanInterval: null
    };
  }
}

// Save AI token calls to file
async function saveAITokenCalls() {
  try {
    await ensureAICallsStorage();
    const dataToSave = {
      currentCall: aiTokenCalls.currentCall,
      callHistory: aiTokenCalls.callHistory,
      lastScanTime: aiTokenCalls.lastScanTime
    };
    await fs.writeFile(AI_CALLS_DB_PATH, JSON.stringify(dataToSave, null, 2));
    console.log('💾 Saved AI token calls to file');
  } catch (error) {
    console.error('Error saving AI token calls:', error);
  }
}

let aiTokenCalls = {
  currentCall: null,
  callHistory: [],
  lastScanTime: null,
  isScanning: false,
  autoScanInterval: null // Store interval for hourly scans
};

// Load AI token calls on startup
(async () => {
  aiTokenCalls = await loadAITokenCalls();
  console.log(`📂 Loaded ${aiTokenCalls.callHistory.length} AI token calls from storage`);
})();

// ===== AI Token Calls API Endpoints =====
// Test route to verify endpoints are registered
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is running and endpoints are accessible', timestamp: new Date().toISOString() });
});
// API Endpoint: Get current AI Token Call (with updated price tracking)
app.get('/api/ai-token-calls/current', requireAuth, requireActiveSubscriptionAccess, async (req, res) => {
  try {
    console.log('📥 GET /api/ai-token-calls/current');
    
    // If we have a current call, update its price to track performance
    if (aiTokenCalls.currentCall && aiTokenCalls.currentCall.token) {
      const token = aiTokenCalls.currentCall.token;
      const tokenAddress = token.tokenAddress;
      
      try {
        // Fetch current price
        const priceRes = await axios.get(
          `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/price`,
          {
            headers: {
              'X-API-Key': CONFIG.moralisApiKey,
              'accept': 'application/json'
            },
            timeout: 5000
          }
        ).catch(() => {
          // Fallback to Pump.fun price
          return axios.get(
            `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/price/pumpfun`,
            {
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 5000
            }
          );
        });
        
        const currentPrice = parseFloat(priceRes.data?.usdPrice || priceRes.data?.price || token.priceUsd || 0);
        const initialPrice = token.initialPriceUsd || token.priceUsd || currentPrice;
        
        // Calculate performance metrics
        let priceChange = 0;
        let priceChangePercent = 0;
        let multiplier = 1;
        
        if (initialPrice > 0) {
          priceChange = currentPrice - initialPrice;
          priceChangePercent = ((currentPrice - initialPrice) / initialPrice) * 100;
          multiplier = currentPrice / initialPrice;
        }
        
        // Initialize peak values if they don't exist
        if (token.peakMultiplierSinceCall === undefined || token.peakMultiplierSinceCall === null) {
          token.peakMultiplierSinceCall = 1;
          token.peakPercentSinceCall = 0;
          token.peakPriceUsd = initialPrice;
          token.peakTimestamp = token.calledAt || new Date().toISOString();
        }
        
        // Track peak performance (highest multiplier and percentage)
        const existingPeakMultiplier = token.peakMultiplierSinceCall || 1;
        const existingPeakPercent = token.peakPercentSinceCall || 0;
        
        // Update peak if current is higher
        let needsSave = false;
        if (multiplier > existingPeakMultiplier) {
          token.peakMultiplierSinceCall = multiplier;
          token.peakPercentSinceCall = priceChangePercent;
          token.peakPriceUsd = currentPrice;
          token.peakTimestamp = new Date().toISOString();
          needsSave = true;
          console.log(`📈 New peak for ${token.name}: ${multiplier.toFixed(2)}x (${priceChangePercent.toFixed(2)}%)`);
        }
        
        const prevTakeProfit = !!token.takeProfitAchieved;
        const updatedPeakMultiplier = token.peakMultiplierSinceCall ?? existingPeakMultiplier;
        const updatedPeakPercent = token.peakPercentSinceCall ?? existingPeakPercent;
        const takeProfitAchieved = (updatedPeakMultiplier >= TAKE_PROFIT_MULTIPLIER) || (updatedPeakPercent >= TAKE_PROFIT_PERCENT);
        token.takeProfitAchieved = takeProfitAchieved;
        if (takeProfitAchieved && !prevTakeProfit) {
          needsSave = true;
        }
        
        const stopLossTriggered = !takeProfitAchieved && priceChangePercent <= STOP_LOSS_THRESHOLD_PERCENT;
        const alreadyStopped = !!token.stopLossTriggered;
        let stopLossTimestamp = null;
 
        if (alreadyStopped) {
          token.currentPriceUsd = currentPrice;
          token.lastPriceUpdate = new Date().toISOString();
          if (takeProfitAchieved) {
            token.stopLossTriggered = false;
            token.stopLossPercent = undefined;
            token.stopLossTriggeredAt = undefined;
            token.priceChangePercentSinceCall = token.peakPercentSinceCall ?? priceChangePercent;
            token.multiplierSinceCall = token.peakMultiplierSinceCall ?? multiplier;
            if (token.initialPriceUsd && token.multiplierSinceCall !== undefined) {
              token.priceChangeSinceCall = token.initialPriceUsd * (token.multiplierSinceCall - 1);
            }
          } else {
            token.priceChangePercentSinceCall = token.stopLossPercent ?? STOP_LOSS_THRESHOLD_PERCENT;
            token.multiplierSinceCall = STOP_LOSS_MULTIPLIER;
            if (token.initialPriceUsd) {
              token.priceChangeSinceCall = token.initialPriceUsd * (STOP_LOSS_MULTIPLIER - 1);
            }
          }
        } else if (stopLossTriggered) {
          stopLossTimestamp = new Date().toISOString();
          token.stopLossTriggered = true;
          token.stopLossPercent = STOP_LOSS_THRESHOLD_PERCENT;
          token.stopLossTriggeredAt = stopLossTimestamp;
          token.multiplierSinceCall = STOP_LOSS_MULTIPLIER;
          token.priceChangePercentSinceCall = STOP_LOSS_THRESHOLD_PERCENT;
          if (token.initialPriceUsd) {
            token.priceChangeSinceCall = token.initialPriceUsd * (STOP_LOSS_MULTIPLIER - 1);
          }

          console.log(`🛑 Stop loss triggered for ${token.name}: ${priceChangePercent.toFixed(2)}%`);
          aiTokenCalls.currentCall = null;
          needsSave = true;
        } else if (!stopLossTriggered) {
          token.stopLossTriggered = false;
          // Update token with current data (for reference, but use peak for display)
          token.currentPriceUsd = currentPrice;
          token.priceChangeSinceCall = priceChange;
          token.priceChangePercentSinceCall = priceChangePercent;
          token.multiplierSinceCall = multiplier;
          token.lastPriceUpdate = new Date().toISOString();
        }

        if (token.stopLossTriggered) {
          token.status = 'stop_loss_triggered';
        } else if (takeProfitAchieved) {
          token.status = 'take_profit';
        } else {
          token.status = 'active';
        }

        if (aiTokenCalls.currentCall && aiTokenCalls.currentCall.token?.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase()) {
          aiTokenCalls.currentCall.token = token;
          aiTokenCalls.currentCall.status = token.status;
          if (token.stopLossTriggered) {
            aiTokenCalls.currentCall.stoppedAt = token.stopLossTriggeredAt;
          }
        }

        aiTokenCalls.callHistory = aiTokenCalls.callHistory.map(historyCall => {
          if (historyCall.token?.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase()) {
            return {
              ...historyCall,
              status: token.status,
              stoppedAt: token.stopLossTriggered ? (historyCall.stoppedAt || token.stopLossTriggeredAt) : historyCall.stoppedAt,
              token: {
                ...historyCall.token,
                currentPriceUsd: token.currentPriceUsd,
                priceChangeSinceCall: token.priceChangeSinceCall,
                priceChangePercentSinceCall: token.priceChangePercentSinceCall,
                multiplierSinceCall: token.multiplierSinceCall,
                stopLossTriggered: token.stopLossTriggered,
                stopLossPercent: token.stopLossPercent,
                stopLossTriggeredAt: token.stopLossTriggeredAt,
                takeProfitAchieved: token.takeProfitAchieved,
                status: token.status,
                peakMultiplierSinceCall: token.peakMultiplierSinceCall,
                peakPercentSinceCall: token.peakPercentSinceCall,
                peakTimestamp: token.peakTimestamp,
                lastPriceUpdate: token.lastPriceUpdate
              }
            };
          }
          return historyCall;
        });

        // Save to file if data changed
        if (needsSave) {
          await saveAITokenCalls();
        }
      } catch (priceError) {
        console.error('Error updating price for current call:', priceError.message);
        // Continue with existing data
      }
    }
    
    res.json({
      currentCall: aiTokenCalls.currentCall,
      lastScanTime: aiTokenCalls.lastScanTime,
      isScanning: aiTokenCalls.isScanning,
      subscription: sanitizeSubscriptionForClient(req.subscription)
    });
  } catch (error) {
    console.error('Error in /api/ai-token-calls/current:', error);
    res.status(500).json({ error: error.message });
  }
});
// API Endpoint: Get call history (with updated performance metrics)
app.get('/api/ai-token-calls/history', requireAuth, requireActiveSubscriptionAccess, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    console.log(`📥 GET /api/ai-token-calls/history (limit: ${limit}) - Getting top ${limit} by performance`);
    
    // Update performance metrics for ALL historical calls (not just first N)
    // We need to check all calls to find the top performers
    let historyNeedsSave = false;
    const historyWithMetrics = await Promise.all(
      aiTokenCalls.callHistory.map(async (call) => {
        if (!call.token || !call.token.tokenAddress) {
          return call;
        }
        const alreadyStopped = call.status === 'stop_loss_triggered' || call.token?.stopLossTriggered;
        if (alreadyStopped) {
          call.token.stopLossPercent = call.token.stopLossPercent ?? STOP_LOSS_THRESHOLD_PERCENT;
          call.token.priceChangePercentSinceCall = call.token.stopLossPercent;
          call.token.multiplierSinceCall = STOP_LOSS_MULTIPLIER;
          if (call.token.initialPriceUsd) {
            call.token.priceChangeSinceCall = call.token.initialPriceUsd * (STOP_LOSS_MULTIPLIER - 1);
          }
          return call;
        }
        
        try {
          const tokenAddress = call.token.tokenAddress;
          
          // Fetch current price
          const priceRes = await axios.get(
            `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/price`,
            {
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 5000
            }
          ).catch(() => {
            // Fallback to Pump.fun price
            return axios.get(
              `https://solana-gateway.moralis.io/token/mainnet/${tokenAddress}/price/pumpfun`,
              {
                headers: {
                  'X-API-Key': CONFIG.moralisApiKey,
                  'accept': 'application/json'
                },
                timeout: 5000
              }
            );
          });
          
          const currentPrice = parseFloat(priceRes.data?.usdPrice || priceRes.data?.price || call.token.priceUsd || 0);
          const initialPrice = call.token.initialPriceUsd || call.token.priceUsd || currentPrice;
          
          // Calculate performance metrics
          let priceChange = 0;
          let priceChangePercent = 0;
          let multiplier = 1;
          
          if (initialPrice > 0) {
            priceChange = currentPrice - initialPrice;
            priceChangePercent = ((currentPrice - initialPrice) / initialPrice) * 100;
            multiplier = currentPrice / initialPrice;
          }
          
          // Initialize peak values if they don't exist
          if (call.token.peakMultiplierSinceCall === undefined || call.token.peakMultiplierSinceCall === null) {
            call.token.peakMultiplierSinceCall = 1;
            call.token.peakPercentSinceCall = 0;
            call.token.peakPriceUsd = initialPrice;
            call.token.peakTimestamp = call.calledAt || call.timestamp || new Date().toISOString();
          }
          
          // Track peak performance (highest multiplier and percentage)
          const existingPeakMultiplier = call.token.peakMultiplierSinceCall || 1;
          const existingPeakPercent = call.token.peakPercentSinceCall || 0;
          
          // Update peak if current is higher
          let peakUpdated = false;
          if (multiplier > existingPeakMultiplier) {
            call.token.peakMultiplierSinceCall = multiplier;
            call.token.peakPercentSinceCall = priceChangePercent;
            call.token.peakPriceUsd = currentPrice;
            call.token.peakTimestamp = new Date().toISOString();
            peakUpdated = true;
            console.log(`📈 New peak for ${call.token.name}: ${multiplier.toFixed(2)}x (${priceChangePercent.toFixed(2)}%)`);
          }
          
          // Update token with current data (for reference, but use peak for display)
          call.token.currentPriceUsd = currentPrice;
          call.token.priceChangeSinceCall = priceChange;
          call.token.priceChangePercentSinceCall = priceChangePercent;
          call.token.multiplierSinceCall = multiplier;
          call.token.lastPriceUpdate = new Date().toISOString();
          
          // Save to file if peak was updated
          if (peakUpdated) {
            await saveAITokenCalls();
          }

            const stopLossTriggered = priceChangePercent <= STOP_LOSS_THRESHOLD_PERCENT;
            if (stopLossTriggered) {
              const stopLossTimestamp = new Date().toISOString();
              call.status = 'stop_loss_triggered';
              call.stoppedAt = call.stoppedAt || stopLossTimestamp;
              call.token.stopLossTriggered = true;
              call.token.stopLossPercent = priceChangePercent;
              call.token.stopLossTriggeredAt = call.token.stopLossTriggeredAt || stopLossTimestamp;
              historyNeedsSave = true;
            } else if (!call.status) {
              call.status = 'active';
            }
        } catch (priceError) {
          console.error(`Error updating price for historical call ${call.token?.tokenAddress}:`, priceError.message);
          // Continue with existing data
        }
        
        return call;
      })
    );
    
    // Deduplicate by token address - keep only the call with highest peak performance
    const deduplicatedHistory = [];
    const tokenMap = new Map();
    
    historyWithMetrics.forEach(call => {
      if (!call.token || !call.token.tokenAddress) return;
      
      const tokenAddress = call.token.tokenAddress.toLowerCase();
      const peakPercent = call.token.peakPercentSinceCall || call.token.priceChangePercentSinceCall || -Infinity;
      
      if (!tokenMap.has(tokenAddress)) {
        // First time seeing this token
        tokenMap.set(tokenAddress, call);
      } else {
        // Compare with existing call - keep the one with higher peak
        const existingCall = tokenMap.get(tokenAddress);
        const existingPeakPercent = existingCall.token.peakPercentSinceCall || existingCall.token.priceChangePercentSinceCall || -Infinity;
        
        if (peakPercent > existingPeakPercent) {
          // This call has higher peak, replace it
          tokenMap.set(tokenAddress, call);
        }
      }
    });
    
    // Convert map back to array and sort by peak performance (highest first)
    const uniqueHistory = Array.from(tokenMap.values()).sort((a, b) => {
      const peakA = a.token.peakPercentSinceCall || a.token.priceChangePercentSinceCall || -Infinity;
      const peakB = b.token.peakPercentSinceCall || b.token.priceChangePercentSinceCall || -Infinity;
      return peakB - peakA; // Sort descending (highest first)
    });

    if (historyNeedsSave) {
      await saveAITokenCalls();
    }
    
    // Return top N by performance (not by time)
    res.json({
      history: uniqueHistory.slice(0, limit), // Top N by performance
      total: uniqueHistory.length,
      subscription: sanitizeSubscriptionForClient(req.subscription)
    });
  } catch (error) {
    console.error('Error in /api/ai-token-calls/history:', error);
    res.status(500).json({ error: error.message });
  }
});
// API Endpoint: Analyze Pump.fun graduated tokens and select the best ones
app.post('/api/ai-token-calls/scan', async (req, res) => {
  if (aiTokenCalls.isScanning) {
    return res.status(429).json({ error: 'Scan already in progress' });
  }

  if (!CONFIG.moralisApiKey) {
    return res.status(400).json({ error: 'Moralis API key not configured' });
  }

  try {
    aiTokenCalls.isScanning = true;
    console.log('🔍 Fetching and analyzing Pump.fun graduated tokens...');
    
    // Step 1: Fetch graduated tokens from Pump.fun
    const graduatedResponse = await axios.get(
      'https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/graduated',
      {
        params: { limit: 30 }, // Get more tokens to analyze
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        timeout: 30000
      }
    );

    if (!graduatedResponse.data?.result || !Array.isArray(graduatedResponse.data.result) || graduatedResponse.data.result.length === 0) {
      return res.json({
        success: false,
        message: 'No graduated tokens found from Pump.fun'
      });
    }

    const graduatedTokens = graduatedResponse.data.result;
    console.log(`✓ Found ${graduatedTokens.length} graduated tokens from Pump.fun`);

    // Step 2: Enrich tokens with additional data and score them
    const enrichedTokens = [];
    
    for (const token of graduatedTokens.slice(0, 20)) { // Analyze top 20
      try {
        const tokenAddress = token.tokenAddress || token.mint;
        if (!tokenAddress) {
          console.log(`⚠ Skipping token without address`);
          continue;
        }

        console.log(`📡 Analyzing token: ${token.name || tokenAddress.substring(0, 8)}...`);

        // Fetch additional data in parallel
        const [metadataRes, analyticsRes, holderRes] = await Promise.allSettled([
          fetchSolanaTokenMetadataEnhanced(tokenAddress),
          axios.get(
            `https://deep-index.moralis.io/api/v2.2/tokens/${tokenAddress}/analytics`,
            {
              params: { chain: 'solana' },
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 8000
            }
          ),
          axios.get(
            `https://solana-gateway.moralis.io/token/mainnet/holders/${tokenAddress}`,
            {
              headers: {
                'X-API-Key': CONFIG.moralisApiKey,
                'accept': 'application/json'
              },
              timeout: 8000
            }
          )
        ]);

        const metadata = metadataRes.status === 'fulfilled' ? metadataRes.value.data : null;
        const analytics = analyticsRes.status === 'fulfilled' ? analyticsRes.value.data : null;
        const holders = holderRes.status === 'fulfilled' ? holderRes.value.data : null;

        // RugCheck validation
        const rugCheck = await fetchRugCheckAnalysis(tokenAddress, { allowCached: true });
        if (!rugCheck.safe) {
          console.log(`  ⚠️ ${token.name || tokenAddress.substring(0, 6)} flagged by RugCheck (${rugCheck.status}${rugCheck.score !== null ? `, score ${rugCheck.score}` : ''}). Skipping.`);
          continue;
        }

        // Extract values - handle nested analytics structure
        const priceUsd = parseFloat(token.priceUsd || 0);
        const analyticsData = analytics?.analytics || analytics; // Handle nested structure
        const marketCap = parseFloat(
          token.marketCap || 
          analyticsData?.marketCap || 
          analytics?.marketCap || 
          0
        );
        const liquidity = parseFloat(
          token.liquidity || 
          analyticsData?.liquidity || 
          analytics?.liquidity || 
          0
        );
        const fdv = parseFloat(
          token.fdv || 
          analyticsData?.fdv || 
          analytics?.fdv || 
          0
        );
        const holderCount = holders?.holderCount || holders?.totalHolders || holders?.total || 0;
        const volume24h = analyticsData?.volume24h || analytics?.volume24h || 0;
        const priceChange24h = parseFloat(
          analyticsData?.pricePercentChange?.['24h'] || 
          analyticsData?.['24hrPercentChange'] || 
          analytics?.pricePercentChange?.['24h'] || 
          analytics?.['24hrPercentChange'] || 
          0
        );
        
        // Calculate score based on multiple factors - PRIORITIZE TOKENS THAT ARE ALREADY PERFORMING
        // Higher score = better token with proven momentum
        let score = 0;
        
        // PRICE CHANGE - MOST IMPORTANT: Prioritize tokens already showing positive momentum
        // This is the key indicator - if a token is already up, it's more likely to continue
        if (priceChange24h > 100) {
          score += 50; // Massive momentum - tokens like El Mert (+204%)
        } else if (priceChange24h > 50 && priceChange24h <= 100) {
          score += 40; // Strong momentum
        } else if (priceChange24h > 20 && priceChange24h <= 50) {
          score += 30; // Good momentum
        } else if (priceChange24h > 0 && priceChange24h <= 20) {
          score += 20; // Positive momentum
        } else if (priceChange24h < -50) {
          score -= 30; // Heavy penalty for tokens crashing (like The Cane -75%)
        } else if (priceChange24h < -20) {
          score -= 15; // Penalty for significant drops
        } else if (priceChange24h < 0) {
          score -= 5; // Small penalty for negative
        }
        
        // Market cap (sweet spot: $50k-$500k for tokens that are performing)
        // El Mert is at $196K - perfect range
        if (marketCap >= 50000 && marketCap <= 500000) {
          score += 25; // Perfect range - proven but still room to grow
        } else if (marketCap >= 20000 && marketCap < 50000) {
          score += 15; // Good range
        } else if (marketCap > 500000 && marketCap < 2000000) {
          score += 10; // Still good but larger
        } else if (marketCap < 20000) {
          score += 5; // Too small - higher risk
        }
        
        // Holder count (more holders = better, but prioritize tokens that are already performing)
        // El Mert has 715 holders - excellent
        if (holderCount >= 500) {
          score += 25; // Large community - proven interest
        } else if (holderCount >= 200 && holderCount < 500) {
          score += 20; // Good community
        } else if (holderCount >= 100 && holderCount < 200) {
          score += 15; // Growing community
        } else if (holderCount >= 50) {
          score += 10; // Minimum viable
        }
        
        // Volume (active trading = momentum indicator)
        // High volume = people are actually trading it
        const volumeToMarketCapRatio = marketCap > 0 ? (volume24h / marketCap) : 0;
        if (volume24h >= 50000) {
          score += 25; // Very high volume = strong interest
        } else if (volume24h >= 20000) {
          score += 20; // High volume
        } else if (volume24h >= 10000) {
          score += 15; // Good volume
        } else if (volumeToMarketCapRatio > 0.5) {
          score += 10; // High volume relative to market cap
        } else if (volume24h >= 5000) {
          score += 8; // Minimum volume
        }
        
        // Liquidity (enough liquidity to trade, but not too much = too established)
        if (liquidity >= 20000 && liquidity <= 100000) {
          score += 20; // Perfect liquidity range
        } else if (liquidity >= 10000 && liquidity < 20000) {
          score += 15; // Good liquidity
        } else if (liquidity >= 5000) {
          score += 10; // Minimum viable
        } else if (liquidity > 100000) {
          score += 5; // Too much liquidity = might be too established
        }
        
        // Recent graduation (newer = more potential, but prioritize performance over age)
        if (token.graduatedAt) {
          const gradDate = new Date(token.graduatedAt);
          const daysSinceGrad = (Date.now() - gradDate.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceGrad < 7) {
            score += 10; // Recent + performing = great combo
          } else if (daysSinceGrad < 14) {
            score += 5; // Still relatively new
          }
        }
        
        // Bonus: High holder-to-market-cap ratio (indicates organic growth)
        if (marketCap > 0 && holderCount > 0) {
          const holdersPer10k = (holderCount / marketCap) * 10000;
          if (holdersPer10k > 3) {
            score += 10; // High holder density = strong community
          } else if (holdersPer10k > 1.5) {
            score += 5; // Good holder density
          }
        }
        
        // BONUS: If token is already performing well, give extra points
        // This ensures we pick tokens like El Mert that are already flying
        if (priceChange24h > 50 && marketCap > 50000 && holderCount > 200) {
          score += 20; // Perfect combination: momentum + size + community
        }

        const tokenData = {
          tokenAddress: tokenAddress,
          name: metadata?.name || token.name || 'Unknown',
          symbol: metadata?.symbol || token.symbol || 'UNKNOWN',
          logo: metadata?.logo || token.logo || null,
          priceUsd: priceUsd,
          initialPriceUsd: priceUsd, // Store initial price for tracking
          marketCap: marketCap,
          liquidity: liquidity,
          holderCount: holderCount,
          priceChange24h: priceChange24h,
          volume24h: volume24h,
          fdv: fdv,
          score: score,
          graduatedAt: token.graduatedAt || null,
          calledAt: new Date().toISOString(), // Track when this token was called
          aiReason: `Graduated from Pump.fun | ${holderCount} holders | $${(liquidity/1000).toFixed(1)}k liquidity | RugCheck ${rugCheck.status} | Score: ${score.toFixed(1)}`,
          // Initialize peak performance tracking (starts at 1x, 0% since we just called it)
          peakMultiplierSinceCall: 1,
          peakPercentSinceCall: 0,
          peakPriceUsd: priceUsd,
          peakTimestamp: new Date().toISOString(),
          rugCheck
        };

        enrichedTokens.push(tokenData);
        console.log(`✓ Analyzed: ${tokenData.name} (${tokenData.symbol}) - Score: ${score.toFixed(1)}`);

      } catch (tokenError) {
        console.error(`❌ Error analyzing token ${token.tokenAddress}:`, tokenError.message);
        // Continue with other tokens
      }
    }

    if (enrichedTokens.length === 0) {
      return res.json({
        success: false,
        message: 'No valid token data could be analyzed'
      });
    }

    // Step 3: Sort by score and select ONLY the top 1-2 best tokens
    enrichedTokens.sort((a, b) => b.score - a.score);
    
    // Filter for tokens with high potential - PRIORITIZE TOKENS ALREADY PERFORMING
    const highPotentialTokens = enrichedTokens.filter(token => {
      // Must have minimum requirements, but prioritize positive momentum
      const hasEnoughHolders = token.holderCount >= 50; // At least 50 holders
      const hasLiquidity = token.liquidity >= 5000; // At least $5k liquidity
      const hasVolume = token.volume24h >= 5000; // At least $5k volume
      const reasonableMarketCap = token.marketCap >= 10000 && token.marketCap <= 5000000; // $10k - $5M sweet spot
      
      // Lower score threshold if token is already performing well
      const isPerforming = token.priceChange24h > 20; // Already up 20%+
      const goodScore = isPerforming ? token.score >= 50 : token.score >= 60; // Lower bar for performing tokens
      
      // Prefer tokens with positive momentum
      const hasPositiveMomentum = token.priceChange24h > 0;
      
      return hasEnoughHolders && hasLiquidity && hasVolume && reasonableMarketCap && goodScore && hasPositiveMomentum;
    });
    
    // Filter out the current call's token to avoid calling the same token again
    const currentCallAddress = aiTokenCalls.currentCall?.token?.tokenAddress?.toLowerCase();
    let filteredTokens = highPotentialTokens.length > 0 ? highPotentialTokens : enrichedTokens;
    
    if (currentCallAddress) {
      const beforeFilter = filteredTokens.length;
      filteredTokens = filteredTokens.filter(token => {
        const tokenAddress = token.tokenAddress?.toLowerCase();
        return tokenAddress !== currentCallAddress;
      });
      
      if (filteredTokens.length < beforeFilter) {
        console.log(`🔍 Filtered out current call token (${aiTokenCalls.currentCall?.token?.name || currentCallAddress}), ${filteredTokens.length} tokens remaining`);
      }
    }
    
    // Take only top tokens that meet criteria (excluding current call)
    const topTokens = filteredTokens.length > 0
      ? (filteredTokens.length >= 2 ? filteredTokens.slice(0, 2) : filteredTokens.slice(0, 1))
      : []; // No new tokens found

    if (topTokens.length === 0) {
      console.log(`⚠️ No new tokens found (current call token excluded or no tokens meet criteria)`);
      return res.json({
        success: false,
        message: 'No new tokens found. Current call token excluded to avoid duplicates.',
        currentCall: aiTokenCalls.currentCall
      });
    }

    console.log(`✓ Selected ${topTokens.length} best high-potential tokens (from ${enrichedTokens.length} analyzed, ${filteredTokens.length} after filtering)`);
    topTokens.forEach((token, idx) => {
      console.log(`   ${idx + 1}. ${token.name} (${token.symbol}) - Score: ${token.score.toFixed(1)} | Holders: ${token.holderCount} | MC: $${(token.marketCap/1000).toFixed(1)}k`);
    });

    // Store the best token as current call
    const bestToken = topTokens[0];
    const newCall = {
      token: bestToken,
      timestamp: new Date().toISOString(),
      calledAt: bestToken.calledAt || new Date().toISOString(),
      reason: bestToken.aiReason || 'AI selected best high-potential token'
    };

    console.log(`🎯 New AI Token Call: ${bestToken.name} (${bestToken.symbol}) - Replacing previous call`);
    aiTokenCalls.currentCall = newCall;
    
    // Add only top tokens to history (limit to 2)
    topTokens.forEach(token => {
      // Ensure peak values are initialized if not already set
      if (!token.peakMultiplierSinceCall) {
        token.peakMultiplierSinceCall = 1;
        token.peakPercentSinceCall = 0;
        token.peakPriceUsd = token.initialPriceUsd || token.priceUsd || 0;
        token.peakTimestamp = token.calledAt || new Date().toISOString();
      }
      
      const call = {
        token: token,
        timestamp: new Date().toISOString(),
        calledAt: token.calledAt || new Date().toISOString(),
        reason: token.aiReason || 'AI analyzed high-potential Pump.fun token'
      };
      aiTokenCalls.callHistory.unshift(call);
    });

    aiTokenCalls.lastScanTime = new Date().toISOString();
    
    // Save to file after adding new calls
    await saveAITokenCalls();

    res.json({
      success: true,
      tokens: topTokens,
      newCall,
      message: `Analyzed ${enrichedTokens.length} tokens and selected ${topTokens.length} best ones from Pump.fun`
    });

  } catch (error) {
    console.error('❌ Error in Pump.fun token analysis:', error.message);
    res.status(500).json({ 
      error: error.message,
      details: error.response?.data || 'Unknown error'
    });
  } finally {
    aiTokenCalls.isScanning = false;
  }
});

// API Endpoint: Get bonding tokens list
app.get('/api/ai-token-calls/bonding-tokens', requireAuth, requireActiveSubscriptionAccess, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const cursor = req.query.cursor || '';

    const response = await axios.get(
      'https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/bonding',
      {
        headers: {
          'X-API-Key': CONFIG.moralisApiKey,
          'accept': 'application/json'
        },
        params: {
          limit,
          ...(cursor && { cursor })
        },
        timeout: 30000
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching bonding tokens:', error.message);
    res.status(500).json({ error: error.message });
  }
});
// Initialize Moralis and start server
async function startServer() {
  // Log environment variables status on startup
  console.log('\n📋 Environment Check:');
  console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);
  console.log(`   MORALIS_API_KEY: ${CONFIG.moralisApiKey ? `${CONFIG.moralisApiKey.substring(0, 20)}...` : '❌ MISSING'}`);
  console.log(`   GEMINI_API_KEY: ${CONFIG.geminiApiKey ? '✓ Set' : '✗ Missing'}`);
  console.log(`   TWITTER_API_KEY: ${CONFIG.twitterApiKey ? '✓ Set' : '✗ Missing'}`);
  console.log(`   GROK_API_KEY: ${CONFIG.grokApiKey ? '✓ Set' : '✗ Missing'}`);
  console.log(`   PORT: ${CONFIG.port}`);
  
  try {
    await subscriptionService.initialize();
    console.log('🔑 Subscription service initialized');
  } catch (initError) {
    console.error('❌ Failed to initialize subscription service:', initError);
  }
  
  // ===== AI Token Calls - Background Scanning =====

  // Background scanning every 5 minutes
  setInterval(async () => {
    if (aiTokenCalls.isScanning) {
      console.log('⏭️ AI Token Calls scan already in progress, skipping...');
      return;
    }

    try {
      console.log('🔍 Starting background scan for AI Token Calls...');
      aiTokenCalls.isScanning = true;
      
      // Fetch bonding tokens
      const bondingResponse = await axios.get(
        'https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/bonding',
        {
          headers: {
            'X-API-Key': CONFIG.moralisApiKey,
            'accept': 'application/json'
          },
          params: {
            limit: 20
          },
          timeout: 30000
        }
      );

      if (bondingResponse.data?.result && bondingResponse.data.result.length > 0) {
        const tokens = bondingResponse.data.result;
        console.log(`📊 Found ${tokens.length} bonding tokens, analyzing...`);

        // Analyze tokens and choose best one
        const bestToken = await analyzeBondingTokens(tokens);
        
        if (bestToken) {
          const newCall = {
            token: bestToken,
            timestamp: new Date().toISOString(),
            reason: bestToken.aiReason || 'AI selected based on analysis'
          };

          aiTokenCalls.currentCall = newCall;
          aiTokenCalls.callHistory.unshift(newCall);
          aiTokenCalls.lastScanTime = new Date().toISOString();
          
          // Save to file after adding new call
          await saveAITokenCalls();
          
          console.log(`✅ New AI Token Call: ${bestToken.name} (${bestToken.symbol})`);
          console.log(`   Address: ${bestToken.tokenAddress}`);
          console.log(`   Bonding Progress: ${bestToken.bondingCurveProgress}%`);
        }
      }
    } catch (error) {
      console.error('❌ Error in background AI Token Calls scan:', error.message);
    } finally {
      aiTokenCalls.isScanning = false;
    }
  }, 5 * 60 * 1000); // 5 minutes

  // Function to analyze bonding tokens and choose the best one
  async function analyzeBondingTokens(tokens) {
    try {
      // Filter tokens with good metrics
      const filteredTokens = tokens.filter(token => {
        const progress = parseFloat(token.bondingCurveProgress || 0);
        const liquidity = parseFloat(token.liquidity || 0);
        const fdv = parseFloat(token.fullyDilutedValuation || 0);
        
        // Prefer tokens that are early on bonding curve (low progress) but have some liquidity
        return progress < 50 && liquidity > 100 && fdv > 1000;
      });

      if (filteredTokens.length === 0) {
        console.log('⚠️ No tokens passed initial filter');
        return null;
      }

      // Get additional data for top candidates
      const enrichedTokens = await Promise.all(
        filteredTokens.slice(0, 5).map(async (token) => {
          try {
            // Get holder count
            const holdersRes = await axios.get(
              `https://solana-gateway.moralis.io/token/mainnet/holders/${token.tokenAddress}`,
              {
                headers: { 'X-API-Key': CONFIG.moralisApiKey, 'accept': 'application/json' },
                timeout: 10000
              }
            );

            const holderCount = holdersRes.data?.total || 0;

            // Calculate score
            const progress = parseFloat(token.bondingCurveProgress || 0);
            const liquidity = parseFloat(token.liquidity || 0);
            const fdv = parseFloat(token.fullyDilutedValuation || 0);
            const priceUsd = parseFloat(token.priceUsd || 0);

            // RugCheck validation - skip tokens that are not safe/low-risk
            const rugCheck = await fetchRugCheckAnalysis(token.tokenAddress, { allowCached: true });
            if (!rugCheck.safe) {
              console.log(`  ⚠️ Skipping ${token.name || token.tokenAddress} due to RugCheck status "${rugCheck.status}" (score: ${rugCheck.score ?? 'N/A'})`);
              return null;
            }

            // Score: lower progress = better, more holders = better, reasonable liquidity
            const score = (100 - progress) * 0.4 + 
                        Math.min(holderCount / 100, 1) * 30 + 
                        Math.min(liquidity / 10000, 1) * 20 +
                        (priceUsd > 0 ? 10 : 0);

            return {
              ...token,
              holderCount,
              score,
              rugCheck,
              aiReason: `Early stage (${progress.toFixed(1)}% bonding), ${holderCount} holders, $${liquidity.toFixed(0)} liquidity | RugCheck ${rugCheck.status}`
            };
          } catch (error) {
            console.error(`Error enriching token ${token.tokenAddress}:`, error.message);
            return null;
          }
        })
      );

      const safeTokens = enrichedTokens.filter(Boolean);

      if (safeTokens.length === 0) {
        console.log('⚠️ No bonding tokens passed RugCheck safety filter');
        return null;
      }

      // Sort by score and return best
      safeTokens.sort((a, b) => b.score - a.score);
      return safeTokens[0] || null;

    } catch (error) {
      console.error('Error analyzing bonding tokens:', error.message);
      return null;
    }
  }
  
  if (!CONFIG.moralisApiKey) {
    console.error('\n❌ CRITICAL: MORALIS_API_KEY is not loaded!');
    console.error('   Please check your .env file exists and contains MORALIS_API_KEY');
    console.error('   File location: /var/www/yunarax402/.env');
    console.error('   After fixing, restart with: pm2 restart yunarax402\n');
  }
  
  try {
    if (CONFIG.moralisApiKey && !moralisInitialized) {
      console.log('🔄 Initializing Moralis SDK...');
      console.log('🔑 API Key loaded:', CONFIG.moralisApiKey ? `${CONFIG.moralisApiKey.substring(0, 20)}...` : 'MISSING');
      await Moralis.start({
        apiKey: CONFIG.moralisApiKey
      });
      moralisInitialized = true;
      console.log('✓ Moralis SDK initialized successfully');
    } else if (!CONFIG.moralisApiKey) {
      console.log('⚠ Moralis API key not configured - using REST API only');
      console.log('   ⚠ WARNING: Token loading will fail without MORALIS_API_KEY');
    }
  } catch (error) {
    console.error('❌ Moralis SDK initialization failed:', error.message);
    console.error('   Error type:', error.constructor.name);
    console.error('   Stack:', error.stack);
    console.log('   Falling back to REST API...');
  }

  // Set up automatic hourly AI Token Calls scan
  if (CONFIG.moralisApiKey) {
    console.log('⏰ Setting up automatic hourly AI Token Calls scan...');
    
    // Function to trigger automatic scan - calls the scan endpoint internally
    const triggerAutoScan = async () => {
      if (aiTokenCalls.isScanning) {
        console.log('⏭️ Auto-scan skipped: Manual scan in progress');
        return;
      }
      
      try {
        console.log('🔄 Starting automatic hourly AI Token Calls scan...');
        
        // Make internal request to scan endpoint
        const baseUrl = `http://localhost:${CONFIG.port}`;
        
        const response = await axios.post(`${baseUrl}/api/ai-token-calls/scan`, {}, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 60000
        });
        
        if (response.data?.success) {
          console.log(`✅ Auto-scan completed: ${response.data.message}`);
          if (response.data.newCall) {
            console.log(`   🎯 New call: ${response.data.newCall.token.name} (${response.data.newCall.token.symbol})`);
            console.log(`   📊 Address: ${response.data.newCall.token.tokenAddress}`);
          } else {
            console.log(`   ℹ️ Scan completed but no new call created`);
          }
        } else {
          console.log(`⚠️ Auto-scan completed but no tokens found: ${response.data?.message || 'Unknown'}`);
          if (response.data?.currentCall) {
            console.log(`   ℹ️ Current call still active: ${response.data.currentCall.token?.name || 'Unknown'}`);
          }
        }
      } catch (error) {
        console.error('❌ Error in automatic scan:', error.message);
      }
    };
    
    // Run immediately on startup (after 60 seconds to let server fully start)
    setTimeout(async () => {
      console.log('🚀 Running initial AI Token Calls scan...');
      await triggerAutoScan();
    }, 60000);
    
    // Then run every hour (3600000 ms)
    aiTokenCalls.autoScanInterval = setInterval(async () => {
      await triggerAutoScan();
    }, 60 * 60 * 1000); // 1 hour
    
    console.log('✅ Automatic hourly scan configured');
  }

  app.listen(CONFIG.port, () => {
    console.log(`\n🚀 Multi-Chain Launchpad Analyzer running on port ${CONFIG.port}`);
    console.log(`📊 Supported Launchpads:`);
    for (const [id, pad] of Object.entries(LAUNCHPADS)) {
      console.log(`   ${pad.emoji} ${pad.name} (${pad.chain.toUpperCase()})`);
    }
    console.log(`💳 x402 Payment Protocol: Enabled (USDC on Base)`);
    console.log(`💳 x402 Subscription Billing: Enabled (${ANALYSIS_CU_COST} CU per analysis)`);
    console.log(`🤖 AI Models: ${CONFIG.geminiApiKey ? 'Gemini ✓' : 'Gemini ✗'} | ${CONFIG.openaiApiKey ? 'ChatGPT ✓' : 'ChatGPT ✗'} | ${CONFIG.grokApiKey ? `Grok ✓ (${CONFIG.grokApiKey.substring(0, 10)}...)` : 'Grok ✗ (API KEY MISSING)'}`);
    if (!CONFIG.grokApiKey) {
      console.log(`   ⚠️ WARNING: GROK_API_KEY not found in environment variables!`);
      console.log(`   ⚠️ Add GROK_API_KEY=your_key_here to .env file to enable Grok Twitter insights`);
    }
    console.log(`🐦 Twitter API Key: ${CONFIG.twitterApiKey ? CONFIG.twitterApiKey.substring(0, 6) + '...' : '❌ MISSING'}`);
    console.log(`📡 API Mode: ${moralisInitialized ? 'Moralis SDK ✓' : 'REST API fallback'}`);
    if (!CONFIG.moralisApiKey) {
      console.log(`\n❌ CRITICAL ERROR: MORALIS_API_KEY is missing!`);
      console.log(`   Token loading will fail. Please check your .env file.`);
      console.log(`   Expected location: /var/www/yunarax402/.env`);
      console.log(`   After fixing, restart: pm2 restart yunarax402\n`);
    }
    console.log(`🧠 MCP Server: Available (run 'npm run mcp:server' to start)`);
    console.log(`\n✅ AI Token Calls endpoints registered:`);
    console.log(`   GET  /api/ai-token-calls/current (with price tracking)`);
    console.log(`   GET  /api/ai-token-calls/history`);
    console.log(`   POST /api/ai-token-calls/scan`);
    console.log(`   GET  /api/test (test endpoint)`);
    console.log(`\n⏰ Automatic hourly AI Token Calls scan: ${CONFIG.moralisApiKey ? 'Enabled' : 'Disabled (no API key)'}\n`);
  });
}
startServer();
