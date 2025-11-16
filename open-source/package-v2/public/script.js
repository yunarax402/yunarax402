// ===== Global State =====
let allTokens = [];
let launchpadData = {};  // New: Store launchpad-grouped data
let currentFilter = 'all';
let activeTwitterFeeds = []; // Store multiple Twitter feeds
let currentUser = null; // Authenticated user data
let userWallet = null; // User wallet info
let kolActivityMap = {}; // KOL activity map - initialized as empty object
let activeDashboard = 'landing';
let aiTokenCallsLoading = false; // Prevent duplicate loads
let aiTokenCallsSticky = false; // Locks dashboard against automatic switches
const AI_STOP_LOSS_THRESHOLD_PERCENT = -40;
let currentTokenDisplayMode = 'grouped'; // grouped (launchpad sections) vs flat list
let tokenFilterState = {
    volumeMin: null,
    marketCapMin: null,
    ageMaxDays: null
};

let tokenFilterDebounceTimeout = null;

const AI_TOKEN_DEFAULT_SUPPLY = 1_000_000_000;
const KOL_ACTIVITY_CACHE_MS = 2 * 60 * 1000;
let kolActivityLastFetched = 0;
let kolActivityFetchController = null;
let solanaDetailsAbortController = null;
let currentSubscription = null;
let subscriptionStatusLoaded = true; // Open-source: No subscription needed

function getDexScreenerEmbedUrl(baseUrl) {
    if (!baseUrl) return '';
    try {
        const url = new URL(baseUrl);
        url.searchParams.set('embed', url.searchParams.get('embed') || '1');
        url.searchParams.set('theme', url.searchParams.get('theme') || 'dark');
        url.searchParams.set('info', '0');
        url.searchParams.set('chart', '1');
        url.searchParams.set('trades', '1');
        return url.toString();
    } catch (error) {
        console.warn('DexScreener URL parse failed, falling back:', error);
        const separator = baseUrl.includes('?') ? '&' : '?';
        return `${baseUrl}${separator}embed=1&info=0&chart=1&trades=1`;
    }
}

const AI_TOKEN_PAYWALL_PREVIEW_TOKENS = [
    {
        address: 'preview1111111111111111111111111111111111111',
        chain: 'solana',
        name: 'NovaPulse',
        symbol: 'NOVA',
        price: 0.0024,
        priceChange24h: 128.42,
        marketCap: 458000,
        holders: 1284,
        launchpad: 'Pump.fun',
        calledAt: '2025-01-09T14:20:00Z',
        peakMultiplierSinceCall: 3.45,
        peakPercentSinceCall: 245.1,
        multiplierSinceCall: 2.18,
        priceChangePercentSinceCall: 118.2,
        status: 'take_profit',
        takeProfitAchieved: true,
        peakTimestamp: '2025-01-09T18:10:00Z',
        priceChangeSinceCall: 0.00148,
        initialPriceUsd: 0.00092,
        priceUsd: 0.0024
    },
    {
        address: 'preview2222222222222222222222222222222222222',
        chain: 'solana',
        name: 'SolSync',
        symbol: 'SYNC',
        price: 0.0011,
        priceChange24h: 62.37,
        marketCap: 312000,
        holders: 874,
        launchpad: 'Pump.fun',
        calledAt: '2025-01-08T11:05:00Z',
        peakMultiplierSinceCall: 2.62,
        peakPercentSinceCall: 162.4,
        multiplierSinceCall: 1.74,
        priceChangePercentSinceCall: 73.9,
        status: 'active',
        takeProfitAchieved: false,
        peakTimestamp: '2025-01-08T16:42:00Z',
        priceChangeSinceCall: 0.00048,
        initialPriceUsd: 0.00063,
        priceUsd: 0.0011
    },
    {
        address: 'preview3333333333333333333333333333333333333',
        chain: 'solana',
        name: 'ShieldWave',
        symbol: 'WAVE',
        price: 0.00042,
        priceChange24h: -12.8,
        marketCap: 92000,
        holders: 512,
        launchpad: 'Pump.fun',
        calledAt: '2025-01-07T09:40:00Z',
        stopLossTriggeredAt: '2025-01-07T15:12:00Z',
        stopLossPercent: -38.0,
        multiplierSinceCall: 0.62,
        priceChangePercentSinceCall: -38.0,
        status: 'stop_loss_triggered',
        takeProfitAchieved: false,
        peakMultiplierSinceCall: 1.45,
        peakPercentSinceCall: 45.3,
        priceChangeSinceCall: -0.00026,
        initialPriceUsd: 0.00068,
        priceUsd: 0.00042
    }
];

function isPaywallBypassed() {
    if (typeof window === 'undefined') return false;
    if (window.__AI_PAYWALL_BYPASS === true) return true;
    try {
        const params = new URLSearchParams(window.location.search);
        const unlockParam = params.get('unlock_ai');
        if (unlockParam === '0') {
            localStorage.removeItem('ai_paywall_bypass');
            return false;
        }
        if (unlockParam === '1') {
            localStorage.setItem('ai_paywall_bypass', 'true');
            return true;
        }
    } catch (error) {
        console.warn('Failed to parse unlock_ai parameter:', error);
    }
    try {
        return localStorage.getItem('ai_paywall_bypass') === 'true';
    } catch {
        return false;
    }
}

function createAbortController() {
    if (typeof AbortController !== 'function') {
        console.warn('AbortController is not supported in this environment. Falling back without abort capability.');
        return null;
    }
    try {
        return new AbortController();
    } catch (error) {
        console.warn('Failed to create AbortController. Falling back without abort capability.', error);
        return null;
    }
}

function hasSubscriptionAccess() {
    if (isPaywallBypassed()) return true;
    if (!currentUser) return false;
    if (!currentSubscription || currentSubscription.status !== 'active') return false;
    const remaining = Number(currentSubscription.cuBalance || 0);
    return Number.isFinite(remaining) && remaining > 0;
}

function determineSubscriptionLockReason() {
    // Open-source: No subscription locks - all features available
    return 'bypass';
}
    return 'subscription_required';
}

function handleAiPaywallPrimaryAction(reason = 'subscription_required') {
    // Open-source: No payment required - features always available
    if (!currentUser) {
        loginWithGoogle();
        return;
    }
    // No payment modal needed
}

function handleAiPaywallSecondaryAction() {
    if (!currentUser) {
        loginWithGoogle();
        return;
    }
    openWalletDashboard();
}

function setAiTokenPaywallState(active, reason = 'subscription_required') {
    const content = document.querySelector('.tokens-content-area');
    const overlay = document.getElementById('ai-token-paywall-overlay');
    if (!content || !overlay) return;

    const titleEl = document.getElementById('ai-paywall-title');
    const messageEl = document.getElementById('ai-paywall-message');
    const primaryBtn = document.getElementById('ai-paywall-primary');
    const secondaryBtn = document.getElementById('ai-paywall-secondary');

    if (active) {
        content.classList.add('ai-paywall-active');
        let effectiveReason = reason || determineSubscriptionLockReason();
        if (effectiveReason === 'subscription_required' && currentSubscription && currentSubscription.status === 'active') {
            const remaining = Number(currentSubscription.cuBalance || 0);
            if (!Number.isNaN(remaining) && remaining <= 0) {
                effectiveReason = 'insufficient_cu';
            }
        }

        let titleText = 'Unlock AI Token Calls';
        let messageText = 'Subscribe to view live AI token calls and automated notifications.';
        let primaryText = currentUser ? 'View Plans' : 'Login with Google';
        let secondaryText = 'Manage Subscription';
        let showSecondary = !!currentUser;

        if (!currentUser || effectiveReason === 'login') {
            titleText = 'Login to Unlock AI Signals';
            messageText = 'Sign in with Google to choose a subscription plan and unlock live AI calls.';
            primaryText = 'Login with Google';
            showSecondary = false;
        } else if (effectiveReason === 'insufficient_cu') {
            titleText = 'Out of Compute Units';
            messageText = 'Add more compute units to keep receiving AI token calls and alerts.';
            primaryText = 'Add Compute Units';
            secondaryText = 'Manage Subscription';
            showSecondary = true;
        } else {
            titleText = 'Activate an AI Plan';
            messageText = 'Choose a subscription to access AI token calls, live alerts, and trading performance dashboards.';
            primaryText = 'View Plans';
            secondaryText = 'Manage Subscription';
            showSecondary = true;
        }

        if (titleEl) {
            titleEl.textContent = titleText;
        }
        if (messageEl) {
            messageEl.textContent = messageText;
        }
        if (primaryBtn) {
            primaryBtn.textContent = primaryText;
            primaryBtn.onclick = () => handleAiPaywallPrimaryAction(effectiveReason);
        }
        if (secondaryBtn) {
            if (showSecondary) {
                secondaryBtn.style.display = 'inline-flex';
                secondaryBtn.textContent = secondaryText;
                secondaryBtn.onclick = () => handleAiPaywallSecondaryAction(effectiveReason);
            } else {
                secondaryBtn.style.display = 'none';
                secondaryBtn.onclick = null;
            }
        }
    } else {
        content.classList.remove('ai-paywall-active');
        if (primaryBtn) {
            primaryBtn.onclick = null;
        }
        if (secondaryBtn) {
            secondaryBtn.onclick = null;
        }
    }
}

function renderAiTokenPaywallPreview(reason = 'subscription_required') {
    const spinner = document.getElementById('loading-spinner');
    const grid = document.getElementById('tokens-grid');
    const emptyState = document.getElementById('empty-state');
    if (spinner) spinner.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';
    if (!grid) return;

    setAiTokenPaywallState(true, reason);

    grid.style.display = 'grid';
    grid.innerHTML = '';

    const summary = computeAiTradingPerformance(AI_TOKEN_PAYWALL_PREVIEW_TOKENS);
    const summaryCard = createAiCallPerformanceSummaryCard(summary, AI_TOKEN_PAYWALL_PREVIEW_TOKENS.slice(0, 3));
    if (summaryCard) {
        summaryCard.classList.add('ai-call-preview-card');
        grid.appendChild(summaryCard);
    }

    AI_TOKEN_PAYWALL_PREVIEW_TOKENS.forEach(token => {
        const card = createAICallHistoryCard(token);
        card.classList.add('ai-call-history-card-preview');
        grid.appendChild(card);
    });

    const callHistoryList = document.getElementById('call-history-list');
    if (callHistoryList) {
        callHistoryList.innerHTML = `
            <div class="call-history-locked">
                <i class='bx bx-lock-alt'></i>
                <p>Subscribe to unlock live AI notifications and detailed call history.</p>
            </div>
        `;
    }
}

function updatePaywallState(reason = null) {
    if (activeDashboard !== 'ai-token-calls') {
        setAiTokenPaywallState(false);
        return;
    }
    if (isPaywallBypassed()) {
        setAiTokenPaywallState(false);
        return;
    }
    if (hasSubscriptionAccess()) {
        setAiTokenPaywallState(false);
        return;
    }
    const lockReason = reason || determineSubscriptionLockReason();
    renderAiTokenPaywallPreview(lockReason);
}

async function loadSubscriptionStatus(force = false) {
    if (isPaywallBypassed()) {
        subscriptionStatusLoaded = true;
        updateNotificationAccess();
        setAiTokenPaywallState(false);
        return currentSubscription;
    }
    if (!currentUser) {
        currentSubscription = null;
        subscriptionStatusLoaded = true;
        updateNotificationAccess();
        updatePaywallState();
        return null;
    }

    if (!force && subscriptionStatusLoaded) {
        updateNotificationAccess();
        updatePaywallState();
        return currentSubscription;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/subscriptions/status`, {
            credentials: 'include',
            cache: 'no-store'
        });
        if (response.ok) {
            const data = await response.json();
            currentSubscription = data.subscription || null;
        } else if (response.status === 401) {
            currentSubscription = null;
        } else {
            const errorData = await response.json().catch(() => ({}));
            console.warn('Subscription status unavailable:', errorData);
        }
    } catch (error) {
        console.warn('Failed to load subscription status:', error);
    } finally {
        subscriptionStatusLoaded = true;
        updateNotificationAccess();
        updatePaywallState();
    }

    return currentSubscription;
}

async function ensureSubscriptionStatus(force = false) {
    if (isPaywallBypassed()) {
        subscriptionStatusLoaded = true;
        updateNotificationAccess();
        setAiTokenPaywallState(false);
        return currentSubscription;
    }
    if (!currentUser) {
        subscriptionStatusLoaded = true;
        currentSubscription = null;
        updateNotificationAccess();
        updatePaywallState();
        return null;
    }
    if (subscriptionStatusLoaded && !force) {
        return currentSubscription;
    }
    return await loadSubscriptionStatus(force);
}

function stopNotificationPolling() {
    if (notificationCenter.pollInterval) {
        clearInterval(notificationCenter.pollInterval);
        notificationCenter.pollInterval = null;
    }
}

function updateNotificationAccess() {
    const toggleButton = notificationCenter.toggleButton;
    if (!toggleButton) return;

    if (hasSubscriptionAccess()) {
        toggleButton.classList.remove('notifications-locked');
        toggleButton.disabled = false;
        toggleButton.title = 'AI Notifications';
        if (notificationCenter.initialized) {
            startNotificationPolling();
        }
    } else {
        toggleButton.classList.add('notifications-locked');
        toggleButton.disabled = false;
        toggleButton.title = 'Subscribe to unlock AI notifications';
        stopNotificationPolling();
    }
}

// ===== Notification Center State =====
const NOTIFICATION_STORAGE_KEY = 'yunara_notifications_v1';
const NOTIFICATION_KNOWN_CALLS_KEY = 'yunara_known_call_ids_v1';
const NOTIFICATION_MAX_ITEMS = 50;

const notificationCenter = {
    items: [],
    knownCallIds: new Set(),
    unseenCount: 0,
    toggleButton: null,
    badgeEl: null,
    panelEl: null,
    listEl: null,
    emptyEl: null,
    clearBtn: null,
    closeBtn: null,
    backdropEl: null,
    audioContext: null,
    pollInterval: null,
    initialized: false,
    seedComplete: false
};

function normalizeNotificationPermission() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
}

function requestBrowserNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
        try {
            Notification.requestPermission().catch(() => {});
        } catch (err) {
            console.warn('Notification permission request failed:', err);
        }
    }
}

function playNotificationTone() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        if (!notificationCenter.audioContext) {
            notificationCenter.audioContext = new AudioContext();
        }
        const ctx = notificationCenter.audioContext;
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.45);
    } catch (err) {
        console.warn('Notification sound failed:', err);
    }
}

function showSystemNotification(notification) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
        try {
            const icon = notification.icon || `${window.location.origin}/logobrain.png`;
            const body = notification.body || '';
            const tag = notification.id || `notif-${Date.now()}`;
            const data = {
                url: notification.url || window.location.href,
                tokenAddress: notification.tokenAddress || null
            };
            new Notification(notification.title || 'Yunara Alert', {
                body,
                icon,
                badge: icon,
                tag,
                timestamp: notification.timestamp || Date.now(),
                data,
                requireInteraction: false
            });
        } catch (err) {
            console.warn('System notification failed:', err);
        }
    } else if (Notification.permission === 'default') {
        // Attempt to request permission the first time we need it
        requestBrowserNotificationPermission();
    }
}

function saveNotificationState() {
    try {
        const toStore = notificationCenter.items.map(item => ({
            ...item,
            // Ensure no functions stored
            onClick: undefined
        }));
        localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(toStore));
    } catch (err) {
        console.warn('Failed to persist notifications:', err);
    }
}

function saveKnownCallIds() {
    try {
        const ids = Array.from(notificationCenter.knownCallIds);
        localStorage.setItem(NOTIFICATION_KNOWN_CALLS_KEY, JSON.stringify(ids));
    } catch (err) {
        console.warn('Failed to persist known call ids:', err);
    }
}

function loadNotificationState() {
    try {
        const stored = JSON.parse(localStorage.getItem(NOTIFICATION_STORAGE_KEY) || '[]');
        if (Array.isArray(stored)) {
            notificationCenter.items = stored.map(item => ({
                ...item,
                seen: Boolean(item.seen),
                timestamp: item.timestamp || Date.now()
            }));
        }
    } catch (err) {
        notificationCenter.items = [];
    }
    try {
        const storedIds = JSON.parse(localStorage.getItem(NOTIFICATION_KNOWN_CALLS_KEY) || '[]');
        if (Array.isArray(storedIds)) {
            notificationCenter.knownCallIds = new Set(storedIds);
        }
    } catch (err) {
        notificationCenter.knownCallIds = new Set();
    }
    notificationCenter.unseenCount = notificationCenter.items.filter(item => !item.seen).length;
}

function updateNotificationBadge() {
    if (!notificationCenter.badgeEl) return;
    if (notificationCenter.unseenCount > 0) {
        notificationCenter.badgeEl.textContent = notificationCenter.unseenCount > 99 ? '99+' : `${notificationCenter.unseenCount}`;
        notificationCenter.badgeEl.style.display = 'flex';
    } else {
        notificationCenter.badgeEl.style.display = 'none';
    }
}

function formatNotificationTimestamp(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return 'Just now';
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffMinutes = Math.floor(diffMs / (60 * 1000));
    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes} min ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} hr${diffHours === 1 ? '' : 's'} ago`;
    return date.toLocaleString();
}

function renderNotificationsList() {
    if (!notificationCenter.listEl || !notificationCenter.emptyEl) return;
    notificationCenter.listEl.innerHTML = '';
    if (!notificationCenter.items.length) {
        notificationCenter.emptyEl.style.display = 'flex';
        return;
    }
    notificationCenter.emptyEl.style.display = 'none';
    notificationCenter.items.forEach((item, index) => {
        const entry = document.createElement('button');
        entry.className = `notification-item ${item.seen ? 'seen' : 'unseen'}`;
        entry.type = 'button';
        entry.dataset.notificationId = item.id || `notif-${index}`;
        entry.innerHTML = `
            <div class="notification-item-header">
                <div class="notification-item-title">${item.title || 'Alert'}</div>
                <time class="notification-item-time">${formatNotificationTimestamp(item.timestamp)}</time>
            </div>
            <div class="notification-item-body">${item.body || ''}</div>
            ${item.meta ? `<div class="notification-item-meta">${item.meta}</div>` : ''}
        `;
        entry.addEventListener('click', () => {
            handleNotificationClick(item);
        });
        notificationCenter.listEl.appendChild(entry);
    });
}

function markNotificationsAsSeen() {
    if (!notificationCenter.items.length) return;
    let updated = false;
    notificationCenter.items = notificationCenter.items.map(item => {
        if (!item.seen) {
            updated = true;
            return { ...item, seen: true };
        }
        return item;
    });
    if (updated) {
        notificationCenter.unseenCount = 0;
        saveNotificationState();
        renderNotificationsList();
        updateNotificationBadge();
    } else {
        notificationCenter.unseenCount = 0;
        updateNotificationBadge();
    }
}

function clearAllNotifications() {
    notificationCenter.items = [];
    notificationCenter.unseenCount = 0;
    saveNotificationState();
    renderNotificationsList();
    updateNotificationBadge();
}

function toggleNotificationsPanel(forceState = null) {
    if (!notificationCenter.panelEl) return;
    const isOpen = notificationCenter.panelEl.classList.contains('open');
    const shouldOpen = forceState !== null ? forceState : !isOpen;
    if (shouldOpen) {
        if (!hasSubscriptionAccess()) {
            showToast('Subscribe to unlock AI call notifications.', 'warning');
            updatePaywallState(determineSubscriptionLockReason());
            if (activeDashboard !== 'ai-token-calls') {
                openAITokenCalls();
            }
            return;
        }
        notificationCenter.panelEl.classList.add('open');
        if (notificationCenter.backdropEl) {
            notificationCenter.backdropEl.classList.add('visible');
        }
        markNotificationsAsSeen();
        if (normalizeNotificationPermission() === 'default') {
            requestBrowserNotificationPermission();
        }
    } else {
        notificationCenter.panelEl.classList.remove('open');
        if (notificationCenter.backdropEl) {
            notificationCenter.backdropEl.classList.remove('visible');
        }
    }
}

function addNotificationEntry(notification) {
    if (!notification) return;
    const entry = {
        id: notification.id || `notif-${Date.now()}`,
        title: notification.title || 'New Alert',
        body: notification.body || '',
        meta: notification.meta || '',
        timestamp: notification.timestamp || Date.now(),
        tokenAddress: notification.tokenAddress || null,
        seen: false
    };
    notificationCenter.items.unshift(entry);
    if (notificationCenter.items.length > NOTIFICATION_MAX_ITEMS) {
        notificationCenter.items = notificationCenter.items.slice(0, NOTIFICATION_MAX_ITEMS);
    }
    notificationCenter.unseenCount += 1;
    saveNotificationState();
    renderNotificationsList();
    updateNotificationBadge();
    playNotificationTone();
    showSystemNotification(entry);
}

function handleNotificationClick(notification) {
    toggleNotificationsPanel(false);
    if (!notification || !notification.tokenAddress) return;
    const address = notification.tokenAddress.toLowerCase();
    setTimeout(async () => {
        try {
            await openAITokenCalls(false);
            setTimeout(() => {
                const card = document.querySelector(`.ai-call-history-card[data-token-address="${address}"]`);
                if (card) {
                    card.classList.add('notification-highlight');
                    card.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center'
                    });
                    setTimeout(() => {
                        card.classList.remove('notification-highlight');
                    }, 2800);
                }
            }, 500);
        } catch (err) {
            console.warn('Failed to navigate to AI token call from notification:', err);
        }
    }, 60);
}

function initializeNotificationCenter() {
    if (notificationCenter.initialized) return;
    loadNotificationState();
    
    notificationCenter.toggleButton = document.getElementById('notifications-toggle');
    notificationCenter.badgeEl = document.getElementById('notifications-count');
    notificationCenter.panelEl = document.getElementById('notifications-panel');
    notificationCenter.listEl = document.getElementById('notifications-list');
    notificationCenter.emptyEl = document.getElementById('notifications-empty');
    notificationCenter.clearBtn = document.getElementById('notifications-clear');
    notificationCenter.backdropEl = document.getElementById('notifications-backdrop');
    
    if (!notificationCenter.toggleButton || !notificationCenter.panelEl) {
        console.warn('Notification UI elements missing, skipping initialization.');
        return;
    }
    
    renderNotificationsList();
    updateNotificationBadge();
    
    notificationCenter.toggleButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleNotificationsPanel();
    });
    
    if (notificationCenter.clearBtn) {
        notificationCenter.clearBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            clearAllNotifications();
        });
    }
    
    document.addEventListener('click', (event) => {
        if (!notificationCenter.panelEl) return;
        const withinPanel = notificationCenter.panelEl.contains(event.target);
        const withinButton = notificationCenter.toggleButton.contains(event.target);
        if (!withinPanel && !withinButton) {
            toggleNotificationsPanel(false);
        }
    });
    
    if (notificationCenter.backdropEl) {
        notificationCenter.backdropEl.addEventListener('click', () => toggleNotificationsPanel(false));
    }
    
    notificationCenter.initialized = true;
    updateNotificationAccess();
}

function startNotificationPolling() {
    if (!notificationCenter.initialized) return;
    if (notificationCenter.pollInterval) return;
    if (!hasSubscriptionAccess()) {
        stopNotificationPolling();
        return;
    }

    const pollFrequencyMs = 60 * 1000; // 60 seconds
    
    const poll = async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/api/ai-token-calls/current`, {
                credentials: 'include',
                cache: 'no-store'
            });

            if (response.status === 401) {
                stopNotificationPolling();
                updateNotificationAccess();
                return;
            }

            if (response.status === 402) {
                const data = await response.json().catch(() => ({}));
                if (data?.subscription) {
                    currentSubscription = data.subscription;
                    subscriptionStatusLoaded = true;
                }
                stopNotificationPolling();
                updateNotificationAccess();
                if (activeDashboard === 'ai-token-calls') {
                    updatePaywallState(data?.error || 'subscription_required');
                }
                return;
            }

            if (!response.ok) {
                return;
            }

            const data = await response.json();
            if (data?.subscription) {
                currentSubscription = data.subscription;
                subscriptionStatusLoaded = true;
                updateNotificationAccess();
            }
            if (data?.currentCall) {
                const normalized = normalizeAiCall(data.currentCall);
                if (normalized && normalized.notificationId) {
                    registerCallForNotifications(normalized.notificationId, normalized, notificationCenter.seedComplete);
                    notificationCenter.seedComplete = true;
                }
            }
        } catch (err) {
            console.warn('Notification polling failed:', err);
        }
    };
    
    poll(); // initial call
    notificationCenter.pollInterval = setInterval(poll, pollFrequencyMs);
}

function buildCallNotificationId(call, token, calledAt) {
    const address = (token?.tokenAddress || token?.address || call?.token?.tokenAddress || call?.tokenAddress || '').toLowerCase();
    if (!address) return null;
    const baseTimestamp = calledAt || call?.calledAt || call?.timestamp || call?.createdAt || call?.id || call?._id || '';
    const safeTimestamp = baseTimestamp ? String(baseTimestamp) : `${Date.now()}`;
    return `${address}-${safeTimestamp}`;
}

function composeNotificationPayloadFromToken(token, callId) {
    const title = `New AI Token Call: ${token.name || 'Unknown'}`;
    const price = Number(token.price) || 0;
    const priceText = price > 0 ? `$${price.toFixed(price >= 1 ? 2 : 6)}` : 'price unavailable';
    const body = `${token.symbol || token.name || 'Token'} on ${token.launchpad || 'launchpad'} · ${priceText}`;
    const meta = token.calledAt ? new Date(token.calledAt).toLocaleString() : null;
    const url = `${window.location.origin}/#ai-token-calls`;
    return {
        id: callId,
        title,
        body,
        meta,
        timestamp: Date.now(),
        tokenAddress: token.address || token.tokenAddress || null,
        url
    };
}

function registerCallForNotifications(callId, token, shouldNotify = notificationCenter.seedComplete) {
    if (!callId || !token) return;
    if (!notificationCenter.knownCallIds.has(callId)) {
        notificationCenter.knownCallIds.add(callId);
        saveKnownCallIds();
        if (shouldNotify) {
            const payload = composeNotificationPayloadFromToken(token, callId);
            addNotificationEntry(payload);
            if (typeof showToast === 'function') {
                showToast(`New AI token call detected: ${token.name || token.symbol || 'Token'}`, 'info');
            }
        }
    }
}

function computeAiMarketCap(rawMarketCap, price) {
    const directCap = Number(rawMarketCap);
    if (Number.isFinite(directCap) && directCap > 0) {
        return directCap;
    }
    const priceValue = Number(price);
    if (Number.isFinite(priceValue) && priceValue > 0) {
        return priceValue * AI_TOKEN_DEFAULT_SUPPLY;
    }
    return 0;
}

function parseNumericAmount(rawValue) {
    if (rawValue === null || rawValue === undefined) return null;
    const stringValue = String(rawValue).trim();
    if (stringValue === '') return null;

    const normalized = stringValue.replace(/,/g, '').toLowerCase();
    const suffix = normalized.slice(-1);
    const suffixMultipliers = {
        k: 1_000,
        m: 1_000_000,
        b: 1_000_000_000
    };

    let baseValue = normalized;
    let multiplier = 1;

    if (suffixMultipliers[suffix]) {
        multiplier = suffixMultipliers[suffix];
        baseValue = normalized.slice(0, -1);
    }

    const numeric = Number.parseFloat(baseValue);
    if (Number.isNaN(numeric)) {
        return null;
    }

    return numeric * multiplier;
}

function formatFilterNumber(value) {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return '';
    }

    const formatWithSuffix = (num, divisor, suffix) => {
        const formatted = (num / divisor).toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });
        return `${formatted}${suffix}`;
    };

    const absValue = Math.abs(value);
    if (absValue >= 1_000_000_000) {
        return formatWithSuffix(value, 1_000_000_000, 'B');
    }
    if (absValue >= 1_000_000) {
        return formatWithSuffix(value, 1_000_000, 'M');
    }
    if (absValue >= 1_000) {
        return formatWithSuffix(value, 1_000, 'K');
    }
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function scheduleTokenFilterRefresh() {
    if (tokenFilterDebounceTimeout) {
        clearTimeout(tokenFilterDebounceTimeout);
    }
    tokenFilterDebounceTimeout = setTimeout(() => {
        tokenFilterDebounceTimeout = null;
        refreshTokensView();
    }, 220);
}

function setFilterCardActiveState(filterKey, hasValue) {
    const card = document.querySelector(`.token-filter-card[data-filter-key="${filterKey}"]`);
    if (!card) return;
    if (hasValue) {
        card.classList.add('active');
    } else {
        card.classList.remove('active');
    }
}

function handleFilterInput(filterKey, rawValue) {
    if (!Object.prototype.hasOwnProperty.call(tokenFilterState, filterKey)) {
        return;
    }

    let parsedValue = null;

    if (filterKey === 'ageMaxDays') {
        const normalized = String(rawValue ?? '').trim().toLowerCase().replace(/,/g, '');
        if (normalized === '') {
            parsedValue = null;
        } else {
            const ageValue = Number.parseFloat(normalized);
            parsedValue = !Number.isNaN(ageValue) && ageValue > 0 ? ageValue : null;
        }
    } else {
        parsedValue = parseNumericAmount(rawValue);
        if (parsedValue !== null && parsedValue < 0) {
            parsedValue = null;
        }
    }

    tokenFilterState[filterKey] = parsedValue;
    setFilterCardActiveState(filterKey, parsedValue !== null);
    scheduleTokenFilterRefresh();
}

function prepareFilterInputEdit(input, filterKey) {
    if (!input) return;
    const value = tokenFilterState[filterKey];
    if (value === null || value === undefined || Number.isNaN(value)) {
        input.value = '';
        return;
    }
    input.value = `${value}`;
    input.select();
}

function formatFilterInputDisplay(input, filterKey, displayType = 'currency') {
    if (!input) return;
    const value = tokenFilterState[filterKey];
    if (value === null || value === undefined || Number.isNaN(value)) {
        input.value = '';
        return;
    }

    if (displayType === 'days') {
        input.value = `${value}`;
    } else {
        input.value = formatFilterNumber(value);
    }
}

let starfieldInitialized = false;
function initInteractiveStarfield() {
    if (starfieldInitialized) return;

    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hasCoarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const root = document.documentElement;

    if (prefersReducedMotion || hasCoarsePointer) {
        // Disable animation for reduced motion users or touch-first devices to avoid jank
        root.style.setProperty('--star-parallax-x', '0px');
        root.style.setProperty('--star-parallax-y', '0px');
        root.style.setProperty('--star-parallax-x2', '0px');
        root.style.setProperty('--star-parallax-y2', '0px');
        starfieldInitialized = true;
        return;
    }

    starfieldInitialized = true;
    
    let targetX = 0;
    let targetY = 0;
    let targetX2 = 0;
    let targetY2 = 0;
    let currentX = 0;
    let currentY = 0;
    let currentX2 = 0;
    let currentY2 = 0;
    let animationFrameId = null;
    let lastPointerMovement = 0;
    const idleTimeoutMs = 1500;
    const dampen = 0.08;

    function step() {
        currentX += (targetX - currentX) * dampen;
        currentY += (targetY - currentY) * dampen;
        currentX2 += (targetX2 - currentX2) * dampen;
        currentY2 += (targetY2 - currentY2) * dampen;
        
        root.style.setProperty('--star-parallax-x', `${currentX}px`);
        root.style.setProperty('--star-parallax-y', `${currentY}px`);
        root.style.setProperty('--star-parallax-x2', `${currentX2}px`);
        root.style.setProperty('--star-parallax-y2', `${currentY2}px`);

        const now = performance.now();
        const settled =
            Math.abs(targetX - currentX) < 0.05 &&
            Math.abs(targetY - currentY) < 0.05 &&
            Math.abs(targetX2 - currentX2) < 0.05 &&
            Math.abs(targetY2 - currentY2) < 0.05;

        if (settled && now - lastPointerMovement > idleTimeoutMs) {
            animationFrameId = null;
            return;
        }

        animationFrameId = requestAnimationFrame(step);
    }

    function scheduleAnimation() {
        if (animationFrameId !== null) return;
        animationFrameId = requestAnimationFrame(step);
    }
    
    function handlePointerMove(event) {
        const w = window.innerWidth || 1;
        const h = window.innerHeight || 1;
        const percentX = (event.clientX / w) - 0.5;
        const percentY = (event.clientY / h) - 0.5;
        const strength = 40;
        
        targetX = percentX * strength;
        targetY = percentY * strength;
        targetX2 = percentX * strength * 1.6;
        targetY2 = percentY * strength * 1.6;
        lastPointerMovement = performance.now();
        scheduleAnimation();
    }
    
    function resetPointer() {
        targetX = 0;
        targetY = 0;
        targetX2 = 0;
        targetY2 = 0;
        lastPointerMovement = performance.now();
        scheduleAnimation();
    }
    
    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerleave', resetPointer, { passive: true });
    
    scheduleAnimation();
}

// ===== Configuration =====
const API_BASE_URL = window.location.origin;
const BASE_CHAIN_ID = '0x2105'; // Base mainnet (8453 in decimal)
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// ===== Crypto Icon Helper =====
// Maps token symbols to crypto icon filenames
const CRYPTO_ICON_MAP = {
    'BTC': 'BTC.png',
    'ETH': 'ETH.png',
    'BNB': 'BNB.png',
    'SOL': 'SOL.png', // Solana
    'USDC': 'USDC.png',
    'USDT': 'USDT.png',
    'ADA': 'ADA.png',
    'XRP': 'XRP.png',
    'DOGE': 'DOGE.png',
    'DOT': 'DOT.png',
    'MATIC': 'MATIC.png',
    'AVAX': 'AVAX.png',
    'LINK': 'LINK.png',
    'UNI': 'UNI.png',
    'LTC': 'LTC.png',
    'BCH': 'BCH.png',
    'XLM': 'XLM.png',
    'ATOM': 'ATOM.png',
    'ETC': 'ETC.png',
    'TRX': 'TRX.png',
    'EOS': 'EOS.png',
    'XMR': 'XMR.png',
    'ZEC': 'ZEC.png'
};

// Get crypto icon URL - checks local directory first, then falls back to existing sources
function getCryptoIconUrl(tokenSymbol, existingLogo = null) {
    // If we have an existing logo, prefer it
    if (existingLogo) {
        return existingLogo;
    }
    
    if (!tokenSymbol) {
        return null;
    }
    
    // Normalize symbol (uppercase, remove common suffixes and prefixes)
    const normalizedSymbol = (tokenSymbol || '').toUpperCase()
        .replace(/-/g, '')
        .replace(/\./g, '')
        .replace(/\s/g, '');
    
    // Check if we have a local icon for this symbol
    const iconFile = CRYPTO_ICON_MAP[normalizedSymbol];
    if (iconFile) {
        return `crypto-icons/${iconFile}`;
    }
    
    // Try direct match (symbol matches filename directly)
    // Many tokens use their symbol as the filename
    const directMatch = `${normalizedSymbol}.png`;
    // We can't check if file exists client-side without async fetch,
    // but we can try it and let onerror handle it
    return `crypto-icons/${directMatch}`;
}

function normalizeAiCall(call) {
    if (!call || !call.token) {
        return null;
    }
    const tokenData = call.token || {};
    const calledAt = call.calledAt || call.timestamp || tokenData.calledAt || tokenData.timestamp || null;
    const priceValue = parseFloat(tokenData.currentPriceUsd ?? tokenData.priceUsd ?? tokenData.price ?? 0);
    const price = Number.isFinite(priceValue) ? priceValue : 0;
    const initialPriceValue = parseFloat(tokenData.initialPriceUsd ?? tokenData.priceUsd ?? tokenData.price ?? 0);
    const initialPrice = Number.isFinite(initialPriceValue) ? initialPriceValue : 0;
    const marketCap = computeAiMarketCap(tokenData.marketCap, price);
    const peakMultiplier = tokenData.peakMultiplierSinceCall ?? tokenData.multiplierSinceCall ?? null;
    const peakPercent = tokenData.peakPercentSinceCall ?? tokenData.priceChangePercentSinceCall ?? null;
    const currentPercent = tokenData.priceChangePercentSinceCall ?? null;
    const currentMultiplier = tokenData.multiplierSinceCall ?? null;
    const statusRaw = call.status || tokenData.status || (tokenData.stopLossTriggered ? 'stop_loss_triggered' : 'active');
    const status = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : statusRaw;
    const takeProfitAchieved = (peakMultiplier !== null && peakMultiplier >= 2) ||
        (peakPercent !== null && peakPercent >= 100) ||
        (currentMultiplier !== null && currentMultiplier >= 2) ||
        (currentPercent !== null && currentPercent >= 100);
    const notificationId = buildCallNotificationId(call, tokenData, calledAt);
    return {
        address: tokenData.tokenAddress,
        name: tokenData.name || 'Unknown',
        symbol: tokenData.symbol || 'N/A',
        chain: (tokenData.chain || call.chain || 'solana')?.toLowerCase?.() || 'solana',
        logo: tokenData.logo || null,
        price,
        initialPrice,
        priceChange24h: tokenData.priceChange24h || null,
        marketCap,
        holders: tokenData.holderCount || 0,
        launchpad: tokenData.launchpad || call.launchpad || 'Pump.fun',
        createdAt: call.timestamp,
        calledAt,
        bondingCurveProgress: parseFloat(tokenData.bondingCurveProgress || 0),
        liquidity: parseFloat(tokenData.liquidity || 0),
        fdv: parseFloat(tokenData.fdv || 0),
        aiCall: true,
        aiReason: call.reason,
        multiplierSinceCall: tokenData.multiplierSinceCall || null,
        priceChangePercentSinceCall: currentPercent,
        priceChangeSinceCall: tokenData.priceChangeSinceCall || null,
        peakMultiplierSinceCall: peakMultiplier,
        peakPercentSinceCall: peakPercent,
        peakTimestamp: tokenData.peakTimestamp || null,
        status,
        stopLossTriggered: !!tokenData.stopLossTriggered,
        stopLossTriggeredAt: call.stoppedAt || tokenData.stopLossTriggeredAt || null,
        stopLossPercent: tokenData.stopLossPercent ?? null,
        currentCall: call.currentCall || false,
        takeProfitAchieved,
        notificationId
    };
}

// ===== USDC ABI (minimal) =====
const USDC_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)'
];
// ===== Initialization =====
document.addEventListener('DOMContentLoaded', () => {
    checkApiHealth();
    checkAuthStatus(); // Check if user is already logged in
    // Tokens load on-demand when user opens MEMESCOPE
    // setupAutoRefresh(); // Removed to reduce API calls
    initializeNotificationCenter();
    
    // Initialize orbital animation
    initOrbitalAnimation();
    initInteractiveStarfield();
    
    // Setup login button for mobile compatibility (iOS & Android)
    const loginBtn = document.getElementById('login-button');
    if (loginBtn) {
        // Ensure it's a button
        loginBtn.type = 'button';
        loginBtn.removeAttribute('href');
        loginBtn.removeAttribute('onclick');
        
        // Function to navigate to login - use replace for mobile
        const navigateToLogin = function() {
            try {
                const loginUrl = `${API_BASE_URL}/api/auth/google`;
                console.log('[LOGIN] Navigating to:', loginUrl);
                console.log('[LOGIN] Current URL:', window.location.href);
                
                // Use replace instead of href for mobile (prevents back button issues)
                window.location.replace(loginUrl);
            } catch (error) {
                console.error('[LOGIN] Navigation error:', error);
                // Fallback to href if replace fails
                window.location.href = `${API_BASE_URL}/api/auth/google`;
            }
        };
        
        // Prevent any double-firing
        let isNavigating = false;
        const safeNavigate = function() {
            if (isNavigating) {
                console.log('[LOGIN] Navigation already in progress, skipping...');
                return;
            }
            isNavigating = true;
            navigateToLogin();
        };
        
        // Handle touchstart (iOS Safari - MUST fire immediately)
        loginBtn.addEventListener('touchstart', function(e) {
            e.preventDefault();
            e.stopImmediatePropagation();
            console.log('[LOGIN] touchstart fired');
            safeNavigate();
        }, { passive: false, capture: true });
        
        // Handle click (desktop and Android)
        loginBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopImmediatePropagation();
            console.log('[LOGIN] click fired');
            safeNavigate();
        }, { capture: true });
        
        // Handle touchend as backup
        loginBtn.addEventListener('touchend', function(e) {
            e.preventDefault();
            e.stopImmediatePropagation();
            console.log('[LOGIN] touchend fired');
            safeNavigate();
        }, { passive: false, capture: true });
    }
});

// ===== Authentication Functions =====

// Check authentication status
async function checkAuthStatus() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/status`, {
            credentials: 'include'
        });
        
        if (!response.ok) {
            console.error('Auth status check failed:', response.status);
            showLoginUI();
            return;
        }
        
        const data = await response.json();
        
        if (data.authenticated && data.user) {
            currentUser = data.user;
            const subscriptionPromise = loadSubscriptionStatus();
            // Load wallet in background (don't block UI)
            loadUserWallet().catch(err => {
                console.error('Background wallet load failed:', err);
            });
            updateUserUI();
            await updateFreeCreditsBadge();
            await subscriptionPromise;
            setupAutoBalanceRefresh(); // Start automatic balance refresh
        } else {
            showLoginUI();
            updatePaywallState();
        }
    } catch (error) {
        console.error('Auth check failed:', error);
        showLoginUI();
        updatePaywallState();
    }
}

// Get main wallet chain from localStorage (defaults to 'base')
function getMainWalletChain() {
    if (!currentUser) return 'base';
    const stored = localStorage.getItem(`mainWallet_${currentUser.id}`);
    return stored || 'base';
}

// Set main wallet chain
async function setMainWalletChain(chain) {
    if (!currentUser) return;
    localStorage.setItem(`mainWallet_${currentUser.id}`, chain);
    // Reload wallet with new chain and wait for it to complete
    await loadUserWallet();
    // Update UI after wallet is loaded
    updateUserUI();
}

// Load user wallet info (loads the selected main wallet)
async function loadUserWallet() {
    if (!currentUser) {
        userWallet = null;
        return;
    }
    
    try {
        // Load the selected main wallet chain
        const mainChain = getMainWalletChain();
        const response = await fetch(`${API_BASE_URL}/api/wallet?chain=${mainChain}`, {
            credentials: 'include'
        });
        
        if (response.ok) {
            const walletData = await response.json();
            if (walletData && walletData.address) {
                userWallet = walletData;
                userWallet.chain = mainChain; // Store chain info
                updateUserUI(); // Update UI after wallet loads
                updateUserBalance();
                console.log('✓ Wallet loaded successfully:', {
                    chain: mainChain,
                    address: walletData.address.substring(0, 10) + '...',
                    balance: walletData.balance
                });
            } else {
                console.warn('Wallet data missing address:', walletData);
                // Try to show a more helpful error
                const errorData = await response.json().catch(() => ({}));
                console.error('Wallet load error details:', errorData);
                userWallet = null;
                updateUserUI(); // Update UI even if wallet failed
            }
        } else {
            // Get error details from response
            let errorMessage = 'Failed to load wallet';
            try {
                const errorData = await response.json();
                errorMessage = errorData.message || errorData.error || errorMessage;
                console.error('Wallet load failed:', {
                    status: response.status,
                    error: errorMessage,
                    details: errorData
                });
                
                // If 401 (unauthorized), user might need to re-login
                if (response.status === 401) {
                    console.warn('Authentication failed, user may need to re-login');
                    // Don't show error toast - let auth check handle it
                }
            } catch (e) {
                console.error('Failed to parse wallet error response, status:', response.status);
            }
            
            // Try to get at least the wallet address from all wallets endpoint as fallback
            if (response.status !== 401) {
                try {
                    console.log('Attempting fallback: loading from /api/wallet/all...');
                    const fallbackResponse = await fetch(`${API_BASE_URL}/api/wallet/all`, {
                        credentials: 'include'
                    });
                    if (fallbackResponse.ok) {
                        const allWallets = await fallbackResponse.json();
                        const mainChain = getMainWalletChain();
                        if (allWallets.wallets && allWallets.wallets[mainChain] && allWallets.wallets[mainChain].address) {
                            userWallet = {
                                address: allWallets.wallets[mainChain].address,
                                balance: allWallets.wallets[mainChain].balance || '0',
                                chain: mainChain
                            };
                            console.log('✓ Wallet loaded via fallback method');
                            updateUserUI();
                            updateUserBalance();
                            return; // Success via fallback
                        }
                    }
                } catch (fallbackError) {
                    console.error('Fallback wallet load also failed:', fallbackError);
                }
            }
            
            userWallet = null;
            updateUserUI(); // Update UI even if wallet failed
        }
    } catch (error) {
        console.error('Failed to load wallet:', error);
        
        // Final fallback: try to get address from all wallets
        try {
            console.log('Attempting final fallback: loading from /api/wallet/all...');
            const fallbackResponse = await fetch(`${API_BASE_URL}/api/wallet/all`, {
                credentials: 'include'
            });
            if (fallbackResponse.ok) {
                const allWallets = await fallbackResponse.json();
                const mainChain = getMainWalletChain();
                if (allWallets.wallets && allWallets.wallets[mainChain] && allWallets.wallets[mainChain].address) {
                    userWallet = {
                        address: allWallets.wallets[mainChain].address,
                        balance: allWallets.wallets[mainChain].balance || '0',
                        chain: mainChain
                    };
                    console.log('✓ Wallet loaded via final fallback method');
                    updateUserUI();
                    updateUserBalance();
                    return; // Success via fallback
                }
            }
        } catch (fallbackError) {
            console.error('Final fallback wallet load also failed:', fallbackError);
        }
        
        userWallet = null;
        updateUserUI(); // Update UI even if wallet failed
        // Don't show toast here - it's called on page load and might be annoying
    }
    
    // Check Crossmint wallet status after loading user wallet
    if (currentUser) {
        checkCrossmintWalletStatus();
    }
}

// Check if Crossmint wallet exists and show/hide menu item
async function checkCrossmintWalletStatus() {
    try {
        const menuItem = document.getElementById('crossmint-wallet-menu-item');
        if (!menuItem) return;
        
        // Check Crossmint status from API
        const statusResponse = await fetch(`${API_BASE_URL}/api/wallet/crossmint-status`, { credentials: 'include' });
        if (statusResponse.ok) {
            const status = await statusResponse.json();
            // Show menu item only if Crossmint is configured AND wallet doesn't exist
            if (status.shouldShowButton) {
                menuItem.style.display = 'flex';
            } else {
                menuItem.style.display = 'none';
            }
        } else {
            // Hide on error
            menuItem.style.display = 'none';
        }
    } catch (error) {
        console.error('Error checking Crossmint wallet status:', error);
        // Hide menu item on error
        const menuItem = document.getElementById('crossmint-wallet-menu-item');
        if (menuItem) menuItem.style.display = 'none';
    }
}

// Create Crossmint wallet from menu
async function createCrossmintWalletFromMenu(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    await createCrossmintWallet(event);
}

// Update user UI in header
function updateUserUI() {
    const loginBtn = document.getElementById('login-button');
    const userAccount = document.getElementById('user-account');
    
    if (currentUser) {
        loginBtn.style.display = 'none';
        userAccount.style.display = 'flex';
        
        // Update avatar
        const avatarImg = document.getElementById('user-avatar-img');
        const avatarInitial = document.getElementById('user-avatar-initial');
        if (currentUser.picture) {
            avatarImg.src = currentUser.picture;
            avatarImg.style.display = 'block';
            avatarInitial.style.display = 'none';
        } else {
            avatarInitial.textContent = currentUser.name.charAt(0).toUpperCase();
            avatarImg.style.display = 'none';
            avatarInitial.style.display = 'block';
        }
        
        // Update name and wallet
        document.getElementById('user-name').textContent = currentUser.name;
        const walletElement = document.getElementById('user-wallet');
        if (userWallet && userWallet.address) {
            const shortAddress = `${userWallet.address.slice(0, 6)}...${userWallet.address.slice(-4)}`;
            walletElement.textContent = shortAddress;
        } else {
            // If wallet not loaded yet, try to load it (but don't show error if it fails silently)
            if (!userWallet) {
                // Load wallet asynchronously without blocking
                loadUserWallet().catch(err => {
                    console.error('Background wallet load failed:', err);
                    // Only show error if user tries to interact with wallet
                    walletElement.textContent = 'Tap to load';
                });
            }
            // Show loading while wallet loads
            walletElement.textContent = 'Loading...';
        }
        
        updateUserBalance();
    } else {
        loginBtn.style.display = 'block';
        userAccount.style.display = 'none';
    }
}

// Update user balance display
function updateUserBalance() {
    if (userWallet && userWallet.balance !== undefined) {
        const balance = parseFloat(userWallet.balance);
        document.getElementById('user-balance').textContent = `$${balance.toFixed(2)} USDC`;
    }
}

// Show login UI
function showLoginUI() {
    currentUser = null;
    userWallet = null;
    currentSubscription = null;
    subscriptionStatusLoaded = false;
    stopNotificationPolling();
    const loginBtn = document.getElementById('login-button');
    const userAccount = document.getElementById('user-account');
    
    loginBtn.style.display = 'block';
    userAccount.style.display = 'none';
    updateNotificationAccess();
    setAiTokenPaywallState(false);
}

// Login with Google
function loginWithGoogle(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    }
    
    try {
        console.log('loginWithGoogle() function called');
        console.log('Current URL:', window.location.href);
        console.log('API_BASE_URL:', API_BASE_URL);
        
        const loginUrl = `${API_BASE_URL}/api/auth/google`;
        console.log('Redirecting to:', loginUrl);
        
        // Force redirect immediately - use replace to prevent back button issues
        window.location.href = loginUrl;
        
        // Fallback: if redirect doesn't work after a short delay, try again
        setTimeout(() => {
            if (window.location.href !== loginUrl && !window.location.href.includes('/api/auth/google')) {
                console.warn('Redirect may have failed, trying again...');
                window.location.replace(loginUrl);
            }
        }, 500);
    } catch (error) {
        console.error('Login error:', error);
        showToast('Login failed. Please try again.', 'error');
    }
    
    return false;
}

// Logout
async function logout() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/logout`, {
            method: 'POST',
            credentials: 'include'
        });
        
        if (response.ok) {
            currentUser = null;
            userWallet = null;
            showLoginUI();
            showToast('Logged out successfully', 'success');
            closeUserMenu();
            updatePaywallState();
        }
    } catch (error) {
        console.error('Logout failed:', error);
        showToast('Logout failed', 'error');
    }
}

// Toggle user menu
function toggleUserMenu(event) {
    if (event) {
        event.stopPropagation(); // Prevent event bubbling
    }
    const menu = document.getElementById('user-menu');
    const account = document.getElementById('user-account');
    const isHidden = menu.style.display === 'none' || !menu.style.display;
    
    if (isHidden && account) {
        // Position menu below the user account button
        const rect = account.getBoundingClientRect();
        menu.style.display = 'block';
        menu.style.top = `${rect.bottom + 10}px`;
        menu.style.right = `${window.innerWidth - rect.right}px`;
        
        setTimeout(() => {
            document.addEventListener('click', closeUserMenuOnClickOutside, true);
        }, 0);
    } else {
        menu.style.display = 'none';
        document.removeEventListener('click', closeUserMenuOnClickOutside, true);
    }
}

// Close user menu when clicking outside
function closeUserMenuOnClickOutside(event) {
    const menu = document.getElementById('user-menu');
    const account = document.getElementById('user-account');
    
    // Don't close if clicking inside the menu or account
    if (menu && account && !menu.contains(event.target) && !account.contains(event.target)) {
        menu.style.display = 'none';
        document.removeEventListener('click', closeUserMenuOnClickOutside, true);
    }
}

// Close user menu
function closeUserMenu() {
    const menu = document.getElementById('user-menu');
    if (menu) {
        menu.style.display = 'none';
    }
    document.removeEventListener('click', closeUserMenuOnClickOutside, true);
}

// Copy wallet address (copies the main wallet)
async function copyWalletAddress() {
    // If wallet not loaded, try to load it first
    if (!userWallet || !userWallet.address) {
        // Try to load the wallet
        await loadUserWallet();
        
        // Check again after loading
        if (!userWallet || !userWallet.address) {
            // If still not loaded, try fetching directly from the selected chain
            const mainChain = getMainWalletChain();
            try {
                const response = await fetch(`${API_BASE_URL}/api/wallet?chain=${mainChain}`, {
                    credentials: 'include'
                });
                
                if (response.ok) {
                    const walletData = await response.json();
                    if (walletData && walletData.address) {
                        userWallet = walletData;
                        userWallet.chain = mainChain;
                        updateUserUI();
                    } else {
                        showToast('Wallet not available', 'error');
                        closeUserMenu();
                        return;
                    }
                } else {
                    showToast('Failed to load wallet', 'error');
                    closeUserMenu();
                    return;
                }
            } catch (error) {
                console.error('Failed to fetch wallet:', error);
                showToast('Failed to load wallet', 'error');
                closeUserMenu();
                return;
            }
        }
    }
    
    // Now copy the address
    if (userWallet && userWallet.address) {
        await copyToClipboard(userWallet.address);
        showToast('Wallet address copied!', 'success');
        closeUserMenu();
    } else {
        showToast('Wallet address not available', 'error');
    }
}

// Auto-refresh balance for main wallet
async function autoRefreshBalance() {
    if (!currentUser || !userWallet) return;
    
    try {
        const mainChain = getMainWalletChain();
        const response = await fetch(`${API_BASE_URL}/api/wallet/refresh?chain=${mainChain}`, {
            method: 'POST',
            credentials: 'include'
        });
        
        if (response.ok) {
            const data = await response.json();
            if (userWallet) {
                userWallet.balance = data.balance;
                updateUserBalance();
            }
        }
    } catch (error) {
        console.error('Auto-refresh balance failed:', error);
    }
}
// Store the refresh interval ID to prevent multiple intervals
let balanceRefreshInterval = null;
// Set up automatic balance refresh
function setupAutoBalanceRefresh() {
    if (!currentUser) {
        // Clear interval if user logged out
        if (balanceRefreshInterval) {
            clearInterval(balanceRefreshInterval);
            balanceRefreshInterval = null;
        }
        return;
    }
    
    // Clear any existing interval
    if (balanceRefreshInterval) {
        clearInterval(balanceRefreshInterval);
    }
    
    // Refresh immediately
    autoRefreshBalance();
    
    // Refresh every 30 seconds
    balanceRefreshInterval = setInterval(() => {
        if (!currentUser) {
            clearInterval(balanceRefreshInterval);
            balanceRefreshInterval = null;
            return;
        }
        autoRefreshBalance();
    }, 30000);
    
    // Also refresh when page becomes visible (only add listener once)
    if (!window.balanceRefreshVisibilityListener) {
        window.balanceRefreshVisibilityListener = true;
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && currentUser) {
                autoRefreshBalance();
            }
        });
    }
}

// Open wallet dashboard
async function openWalletDashboard() {
    const modal = document.getElementById('wallet-dashboard-modal');
    const body = document.getElementById('wallet-dashboard-body');
    
    if (!currentUser) {
        showToast('Please login to view your wallets', 'warning');
        return;
    }
    
    modal.classList.add('active');
    
    body.innerHTML = `
        <div class="wallet-loading">
            <div class="spinner"></div>
            <p>Loading wallet information...</p>
        </div>
    `;
    
    try {
        const [walletResponse, subscriptionResponse, plansResponse] = await Promise.all([
            fetch(`${API_BASE_URL}/api/wallet/all`, { credentials: 'include' }),
            fetch(`${API_BASE_URL}/api/subscriptions/status`, { credentials: 'include' }),
            fetch(`${API_BASE_URL}/api/subscriptions/plans`, { credentials: 'include' })
        ]);
        
        if (!walletResponse.ok) {
            throw new Error('Failed to load wallets');
        }
        
        const data = await walletResponse.json();
        const wallets = data.wallets;
        
        // Debug: Log wallets to see what we're getting
        console.log('📦 Wallets received from API:', wallets);
        console.log('🔍 Crossmint wallet check:', {
            exists: !!wallets['solana-crossmint'],
            hasAddress: !!(wallets['solana-crossmint'] && wallets['solana-crossmint'].address),
            address: wallets['solana-crossmint']?.address || 'none'
        });
        
        let subscriptionStatus = null;
        if (subscriptionResponse.ok) {
            const subscriptionPayload = await subscriptionResponse.json();
            subscriptionStatus = subscriptionPayload.subscription || null;
        } else {
            console.warn('Subscription status unavailable:', subscriptionResponse.status);
        }
        
        let subscriptionPlans = [];
        if (plansResponse.ok) {
            const plansPayload = await plansResponse.json();
            subscriptionPlans = plansPayload.plans || [];
        } else {
            console.warn('Subscription plans unavailable:', plansResponse.status);
        }
        
        // Chain display info with actual logos
        const chainInfo = {
            base: { name: 'Base', logo: 'base-logo.png', color: '#0052FF' },
            'solana-crossmint': { name: 'Solana Crossmint', logo: 'solana-logo.png', color: '#14F195' },
            ethereum: { name: 'Ethereum', logo: 'eth_light_3.png', color: '#627EEA' },
            bnb: { name: 'BNB Chain', logo: 'bnb-logo.png', color: '#F3BA2F' },
            solana: { name: 'Solana', logo: 'solana-logo.png', color: '#9945FF' }
        };
        
        body.innerHTML = `
            <div class="wallet-info-card">
                <div class="wallet-header">
                    <div class="wallet-avatar">
                        ${currentUser.picture ? `<img src="${currentUser.picture}" alt="${currentUser.name}">` : `<span>${currentUser.name.charAt(0)}</span>`}
                    </div>
                    <div class="wallet-user-info">
                        <h3>${currentUser.name}</h3>
                        <p class="wallet-email">${currentUser.email}</p>
                    </div>
                </div>
                
                <div class="wallet-chains-section">
                    <h4 style="margin-bottom: 16px; color: var(--text-primary);">Your Multi-Chain Wallets</h4>
                    <div class="wallet-chains-grid">
                        ${Object.keys(wallets).filter(chain => wallets[chain] && wallets[chain].address).map(chain => {
                            const wallet = wallets[chain];
                            const info = chainInfo[chain] || { name: chain, logo: 'solana-logo.png', color: '#14F195' };
                            const balance = parseFloat(wallet.balance || 0).toFixed(2);
                            const address = wallet.address || 'Not available';
                            const mainChain = getMainWalletChain();
                            const isMain = chain === mainChain;
                            
                            return `
                                <div class="wallet-chain-card ${isMain ? 'wallet-chain-main' : ''}" data-chain="${chain}">
                                    <div class="wallet-chain-header">
                                        <div class="wallet-chain-icon">
                                            <img src="${info.logo}" alt="${info.name}" class="wallet-chain-icon-img">
                                        </div>
                                        <div class="wallet-chain-name">${info.name}${isMain ? ' <span class="main-wallet-badge">(Main)</span>' : ''}</div>
                                    </div>
                                    <div class="wallet-chain-balance">
                                        <div class="wallet-chain-balance-label">USDC Balance</div>
                                        <div class="wallet-chain-balance-value">$${balance}</div>
                                    </div>
                                    <div class="wallet-chain-address">
                                        <div class="wallet-chain-address-label">Address</div>
                                        <div class="wallet-chain-address-value">
                                            <code>${address.substring(0, 10)}...${address.substring(address.length - 8)}</code>
                                            <button class="btn-copy-address-small" onclick="copyToClipboard('${address}'); showToast('${info.name} address copied!', 'success')" title="Copy Address">
                                                <i class='bx bx-copy'></i>
                                            </button>
                                        </div>
                                    </div>
                                    ${!isMain ? `
                                        <button class="btn-set-main-wallet" onclick="(async () => { await setMainWalletChain('${chain}'); closeWalletDashboard(); showToast('${info.name} set as main wallet', 'success'); })()" title="Set as Main Wallet">
                                            <i class='bx bx-star'></i> Set as Main
                                        </button>
                                    ` : `
                                        <div class="main-wallet-indicator">
                                            <i class='bx bx-check-circle'></i> Main Wallet
                                        </div>
                                    `}
                                    <button class="btn-refresh-chain" onclick="refreshChainBalance('${chain}')" title="Refresh Balance">
                                        <i class='bx bx-refresh'></i> Refresh
                                    </button>
                                </div>
                            `;
                        }).join('')}
                    </div>
                    ${(!wallets['solana-crossmint'] || !wallets['solana-crossmint'].address) ? `
                    <div style="margin-top: 20px; padding: 16px; background: var(--card-bg); border-radius: 8px; border: 1px dashed var(--border-color);">
                        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
                            <div>
                                <h5 style="margin: 0 0 8px 0; color: var(--text-primary);">Solana Crossmint Wallet</h5>
                                <p style="margin: 0; color: var(--text-secondary); font-size: 14px;">Create an embedded Solana wallet powered by Crossmint</p>
                            </div>
                            <button class="btn-primary" onclick="createCrossmintWallet(event)" style="white-space: nowrap;">
                                <i class='bx bx-plus'></i> Create Crossmint Wallet
                            </button>
                        </div>
                    </div>
                    ` : ''}
                </div>
                
                ${renderSubscriptionSection(subscriptionStatus, subscriptionPlans)}
                
                <div class="wallet-deposit-section">
                    <h4><i class='bx bx-dollar'></i> Deposit USDC</h4>
                    <p class="wallet-deposit-info">Send USDC to your wallet addresses above to fund your AI analysis subscription and compute units. Each chain has its own wallet.</p>
                    <div class="wallet-deposit-info-box">
                        <p><strong>Supported Networks:</strong> Base, Ethereum, BNB Chain, Solana</p>
                        <p><strong>Token:</strong> USDC (chain-specific)</p>
                        <p><strong>Recommended:</strong> Deposit enough USDC to cover your preferred monthly plan</p>
                        <p style="margin-top: 8px; font-size: 12px; color: var(--text-secondary);">
                            <strong>Note:</strong> Payments can be processed from any supported network (Base, Ethereum, BNB Chain, or Solana).
                        </p>
                    </div>
                </div>
                
                <div class="wallet-usage-info">
                    <h4><i class='bx bx-bulb'></i> How It Works</h4>
                    <ul>
                        <li>Your YunaraX402 account includes wallets for Base, Ethereum, BNB, and Solana</li>
                        <li>Deposit USDC into any of these wallets to fund your subscription</li>
                        <li>AI analyses consume 1 Compute Unit (CU) from your active plan</li>
                        <li>Switch or top-up plans anytime—remaining CU carries until the next renewal</li>
                        <li>No external wallet connection required; payments run through x402 automatically</li>
                    </ul>
                </div>
            </div>
        `;
    } catch (error) {
        body.innerHTML = `
            <div class="wallet-error">
                <p>❌ Failed to load wallet information</p>
                <p>${error.message}</p>
                <button class="btn-primary" onclick="openWalletDashboard()">Retry</button>
            </div>
        `;
    }
}

// Refresh balance for a specific chain
async function createCrossmintWallet(event) {
    let button = null;
    try {
        // Get button element safely
        if (event && event.target) {
            button = event.target.closest('button');
        }
        
        // If no button from event, try to find it by ID
        if (!button) {
            button = document.getElementById('crossmint-wallet-menu-item');
        }
        
        if (button) {
            button.disabled = true;
            const originalHTML = button.innerHTML;
            button.innerHTML = '<span class="button-spinner"></span> Creating...';
            
            // Store original HTML for error recovery
            button.dataset.originalHTML = originalHTML;
        }
        
        const response = await fetch(`${API_BASE_URL}/api/wallet/create-crossmint`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || errorData.error || 'Failed to create Crossmint wallet');
        }
        
        const data = await response.json();
        showToast('Crossmint wallet created successfully!', 'success');
        
        // Hide the menu item since wallet now exists
        const menuItem = document.getElementById('crossmint-wallet-menu-item');
        if (menuItem) menuItem.style.display = 'none';
        
        // Refresh wallet dashboard to show new wallet
        await openWalletDashboard();
    } catch (error) {
        console.error('Error creating Crossmint wallet:', error);
        showToast(error.message || 'Failed to create Crossmint wallet', 'error');
        
        // Restore button state on error
        if (button) {
            button.disabled = false;
            button.innerHTML = button.dataset.originalHTML || '<i class=\'bx bx-plus-circle\'></i> <span>Create Crossmint Wallet</span>';
        }
    }
}

async function refreshChainBalance(chain) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/wallet/refresh?chain=${chain}`, {
            method: 'POST',
            credentials: 'include'
        });
        
        if (response.ok) {
            const data = await response.json();
            showToast(`${chain} balance refreshed!`, 'success');
            // Reload wallet dashboard to show updated balance
            openWalletDashboard();
        } else {
            throw new Error('Failed to refresh balance');
        }
    } catch (error) {
        console.error('Failed to refresh chain balance:', error);
        showToast(`Failed to refresh ${chain} balance`, 'error');
    }
}

// Refresh wallet dashboard (reloads all wallets)
function refreshWalletDashboard() {
    if (document.getElementById('wallet-dashboard-modal').classList.contains('active')) {
        openWalletDashboard();
    }
}

// Close wallet dashboard
function closeWalletDashboard() {
    document.getElementById('wallet-dashboard-modal').classList.remove('active');
}

// Open-source: No subscription purchases needed
async function purchaseSubscriptionPlan(planId, button) {
    showToast('Open-source version: No payment required. Configure your API keys in .env file.', 'info');
}
async function generateSubscriptionApiKey(button) {
    if (!currentUser) {
        showToast('Please login to generate API keys', 'warning');
        return;
    }
    
    const originalInnerHTML = button ? button.innerHTML : '';
    if (button) {
        button.disabled = true;
        button.classList.add('loading');
        button.innerHTML = `<span class="button-spinner"></span> Generating...`;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/subscriptions/api-keys`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || errorData.message || 'Failed to generate API key');
        }
        
        const data = await response.json();
        const apiKey = data.apiKey;
        if (apiKey) {
            try {
                await navigator.clipboard.writeText(apiKey);
                showToast('API key generated and copied to clipboard!', 'success');
            } catch (copyError) {
                console.warn('Clipboard write failed:', copyError);
                showToast('API key generated. Copy it from the alert.', 'info');
                alert(`Your new API key:\n\n${apiKey}\n\nCopy and store it securely. It will not be shown again.`);
            }
        } else {
            showToast('API key generated.', 'success');
        }
        openWalletDashboard();
    } catch (error) {
        console.error('API key generation error:', error);
        showToast(error.message || 'Failed to generate API key', 'error');
    } finally {
        if (button) {
            button.disabled = false;
            button.classList.remove('loading');
            button.innerHTML = originalInnerHTML;
        }
    }
}

async function revokeSubscriptionApiKey(keyId, button) {
    if (!keyId) return;
    
    if (!confirm('Revoke this API key? Any integrations using it will stop working.')) {
        return;
    }
    
    const originalInnerHTML = button ? button.innerHTML : '';
    if (button) {
        button.disabled = true;
        button.classList.add('loading');
        button.innerHTML = `<span class="button-spinner"></span> Revoking...`;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/subscriptions/api-keys/${keyId}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || errorData.message || 'Failed to revoke API key');
        }
        
        showToast('API key revoked', 'success');
        openWalletDashboard();
    } catch (error) {
        console.error('API key revoke error:', error);
        showToast(error.message || 'Failed to revoke API key', 'error');
    } finally {
        if (button) {
            button.disabled = false;
            button.classList.remove('loading');
            button.innerHTML = originalInnerHTML;
        }
    }
}

// ===== Watchlist Dashboard Functions =====

// Open watchlist dashboard
async function openWatchlistDashboard() {
    hideAITokenCallsHeader();
    aiTokenCallsSticky = false;
    if (!currentUser) {
        showToast('Please login to view your watchlist', 'warning');
        return;
    }
    
    const modal = document.getElementById('watchlist-dashboard-modal');
    const body = document.getElementById('watchlist-dashboard-body');
    
    modal.classList.add('active');
    
    body.innerHTML = `
        <div class="watchlist-loading">
            <div class="spinner"></div>
            <p>Loading watchlist...</p>
        </div>
    `;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/watchlist`, {
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response.status === 401) {
            const errorData = await response.json().catch(() => ({}));
            body.innerHTML = `
                <div class="watchlist-error">
                    <p>❌ Authentication required</p>
                    <p>Please login with Google to view your watchlist.</p>
                    <button class="btn-primary" onclick="loginWithGoogle()">Login with Google</button>
                </div>
            `;
            return;
        }
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(errorData.error || errorData.message || 'Failed to load watchlist');
        }
        
        const data = await response.json();
        renderWatchlistDashboard(data);
    } catch (error) {
        console.error('Error loading watchlist:', error);
        body.innerHTML = `
            <div class="watchlist-error">
                <p>❌ Failed to load watchlist</p>
                <p>${error.message}</p>
                <button class="btn-primary" onclick="openWatchlistDashboard()">Retry</button>
            </div>
        `;
    }
}

// Render watchlist dashboard
function renderWatchlistDashboard(data) {
    const body = document.getElementById('watchlist-dashboard-body');
    const { watchlist } = data;
    
    body.innerHTML = `
        <div class="watchlist-dashboard">
            <!-- Add Token Form -->
            <div class="watchlist-add-section">
                <h3>➕ Add Token to Watchlist</h3>
                <div class="watchlist-add-form">
                    <input type="text" id="watchlist-chain" placeholder="Chain (solana, bnb, base, ethereum)" class="watchlist-input">
                    <input type="text" id="watchlist-address" placeholder="Token Address" class="watchlist-input">
                    <button class="btn-primary" onclick="addToWatchlist()">Add to Watchlist</button>
                </div>
            </div>
            
            <!-- Watchlist Tokens -->
            <div class="watchlist-tokens">
                <h3>Watched Tokens (${watchlist.length})</h3>
                ${watchlist.length === 0 ? `
                    <div class="watchlist-empty">
                        <p>Your watchlist is empty. Add tokens to track!</p>
                    </div>
                ` : `
                    <div class="watchlist-tokens-list">
                        ${watchlist.map((watched) => {
                            const priceChangeClass = watched.tokenData.priceChange24h >= 0 ? 'positive' : 'negative';
                            const priceChangeSign = watched.tokenData.priceChange24h >= 0 ? '+' : '';
                            
                            const actualChain = watched.chain || 'unknown';
                            const rawAddress = (watched.tokenData.contractAddress || watched.originalAddress || watched.address || '').trim();
                            const actualAddress = rawAddress || '';
                            const safeChain = actualChain.replace(/'/g, "\\'");
                            const safeAddress = actualAddress.replace(/'/g, "\\'");
                            const hasAddress = actualAddress.length > 0;
                            const shortAddress = hasAddress ? `${actualAddress.slice(0, 4)}...${actualAddress.slice(-4)}` : 'Address unavailable';
                            const cardAttributes = hasAddress 
                                ? `onclick=\"searchTokenByAddress('${safeChain}', '${safeAddress}')\"`
                                : '';
                            const cardCursorStyle = hasAddress ? 'cursor: pointer;' : 'cursor: not-allowed;';
                            
                            return `
                                <div class="watchlist-token-card" ${cardAttributes} style="${cardCursorStyle}">
                                    <div class="watchlist-token-header">
                                        <div class="watchlist-token-info">
                                            ${watched.tokenData.logo ? `
                                                <img src="${watched.tokenData.logo}" alt="${watched.tokenData.name}" class="watchlist-token-logo" onerror="this.style.display='none'">
                                            ` : ''}
                                            <div>
                                                <div class="watchlist-token-name">${watched.tokenData.name || watched.name}</div>
                                                <div class="watchlist-token-symbol">${watched.tokenData.symbol || watched.symbol}</div>
                                            </div>
                                        </div>
                                        <button class="watchlist-remove-btn" onclick="event.stopPropagation(); removeFromWatchlist('${safeChain}', '${safeAddress}')" title="Remove">×</button>
                                    </div>
                                    
                                    <div class="watchlist-token-meta">
                                        <div class="watchlist-token-chain">
                                            <i class='bx bx-link-alt'></i>
                                            <span>${actualChain.toUpperCase()}</span>
                                        </div>
                                        <div class="watchlist-token-contract">
                                            <span class="watchlist-contract-label">Contract</span>
                                            <span class="watchlist-contract-address">${shortAddress}</span>
                                            ${hasAddress ? `
                                                <button class="watchlist-copy-btn" onclick="event.stopPropagation(); copyContractAddress('${safeAddress}')" title="Copy contract address">
                                                    <i class='bx bx-copy'></i>
                                                </button>
                                            ` : ''}
                                        </div>
                                    </div>
                                    
                                    <div class="watchlist-token-stats">
                                        <div class="watchlist-stat">
                                            <span class="watchlist-stat-label">Price:</span>
                                            <span class="watchlist-stat-value">$${formatNumber(watched.tokenData.price || 0)}</span>
                                        </div>
                                        <div class="watchlist-stat">
                                            <span class="watchlist-stat-label">24h Change:</span>
                                            <span class="watchlist-stat-value ${priceChangeClass}">${priceChangeSign}${(watched.tokenData.priceChange24h || 0).toFixed(2)}%</span>
                                        </div>
                                        <div class="watchlist-stat">
                                            <span class="watchlist-stat-label">Market Cap:</span>
                                            <span class="watchlist-stat-value">$${formatNumber(watched.tokenData.marketCap || 0)}</span>
                                        </div>
                                        <div class="watchlist-stat">
                                            <span class="watchlist-stat-label">Volume 24h:</span>
                                            <span class="watchlist-stat-value">$${formatNumber(watched.tokenData.volume24h || 0)}</span>
                                        </div>
                                        <div class="watchlist-stat">
                                            <span class="watchlist-stat-label">Holders:</span>
                                            <span class="watchlist-stat-value">${formatWholeNumber(watched.tokenData.holders || 0)}</span>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `}
            </div>
        </div>
    `;
}

// Add token to watchlist
async function addToWatchlist() {
    const chain = document.getElementById('watchlist-chain').value.trim().toLowerCase();
    const address = document.getElementById('watchlist-address').value.trim();
    
    if (!chain || !address) {
        showToast('Please fill both fields', 'error');
        return;
    }
    
    try {
        // First, try to get token name/symbol
        const tokenResponse = await fetch(`${API_BASE_URL}/api/token-details/${chain}/${address}`);
        const tokenData = await tokenResponse.json().catch(() => ({}));
        
        // Extract name and symbol from nested structure (token-details returns metadata object)
        const name = tokenData.metadata?.name || tokenData.token_name || tokenData.name || 'Unknown Token';
        const symbol = tokenData.metadata?.symbol || tokenData.token_symbol || tokenData.symbol || 'UNKNOWN';
        
        const response = await fetch(`${API_BASE_URL}/api/watchlist/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                chain,
                address,
                name,
                symbol,
                tokenData: {
                    name,
                    symbol,
                    logo: tokenData.metadata?.logo || tokenData.token_logo || null,
                    price: parseFloat(tokenData.price?.usdPrice || tokenData.price_usd || 0),
                    priceChange24h: parseFloat(tokenData.price?.['24hrPercentChange'] || tokenData.price?.priceChange24h || 0),
                    marketCap: parseFloat(tokenData.price?.usdMarketCap || tokenData.market_cap || 0),
                    volume24h: parseFloat(tokenData.volume24h || tokenData.volume_usd_24h || 0),
                    liquidity: parseFloat(tokenData.liquidity || 0),
                    holders: parseInt(tokenData.holderStats?.totalHolders || 0),
                    contractAddress: address
                }
            })
        });
        
        if (response.ok) {
            showToast('Token added to watchlist!', 'success');
            // Clear form
            document.getElementById('watchlist-chain').value = '';
            document.getElementById('watchlist-address').value = '';
            // Reload watchlist
            await openWatchlistDashboard();
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to add token', 'error');
        }
    } catch (error) {
        console.error('Error adding to watchlist:', error);
        showToast('Failed to add token', 'error');
    }
}

// Remove token from watchlist
async function removeFromWatchlist(chain, address) {
    try {
        const response = await fetch(`${API_BASE_URL}/api/watchlist/remove`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ chain, address })
        });
        
        if (response.ok) {
            showToast('Token removed from watchlist', 'success');
            await openWatchlistDashboard();
        } else {
            showToast('Failed to remove token', 'error');
        }
    } catch (error) {
        console.error('Error removing from watchlist:', error);
        showToast('Failed to remove token', 'error');
    }
}

// Close watchlist dashboard
function closeWatchlistDashboard() {
    document.getElementById('watchlist-dashboard-modal').classList.remove('active');
}

// Helper function to search token by address (used in watchlist)
function searchTokenByAddress(chain, address) {
    console.log('🔍 [WATCHLIST] Searching for token:', { chain, address });
    activeDashboard = 'memescope';
    
    // Close watchlist modal first
    closeWatchlistDashboard();
    
    // Search for the token using the contract address (CA), not the chain name
    const searchInput = document.getElementById('search-input');
    if (searchInput && address) {
        // Use the address (contract address) for search, not the chain name
        // Make sure we're using the actual token address, not "solana" or chain name
        let actualAddress = address?.trim();
        if (!actualAddress || actualAddress.toLowerCase() === chain.toLowerCase()) {
            console.error('❌ [WATCHLIST] Address appears to be chain name, cannot search:', { chain, address });
            showToast('Invalid token address', 'error');
            return;
        }
        
        if (!actualAddress || actualAddress.length < 10) {
            console.error('❌ [WATCHLIST] Invalid address:', { address, chain, actualAddress });
            showToast('Invalid token address', 'error');
            return;
        }
        
        searchInput.value = actualAddress;
        console.log('🔍 [WATCHLIST] Search input set to token address:', actualAddress);
        
        // Small delay to ensure modal is closed
        setTimeout(() => {
        searchToken();
        }, 300);
    } else {
        console.error('❌ [WATCHLIST] Missing search input or address:', { searchInput: !!searchInput, address });
        showToast('Cannot search: missing address', 'error');
    }
}

// Quick add to watchlist from token card
// tokenObject should contain all the data from the token card (price, marketCap, holders, logo, etc.)
async function quickAddToWatchlist(chain, address, tokenObject = null) {
    if (!currentUser) {
        showToast('Please login to add tokens to watchlist', 'warning');
        return;
    }
    
    try {
        // Resolve the actual address (prefer token object data if available)
        const resolvedAddress = (tokenObject?.tokenAddress || tokenObject?.address || address || '').trim();
        if (!resolvedAddress) {
            showToast('Unable to determine token address', 'error');
            return;
        }
        
        // Use token object data if available (from token card), otherwise fetch
        let tokenData = {};
        
        if (tokenObject) {
            // Use data directly from token card - it already has all the info!
            tokenData = {
                name: tokenObject.name || 'Unknown Token',
                symbol: tokenObject.symbol || 'UNKNOWN',
                logo: tokenObject.logo || null,
                price: tokenObject.price || 0,
                priceChange24h: tokenObject.priceChange24h || 0,
                marketCap: tokenObject.marketCap || 0,
                volume24h: tokenObject.volume24h || 0,
                liquidity: tokenObject.liquidity || 0,
                holders: tokenObject.holders || 0,
                contractAddress: resolvedAddress
            };
        } else {
            // Fallback: fetch if token object not provided
            const tokenResponse = await fetch(`${API_BASE_URL}/api/token-details/${chain}/${resolvedAddress}`).catch(() => null);
            const fetchedData = tokenResponse ? await tokenResponse.json().catch(() => ({})) : {};
            
            // Extract from nested structure
            tokenData = {
                name: fetchedData.metadata?.name || fetchedData.token_name || fetchedData.name || 'Unknown Token',
                symbol: fetchedData.metadata?.symbol || fetchedData.token_symbol || fetchedData.symbol || 'UNKNOWN',
                logo: fetchedData.metadata?.logo || fetchedData.token_logo || null,
                price: parseFloat(fetchedData.price?.usdPrice || fetchedData.price_usd || 0),
                priceChange24h: parseFloat(fetchedData.price?.['24hrPercentChange'] || fetchedData.price?.priceChange24h || 0),
                marketCap: parseFloat(fetchedData.price?.usdMarketCap || fetchedData.market_cap || 0),
                holders: parseInt(fetchedData.holderStats?.totalHolders || 0),
                contractAddress: resolvedAddress
            };
        }
        
        const response = await fetch(`${API_BASE_URL}/api/watchlist/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                chain,
                address: resolvedAddress,
                name: tokenData.name,
                symbol: tokenData.symbol,
                // Store full token data so we don't need to fetch again!
                tokenData: tokenData
            })
        });
        
        if (response.ok) {
            showToast('Token added to watchlist!', 'success');
        } else {
            const error = await response.json();
            showToast(error.error || 'Failed to add token', 'error');
        }
    } catch (error) {
        console.error('Error adding to watchlist:', error);
        showToast('Failed to add token', 'error');
    }
}

// ===== API Health Check =====
async function checkApiHealth() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/health`);
        const data = await response.json();

        // Update status indicators (guard if elements are not present)
        const moralisDot = document.getElementById('status-moralis');
        const geminiDot = document.getElementById('status-gemini');
        const openaiDot = document.getElementById('status-openai');
        if (moralisDot) moralisDot.classList.toggle('active', data.apis?.moralis);
        if (geminiDot) geminiDot.classList.toggle('active', data.apis?.gemini);
        if (openaiDot) openaiDot.classList.toggle('active', data.apis?.openai);
    } catch (error) {
        console.error('Health check failed:', error);
    }
}

// ===== Search Token =====
// ===== Hide Agent Video =====
function hideAgentVideo() {
    const videoContainer = document.getElementById('agent-video-container');
    if (videoContainer) {
        videoContainer.classList.add('hidden');
        const hero = document.querySelector('.hero');
        if (hero) {
            hero.classList.add('hero-condensed');
        }
        // Pause video to save resources
        const video = document.getElementById('agent-video');
        if (video) {
            setTimeout(() => {
                video.pause();
            }, 500);
        }
    }
}
function showAgentVideo() {
    const videoContainer = document.getElementById('agent-video-container');
    if (videoContainer) {
        videoContainer.classList.remove('hidden');
        const hero = document.querySelector('.hero');
        if (hero) {
            hero.classList.remove('hero-condensed');
        }
        // Resume video playback
        const video = document.getElementById('agent-video');
        if (video) {
            setTimeout(() => {
                video.play().catch(err => {
                    console.log('Video autoplay prevented:', err);
                });
            }, 500);
        }
    }
}
function showAgentVideo() {
    const videoContainer = document.getElementById('agent-video-container');
    if (videoContainer) {
        videoContainer.classList.remove('hidden');
        const hero = document.querySelector('.hero');
        if (hero) {
            hero.classList.remove('hero-condensed');
        }
        // Resume video playback
        const video = document.getElementById('agent-video');
        if (video) {
            setTimeout(() => {
                video.play().catch(err => {
                    console.log('Video autoplay prevented:', err);
                });
            }, 500);
        }
    }
}
async function searchToken() {
    activeDashboard = 'memescope';
    // Hide the agent video when searching
    hideAgentVideo();
    
    // Hide all info sections when searching (MEMESCOPE will be shown)
    document.querySelectorAll('.info-section').forEach(section => {
        section.style.display = 'none';
    });
    
    const tokenFilterBar = document.getElementById('token-filter-bar');
    if (tokenFilterBar) {
        tokenFilterBar.style.display = 'none';
    }
    
    const searchInput = document.getElementById('search-input');
    const query = searchInput.value.trim();

    if (!query) {
        showToast('Please enter a search term', 'warning');
        return;
    }

    // Open MEMESCOPE dashboard to show search results
    const dashboard = document.getElementById('memescope-dashboard');
    dashboard.style.display = 'block';
    
    // Scroll to dashboard
    setTimeout(() => {
        dashboard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

    const spinner = document.getElementById('loading-spinner');
    const grid = document.getElementById('tokens-grid');
    const emptyState = document.getElementById('empty-state');

    spinner.style.display = 'block';
    grid.style.display = 'none';
    emptyState.style.display = 'none';

    try {
        showToast(`Searching for "${query}"...`, 'warning');
        
        const response = await fetch(`${API_BASE_URL}/api/search?query=${encodeURIComponent(query)}`);
        const data = await response.json();

        if (data.error) {
            throw new Error(data.error);
        }

        if (data.total === 0) {
            showToast(`No results found for "${query}"`, 'warning');
            spinner.style.display = 'none';
            emptyState.style.display = 'block';
            return;
        }

        showToast(`Found ${data.total} result(s) for "${query}"`, 'success');
        
        // Store search results as current tokens
        allTokens = data.results;
        
        // Deselect all blockchain filters (we're showing search results, not chain-specific)
        document.querySelectorAll('.blockchain-item').forEach(item => {
            item.classList.remove('active');
        });
        
        // Reset filter to show all
        currentFilter = 'all';
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.chain === 'all') {
                btn.classList.add('active');
            }
        });

        // Update stats
        updateStats();

        // Display search results
        // Load KOL activity before displaying tokens
        await loadKOLActivityMap();
        
        displayTokens(allTokens);

        spinner.style.display = 'none';
        grid.style.display = 'grid';
    } catch (error) {
        console.error('Search error:', error);
        showToast(`Search failed: ${error.message}`, 'error');
        spinner.style.display = 'none';
        emptyState.style.display = 'block';
    }
}

// ===== Navigate to Homepage =====
function goToHomepage(event) {
    if (event) {
        event.preventDefault();
    }
    
    // Hide MEMESCOPE dashboard
    const dashboard = document.getElementById('memescope-dashboard');
    if (dashboard) {
        dashboard.style.display = 'none';
    }
    
    // Show hero elements
    const hero = document.querySelector('.hero');
    if (hero) {
        const heroTitle = hero.querySelector('.hero-title');
        const heroSubtitle = hero.querySelector('.hero-subtitle');
        const memescopeBtn = hero.querySelector('.btn-primary');
        
        if (heroTitle) heroTitle.style.display = 'block';
        if (heroSubtitle) heroSubtitle.style.display = 'block';
        if (memescopeBtn) memescopeBtn.style.display = 'block';
    }
    
    // Show all info sections
    document.querySelectorAll('.info-section').forEach(section => {
        section.style.display = 'block';
    });
    
    // Show agent video
    showAgentVideo();
    
    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== Load Tokens =====
// Open MEMESCOPE Dashboard
function openMemeScope() {
    hideAITokenCallsHeader();
    aiTokenCallsSticky = false;
    activeDashboard = 'memescope';
    // Hide the agent video when opening MEMESCOPE
    hideAgentVideo();
    
    // Hide hero elements except search bar
    const hero = document.querySelector('.hero');
    if (hero) {
        // Hide title, subtitle, and memescope button but keep search
        const heroTitle = hero.querySelector('.hero-title');
        const heroSubtitle = hero.querySelector('.hero-subtitle');
        const memescopeBtn = hero.querySelector('.btn-primary');
        
        if (heroTitle) heroTitle.style.display = 'none';
        if (heroSubtitle) heroSubtitle.style.display = 'none';
        if (memescopeBtn) memescopeBtn.style.display = 'none';
        
        // Add hero-condensed class to compact it
        hero.classList.add('hero-condensed');
    }
    
    // Hide all info sections (How It Works, Technical Overview, FAQ)
    document.querySelectorAll('.info-section').forEach(section => {
        section.style.display = 'none';
    });
    
    const tokenFilterBar = document.getElementById('token-filter-bar');
    if (tokenFilterBar) {
        tokenFilterBar.style.display = 'flex';
    }
    
    console.log('🚀 Opening MEMESCOPE Dashboard...');
    const dashboard = document.getElementById('memescope-dashboard');
    const grid = document.getElementById('tokens-grid');
    
    if (!dashboard) {
        console.error('❌ Dashboard element not found!');
        return;
    }
    
    // Show dashboard
    dashboard.style.display = 'block';
    console.log('✓ Dashboard displayed');
    
    // Always load tokens when MEMESCOPE is clicked (unless they're already loading)
    // This ensures users always see tokens when they open MEMESCOPE
    const spinner = document.getElementById('loading-spinner');
    const isLoading = spinner && spinner.style.display === 'block';
    
    if (!isLoading) {
        console.log('📊 Loading tokens for All Chains...');
        // Clear any previous state and load fresh tokens
        allTokens = [];
        launchpadData = {};
        selectBlockchain('all'); // This loads tokens and selects "All Chains"
    } else {
        console.log('⏳ Tokens are already loading...');
    }
    
    // Load chain volume stats
    loadChainVolumeStats();
}
// Select blockchain filter
async function selectBlockchain(chain, loadData = true, isUserAction = false) {
    if (!isUserAction && (activeDashboard === 'ai-token-calls' || aiTokenCallsSticky)) {
        console.log(`🚫 Ignoring automatic chain switch (${chain}) while AI Token Calls dashboard is active.`);
        return;
    }
    
    if (isUserAction) {
        aiTokenCallsSticky = false;
    }
    
    if (activeDashboard !== 'memescope') {
        activeDashboard = 'memescope';
    }
    
    currentFilter = chain;
    
    const tokenFilterBar = document.getElementById('token-filter-bar');
    if (tokenFilterBar && activeDashboard !== 'ai-token-calls') {
        tokenFilterBar.style.display = 'flex';
    }
    // Hide call history sidebar when switching to other chains
    const callHistorySidebar = document.getElementById('ai-call-history-sidebar');
    if (callHistorySidebar) {
        callHistorySidebar.style.display = 'none';
    }
    const tokensContentArea = document.querySelector('.tokens-content-area');
    if (tokensContentArea) {
        tokensContentArea.classList.remove('ai-calls-layout');
        tokensContentArea.classList.remove('ai-token-calls-active');
    }
    setAiTokenPaywallState(false);
    // Update active state
    document.querySelectorAll('.blockchain-item').forEach(item => {
        item.classList.remove('active');
    });
    const chainElement = document.querySelector(`.blockchain-item[data-chain="${chain}"]`);
    if (chainElement) {
        chainElement.classList.add('active');
    }
    
    // If loadData is false, just update UI state without fetching
    if (!loadData) {
        return;
    }
    
    // Show loading spinner
    const spinner = document.getElementById('loading-spinner');
    const grid = document.getElementById('tokens-grid');
    const emptyState = document.getElementById('empty-state');
    
    spinner.style.display = 'block';
    grid.style.display = 'none';
    emptyState.style.display = 'none';
    
    try {
        if (chain === 'all') {
            // Clear any search results
            allTokens = [];
            launchpadData = {};
            
            // Load all tokens from all launchpads
            console.log('📊 Loading all tokens from all launchpads...');
            await loadTokens();
        } else {
            // Clear search results when switching chains
            allTokens = [];
            launchpadData = {};
            
            // Fetch trending tokens for selected chain
            console.log(`📈 Loading trending tokens for ${chain}...`);
            
            const response = await fetch(`${API_BASE_URL}/api/tokens/trending?chain=${chain}&limit=25`);
            const trendingTokens = await response.json();
            
            if (trendingTokens.error) {
                throw new Error(trendingTokens.error);
            }
            
            console.log(`✓ Found ${trendingTokens.length} trending tokens`);
            
            // Store in allTokens for consistency
            allTokens = trendingTokens;
            
            // Load KOL activity before displaying tokens
            await loadKOLActivityMap();
            
            // Display trending tokens
            displayTokens(trendingTokens);
            
            // Hide spinner and show grid
            spinner.style.display = 'none';
            grid.style.display = 'grid';
            
            // Scroll to tokens grid on mobile
            setTimeout(() => {
                const tokensGrid = document.getElementById('tokens-grid');
                if (tokensGrid && window.innerWidth <= 768) {
                    tokensGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 300);
        }
    } catch (error) {
        console.error('Error loading tokens:', error);
        showToast(`Failed to load tokens: ${error.message}`, 'error');
        spinner.style.display = 'none';
        emptyState.style.display = 'block';
        grid.style.display = 'none';
    }
}

// Loading guard to prevent double loading
let isLoadingTokens = false;

async function loadTokens() {
    if (activeDashboard === 'ai-token-calls' || aiTokenCallsSticky) {
        console.log('🚫 Skipping loadTokens because AI Token Calls dashboard is active');
        return;
    }
    
    // Prevent double loading
    if (isLoadingTokens) {
        console.log('⏳ Tokens already loading, skipping...');
        return;
    }
    
    const spinner = document.getElementById('loading-spinner');
    const grid = document.getElementById('tokens-grid');
    const emptyState = document.getElementById('empty-state');
    const searchInput = document.getElementById('search-input');

    // Clear search input
    if (searchInput) {
        searchInput.value = '';
    }

    isLoadingTokens = true;
    spinner.style.display = 'block';
    grid.style.display = 'none';
    emptyState.style.display = 'none';

    try {
        console.log('📡 Fetching tokens from API...');
        // Use server-side cache (no cache busting - rely on 10min server cache)
        const response = await fetch(`${API_BASE_URL}/api/launchpad/all`);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('✓ API response received:', data);
        
        // Log sample token data to verify market cap and holders
        if (data.launchpads && data.launchpads.pumpfun && data.launchpads.pumpfun.tokens && data.launchpads.pumpfun.tokens.length > 0) {
            const sampleToken = data.launchpads.pumpfun.tokens[0];
            console.log('📊 Sample Solana token data:', {
                name: sampleToken.name,
                symbol: sampleToken.symbol,
                marketCap: sampleToken.marketCap,
                holders: sampleToken.holders,
                price: sampleToken.price
            });
        }

        // Store launchpad-grouped data
        launchpadData = data.launchpads || {};
        console.log('✓ Launchpad data stored:', Object.keys(launchpadData).length, 'launchpads');
        
        // Flatten tokens for backward compatibility with search/filters
        allTokens = [];
        for (const [launchpadId, launchpad] of Object.entries(launchpadData)) {
            if (launchpad.tokens && launchpad.tokens.length > 0) {
                allTokens.push(...launchpad.tokens);
            }
        }

        console.log(`✓ Total tokens: ${allTokens.length}`);

        // Update stats
        updateStats();
        
        // Display tokens first (don't wait for KOL activity)
        displayTokensGrouped();

        spinner.style.display = 'none';
        grid.style.display = 'grid';
        
        console.log('✓ Tokens displayed successfully');
        
        // Load KOL activity asynchronously after displaying tokens (non-blocking)
        loadKOLActivityMap().then(() => {
            // Re-render tokens with KOL badges after KOL data loads
            if (allTokens.length > 0) {
                displayTokensGrouped();
            }
        }).catch(err => {
            console.error('KOL activity load failed (non-critical):', err);
        });
        
        // Fetch holder stats and market cap for Solana tokens with missing data
        fetchSolanaTokenDataAfterDisplay();
    } catch (error) {
        console.error('❌ Error loading tokens:', error);
        showToast(`Failed to load tokens: ${error.message}`, 'error');
        spinner.style.display = 'none';
        emptyState.style.display = 'block';
        grid.style.display = 'none';
    } finally {
        isLoadingTokens = false;
    }
}

// ===== Load Chain Volume Stats =====
async function loadChainVolumeStats() {
    const content = document.getElementById('chain-volume-content');
    if (!content) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/chain-volume`);
        const data = await response.json();
        
        if (data.error) {
            content.innerHTML = `<div class="chain-volume-error">Failed to load volume data</div>`;
            return;
        }
        
        const chains = (Array.isArray(data.chains) ? data.chains : [])
            .filter(chain => {
                const nameLower = (chain.name || '').toLowerCase();
                return !nameLower.includes('arbitrum');
            })
            .sort((a, b) => (parseFloat(b.volume24h) || 0) - (parseFloat(a.volume24h) || 0))
            .slice(0, 4); // show top 4 chains without Arbitrum
        if (chains.length === 0) {
            content.innerHTML = `<div class="chain-volume-empty">No volume data available</div>`;
            return;
        }
        
        // Find max volume for scaling bars
        const maxVolume = Math.max(...chains.map(c => parseFloat(c.volume24h) || 0));
        
        // Get chain key for styling
        const getChainKey = (name) => {
            const nameLower = name.toLowerCase();
            if (nameLower.includes('ethereum')) return 'ethereum';
            if (nameLower.includes('bnb')) return 'bnb';
            if (nameLower.includes('base')) return 'base';
            if (nameLower.includes('solana')) return 'solana';
            return nameLower.replace(/\s+/g, '-').toLowerCase();
        };
        
        // Render chain volume bars
        let html = '';
        chains.forEach((chain, index) => {
            const volume = parseFloat(chain.volume24h) || 0;
            const percentage = maxVolume > 0 ? (volume / maxVolume) * 100 : 0;
            const volumeFormatted = formatNumber(volume);
            const chainKey = getChainKey(chain.name);
            
            // Add small delay for animation
            const delay = index * 0.1;
            
            html += `
                <div class="chain-volume-item" data-chain="${chainKey}" style="animation-delay: ${delay}s;">
                    <div class="chain-volume-header">
                        <div class="chain-volume-chain">
                            ${chain.logo ? `<img src="${chain.logo}" alt="${chain.name}" class="chain-volume-logo">` : `<span class="chain-volume-logo-fallback">${chain.name.charAt(0)}</span>`}
                            <span class="chain-volume-name">${chain.name}</span>
                        </div>
                        <span class="chain-volume-value">$${volumeFormatted}</span>
                    </div>
                    <div class="chain-volume-bar-container">
                        <div class="chain-volume-bar" style="width: 0%; transition-delay: ${delay}s;"></div>
                    </div>
                </div>
            `;
        });
        
        content.innerHTML = html;
        
        // Animate bars after a brief delay
        setTimeout(() => {
            chains.forEach((chain, index) => {
                const volume = parseFloat(chain.volume24h) || 0;
                const percentage = maxVolume > 0 ? (volume / maxVolume) * 100 : 0;
                const bars = content.querySelectorAll('.chain-volume-bar');
                if (bars[index]) {
                    bars[index].style.width = `${percentage}%`;
                }
            });
        }, 150);
    } catch (error) {
        console.error('Error loading chain volume stats:', error);
        content.innerHTML = `<div class="chain-volume-error">Failed to load volume data</div>`;
    }
}

// ===== Update Stats =====
function updateStats() {
    // Stats section was removed from UI, but keep function for backward compatibility
    const counts = {
        bnb: 0,
        base: 0,
        ethereum: 0,
        solana: 0
    };

    allTokens.forEach(token => {
        if (counts.hasOwnProperty(token.chain)) {
            counts[token.chain]++;
        }
    });

    // Only update stats if elements exist (they were removed from UI)
    const statBnb = document.getElementById('stat-bnb');
    const statBase = document.getElementById('stat-base');
    const statEth = document.getElementById('stat-ethereum');
    const statSol = document.getElementById('stat-solana');
    
    if (statBnb) statBnb.textContent = counts.bnb;
    if (statBase) statBase.textContent = counts.base;
    if (statEth) statEth.textContent = counts.ethereum;
    if (statSol) statSol.textContent = counts.solana;
}

// ===== Display Tokens Grouped by Launchpad =====
function displayTokensGrouped() {
    if (activeDashboard === 'ai-token-calls' || aiTokenCallsSticky) {
        console.log('🚫 Skipping grouped token display while AI Token Calls is active');
        return;
    }
    
    currentTokenDisplayMode = 'grouped';
    const grid = document.getElementById('tokens-grid');
    const emptyState = document.getElementById('empty-state');
    const aiHeader = document.getElementById('ai-token-calls-header');
    const tokensContentArea = aiHeader ? aiHeader.parentElement : null;
    const callHistorySidebar = document.getElementById('ai-call-history-sidebar');
    grid.innerHTML = '';

    if (emptyState) {
        emptyState.style.display = 'none';
        const heading = emptyState.querySelector('h3');
        const paragraph = emptyState.querySelector('p');
        if (heading) heading.textContent = 'No tokens found';
        if (paragraph) paragraph.textContent = 'Try selecting a different chain or refresh the page';
    }

    let displayedTokens = 0;

        // Display tokens grouped by launchpad
        for (const [launchpadId, launchpad] of Object.entries(launchpadData)) {
            if (!launchpad.tokens || launchpad.tokens.length === 0) continue;

            let launchpadTokens = launchpad.tokens;
            if (currentFilter !== 'all') {
                launchpadTokens = launchpadTokens.filter(token => token.chain === currentFilter);
            }

            const filteredTokens = applyTokenFilters(launchpadTokens);
            if (filteredTokens.length === 0) {
                continue;
            }

            displayedTokens += filteredTokens.length;

            // Create launchpad section header
            const launchpadSection = document.createElement('div');
            launchpadSection.className = 'launchpad-section';
            launchpadSection.style.gridColumn = '1 / -1';  // Span all columns

            const launchpadHeader = document.createElement('div');
            launchpadHeader.className = 'launchpad-header';
            
            // Use Pump.fun logo instead of emoji for Pump.fun
            const launchpadIcon = launchpad.info.name === 'Pump.fun' 
                ? `<img src="pumpfun-logo.png" alt="Pump.fun" class="launchpad-header-logo">`
                : `<span class="launchpad-emoji">${launchpad.info.emoji}</span>`;
            
            launchpadHeader.innerHTML = `
                <h3>
                    ${launchpadIcon}
                    ${launchpad.info.name}
                    <span class="launchpad-chain">${launchpad.info.chain.toUpperCase()}</span>
                </h3>
                <p class="launchpad-description">${launchpad.info.description} • ${filteredTokens.length} token(s)</p>
            `;
            
            launchpadSection.appendChild(launchpadHeader);
            grid.appendChild(launchpadSection);

            // Display tokens for this launchpad
            filteredTokens.forEach(token => {
                // Debug log for Solana tokens to verify data
                if (token.chain === 'solana') {
                    console.log(`📊 Solana token card data:`, {
                        name: token.name,
                        symbol: token.symbol,
                        marketCap: token.marketCap,
                        holders: token.holders,
                        price: token.price
                    });
                }
                const card = createTokenCard(token);
                grid.appendChild(card);
            });
        }

        if (displayedTokens === 0) {
            grid.style.display = 'none';
            if (emptyState) {
                emptyState.style.display = 'block';
                const heading = emptyState.querySelector('h3');
                const paragraph = emptyState.querySelector('p');
                if (heading) heading.textContent = 'No tokens match these filters';
                if (paragraph) paragraph.textContent = 'Try adjusting the filters or resetting them.';
            }
            if (callHistorySidebar) {
                callHistorySidebar.style.display = 'none';
            }
        } else {
            grid.style.display = 'grid';
            if (emptyState) {
                emptyState.style.display = 'none';
            }
            if (callHistorySidebar && activeDashboard === 'ai-token-calls') {
                callHistorySidebar.style.display = 'block';
            }
        }

        if (aiHeader && tokensContentArea) {
            if (activeDashboard === 'ai-token-calls' && displayedTokens > 0) {
                aiHeader.style.display = 'flex';
                tokensContentArea.classList.add('ai-token-calls-active');
            } else {
                aiHeader.style.display = 'none';
                tokensContentArea.classList.remove('ai-token-calls-active');
            }
        }

        if (callHistorySidebar && activeDashboard !== 'ai-token-calls') {
            callHistorySidebar.style.display = 'none';
        }
}

// ===== Display Tokens (flat list - for search results) =====
function displayTokens(tokens) {
    if (activeDashboard === 'ai-token-calls' || aiTokenCallsSticky) {
        console.log('🚫 Skipping flat token display while AI Token Calls is active');
        return;
    }
    
    currentTokenDisplayMode = 'flat';
    console.log('📊 displayTokens called with', tokens.length, 'tokens');
    const grid = document.getElementById('tokens-grid');
    const emptyState = document.getElementById('empty-state');
    
    if (!grid) {
        console.error('❌ tokens-grid element not found!');
        return;
    }
    
    grid.innerHTML = '';

    const filteredTokens = applyTokenFilters(tokens);

    if (filteredTokens.length === 0) {
        console.log('⚠️ No tokens to display');
        if (emptyState) {
        emptyState.style.display = 'block';
            const heading = emptyState.querySelector('h3');
            const paragraph = emptyState.querySelector('p');
            if (heading) heading.textContent = 'No tokens match these filters';
            if (paragraph) paragraph.textContent = 'Try adjusting the filters or resetting them.';
        }
        grid.style.display = 'none';
        return;
    }

    if (emptyState) {
        emptyState.style.display = 'none';
        const heading = emptyState.querySelector('h3');
        const paragraph = emptyState.querySelector('p');
        if (heading) heading.textContent = 'No tokens found';
        if (paragraph) paragraph.textContent = 'Try selecting a different chain or refresh the page';
    }

    emptyState.style.display = 'none';
    grid.style.display = 'grid';
    console.log('✓ Grid set to display: grid');

    const aiHeader = document.getElementById('ai-token-calls-header');
    const tokensContentArea = aiHeader ? aiHeader.parentElement : null;
    const callHistorySidebar = document.getElementById('ai-call-history-sidebar');
    if (aiHeader) aiHeader.style.display = 'none';
    if (tokensContentArea) tokensContentArea.classList.remove('ai-token-calls-active');
    if (callHistorySidebar) callHistorySidebar.style.display = 'none';

    filteredTokens.forEach((token, index) => {
        console.log(`  Token ${index + 1}:`, token.name, token.symbol, token.chain);
        const card = createTokenCard(token);
        grid.appendChild(card);
    });
    
    console.log('✓ All token cards added to grid');
    
    // Fetch holder stats and market cap for Solana tokens with missing data
    fetchSolanaTokenDataAfterDisplay();
}

function applyTokenFilters(tokens = []) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
        return [];
    }
    
    return tokens.filter(token => {
        const volume = parseFloat(token.volume24h || token.volume_24h || 0);
        const marketCap = parseFloat(token.marketCap || token.fdv || 0);
        
        if (tokenFilterState.volumeMin !== null && !Number.isNaN(tokenFilterState.volumeMin)) {
            if (volume < tokenFilterState.volumeMin) {
                return false;
            }
        }
        
        if (tokenFilterState.marketCapMin !== null && !Number.isNaN(tokenFilterState.marketCapMin)) {
            if (marketCap < tokenFilterState.marketCapMin) {
                return false;
            }
        }
        
        if (tokenFilterState.ageMaxDays !== null && !Number.isNaN(tokenFilterState.ageMaxDays)) {
            const createdAt = token.createdAt || token.timestamp || token.launchDate;
            if (createdAt) {
                const createdDate = new Date(createdAt);
                if (!Number.isNaN(createdDate.getTime())) {
                    const ageMs = Date.now() - createdDate.getTime();
                    const maxAgeMs = tokenFilterState.ageMaxDays * 24 * 60 * 60 * 1000;
                    if (Number.isFinite(maxAgeMs) && ageMs > maxAgeMs) {
                        return false;
                    }
                }
            }
        }
        
        return true;
    });
}
function resetTokenFilters() {
    tokenFilterState = {
        volumeMin: null,
        marketCapMin: null,
        ageMaxDays: null
    };
    
    const volumeInput = document.getElementById('token-filter-volume');
    const marketCapInput = document.getElementById('token-filter-marketcap');
    const ageInput = document.getElementById('token-filter-age');
    
    if (volumeInput) volumeInput.value = '';
    if (marketCapInput) marketCapInput.value = '';
    if (ageInput) ageInput.value = '';
    
    ['volumeMin', 'marketCapMin', 'ageMaxDays'].forEach(filterKey => {
        setFilterCardActiveState(filterKey, false);
    });
    
    scheduleTokenFilterRefresh();
}
function refreshTokensView() {
    if (typeof isLoadingTokens !== 'undefined' && isLoadingTokens) {
        return;
    }
    
    if (activeDashboard === 'ai-token-calls') {
        console.log('⏭️ Skipping token grid refresh while AI Token Calls dashboard is active');
        return;
    }
    
    if (currentTokenDisplayMode === 'grouped') {
        displayTokensGrouped();
    } else {
        displayTokens(allTokens);
    }
}
// ===== Load KOL Activity =====
async function loadKOLActivityMap(force = false) {
    let controller = null;
    try {
        const now = Date.now();
        if (!force && kolActivityLastFetched && now - kolActivityLastFetched < KOL_ACTIVITY_CACHE_MS && Object.keys(kolActivityMap).length > 0) {
            return;
        }

        if (kolActivityFetchController?.abort) {
            kolActivityFetchController.abort();
        }

        controller = createAbortController();
        kolActivityFetchController = controller;

        const fetchOptions = controller?.signal ? { signal: controller.signal } : {};
        const response = await fetch(`${API_BASE_URL}/api/kol-activity`, fetchOptions);
        if (!response.ok) {
            console.log('⚠ KOL activity API not available, continuing without KOL data');
            kolActivityMap = {};
            kolActivityLastFetched = Date.now();
            if (!controller || kolActivityFetchController === controller) {
                kolActivityFetchController = null;
            }
            return;
        }
        
        const data = await response.json();
        if (controller?.signal?.aborted) {
            if (kolActivityFetchController === controller) {
                kolActivityFetchController = null;
            }
            return;
        }

        if (!data.topTokens || !Array.isArray(data.topTokens)) {
            kolActivityMap = {};
            kolActivityLastFetched = Date.now();
            if (!controller || kolActivityFetchController === controller) {
                kolActivityFetchController = null;
            }
            return;
        }
        
        // Create a map of tokenAddress -> KOL activity
        kolActivityMap = {};
        data.topTokens.forEach(token => {
            // KOL activity uses tokenAddress field, but we need to match with token.address
            const address = token.tokenAddress || token.address;
            if (address) {
                // Normalize address (lowercase for comparison)
                const normalizedAddress = address.toLowerCase();
                kolActivityMap[normalizedAddress] = {
                    kolCount: token.kolsTrading?.length || 0,
                    kolsTrading: token.kolsTrading || [],
                    totalSwaps: token.totalSwaps || 0,
                    buys: token.buys || 0,
                    sells: token.sells || 0
                };
            }
        });
        
        console.log(`✓ Loaded KOL activity for ${Object.keys(kolActivityMap).length} tokens`);
        kolActivityLastFetched = Date.now();
        if (!controller || kolActivityFetchController === controller) {
            kolActivityFetchController = null;
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            return;
        }
        console.error('Error loading KOL activity:', error);
        kolActivityMap = {};
        kolActivityLastFetched = Date.now();
        if (!controller || kolActivityFetchController === controller) {
            kolActivityFetchController = null;
        }
    } finally {
        if (controller && kolActivityFetchController === controller && controller.signal?.aborted) {
            kolActivityFetchController = null;
        }
    }
}

// ===== Fetch Solana Token Data After Display =====
async function fetchSolanaTokenDataAfterDisplay() {
    // Find all Solana token cards that need data (holders = 0 or market cap = 0)
    const tokenCards = document.querySelectorAll('.token-card');
    const solanaTokensToUpdate = [];
    
    tokenCards.forEach(card => {
        const holdersElement = card.querySelector('[data-holders]');
        const marketCapElement = card.querySelector('[data-market-cap]');
        
        if (holdersElement && marketCapElement) {
            const holders = parseInt(holdersElement.dataset.holders) || 0;
            const marketCap = parseFloat(marketCapElement.dataset.marketCap) || 0;
            const chain = holdersElement.dataset.chain || marketCapElement.dataset.chain;
            const address = holdersElement.dataset.address;
            
            // Only process Solana tokens with missing data
            if (chain === 'solana' && address && (holders === 0 || marketCap === 0)) {
                solanaTokensToUpdate.push({
                    card,
                    address,
                    holdersElement,
                    marketCapElement,
                    price: parseFloat(marketCapElement.dataset.price) || 0
                });
            }
        }
    });
    
    if (solanaTokensToUpdate.length === 0) {
        console.log('✓ All Solana tokens already have holder and market cap data');
        return;
    }
    
    console.log(`📊 Fetching holder stats and market cap for ${solanaTokensToUpdate.length} Solana tokens...`);
    
    if (solanaDetailsAbortController?.abort) {
        solanaDetailsAbortController.abort();
    }

    const controller = createAbortController();
    solanaDetailsAbortController = controller;
    const signal = controller?.signal || null;

    // Fetch data for all tokens in parallel (with rate limiting)
    const batchSize = 5; // Process 5 tokens at a time to avoid overwhelming the API
    for (let i = 0; i < solanaTokensToUpdate.length; i += batchSize) {
        const batch = solanaTokensToUpdate.slice(i, i + batchSize);
        if (signal?.aborted) {
            console.log('⏹️ Solana token detail fetch aborted (newer request triggered)');
            if (solanaDetailsAbortController === controller) {
                solanaDetailsAbortController = null;
            }
            return;
        }
        
        await Promise.allSettled(batch.map(async ({ card, address, holdersElement, marketCapElement, price }) => {
            try {
                const fetchOptions = signal ? { signal } : {};
                const response = await fetch(`${API_BASE_URL}/api/token-details/solana/${address}`, fetchOptions);
                if (!response.ok) {
                    console.warn(`⚠ Failed to fetch details for ${address}: HTTP ${response.status}`);
                    return;
                }
                
                const details = await response.json();
                if (signal?.aborted) {
                    if (solanaDetailsAbortController === controller) {
                        solanaDetailsAbortController = null;
                    }
                    return;
                }
                
                // Extract holder count
                const holders = details.holderStats?.totalHolders || 0;
                
                // Extract or calculate market cap
                let marketCap = parseFloat(details.market_cap || details.price?.usdMarketCap || 0);
                
                // If market cap is still 0 and we have price, calculate it as price × 1 billion
                if (marketCap === 0 && price > 0) {
                    marketCap = price * 1000000000; // 1 billion supply
                }
                
                // Update the holders element
                if (holders > 0 && holdersElement) {
                    holdersElement.textContent = formatWholeNumber(holders);
                    holdersElement.dataset.holders = holders;
                }
                
                // Update the market cap element
                if (marketCap > 0 && marketCapElement) {
                    marketCapElement.textContent = `$${formatNumber(marketCap)}`;
                    marketCapElement.dataset.marketCap = marketCap;
                }
                
                // Also update the token object in allTokens array for future reference
                const tokenIndex = allTokens.findIndex(t => t.address === address && t.chain === 'solana');
                if (tokenIndex >= 0) {
                    if (holders > 0) allTokens[tokenIndex].holders = holders;
                    if (marketCap > 0) allTokens[tokenIndex].marketCap = marketCap;
                }
                
                console.log(`✓ Updated ${address}: holders=${holders}, marketCap=$${marketCap}`);
            } catch (error) {
                if (signal?.aborted) {
                    if (solanaDetailsAbortController === controller) {
                        solanaDetailsAbortController = null;
                    }
                    return;
                }
                console.error(`❌ Error fetching token details for ${address}:`, error.message);
            }
        }));
        
        // Small delay between batches to avoid rate limiting
        if (i + batchSize < solanaTokensToUpdate.length && !(signal?.aborted)) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    console.log(`✓ Finished updating ${solanaTokensToUpdate.length} Solana tokens`);
    if (!controller || solanaDetailsAbortController === controller) {
        solanaDetailsAbortController = null;
    }
}
// ===== Create Token Card =====
function createTokenCard(token) {
    const card = document.createElement('div');
    card.className = 'token-card';
    
    // Add click event to open token details modal
    card.addEventListener('click', () => {
        showTokenDetailsModal(token);
    });

    const chainLogos = {
        bnb: 'bnb-logo.png',
        base: 'base-logo.png',
        ethereum: 'eth_light_3.png',
        solana: 'solana-logo.png'
    };

    const chainNames = {
        bnb: 'BNB Chain',
        base: 'Base',
        ethereum: 'Ethereum',
        solana: 'Solana'
    };

    const priceChange = parseFloat(token.priceChange24h || 0);
    const priceClass = priceChange >= 0 ? 'positive' : 'negative';
    const priceSign = priceChange >= 0 ? '+' : '';

    // Get crypto icon URL (prioritize local icons)
    const cryptoIconUrl = getCryptoIconUrl(token.symbol, token.logo);
    const logo = cryptoIconUrl 
        ? `<img src="${cryptoIconUrl}" alt="${token.name}" class="token-logo-img" onerror="this.onerror=null; this.parentElement.innerHTML='${token.symbol.charAt(0)}'">`
        : token.logo 
            ? `<img src="${token.logo}" alt="${token.name}" class="token-logo-img" onerror="this.onerror=null; this.parentElement.innerHTML='${token.symbol.charAt(0)}'">`
            : `<span class="token-logo-fallback">${token.symbol.charAt(0)}</span>`;

    const createdDate = new Date(token.createdAt).toLocaleDateString();
    const shortAddress = token.address ? `${token.address.slice(0, 6)}...${token.address.slice(-4)}` : 'N/A';
    
    // Get chain logo
    const chainLogo = chainLogos[token.chain] || '';
    const chainBadgeContent = chainLogo 
        ? `<img src="${chainLogo}" alt="${chainNames[token.chain]}" class="chain-badge-img"> ${chainNames[token.chain]}`
        : chainNames[token.chain];
    
    // Get launchpad display (with logo if Pump.fun)
    const launchpadDisplay = token.launchpad === 'Pump.fun' 
        ? `<img src="pumpfun-logo.png" alt="Pump.fun" class="launchpad-logo"> Pump.fun`
        : token.launchpad || 'N/A';
    
    // Check if token has KOL activity (kolActivityMap is initialized as empty object, safe to use)
    const tokenAddress = token.address ? token.address.toLowerCase() : '';
    const kolActivity = kolActivityMap && kolActivityMap[tokenAddress] ? kolActivityMap[tokenAddress] : null;
    const kolBadge = kolActivity && kolActivity.kolCount > 0 ? `
        <div class="kol-badge-token-card" title="Traded by ${kolActivity.kolCount} KOL${kolActivity.kolCount > 1 ? 's' : ''}">
            <i class='bx bx-user'></i>
            <span>${kolActivity.kolCount} KOL${kolActivity.kolCount > 1 ? 's' : ''}</span>
        </div>
    ` : '';

    // AI Call Performance Badge - Show X multiplier and percentage since call
    let aiPerformanceBadge = '';
    if (token.aiCall && token.multiplierSinceCall !== null && token.priceChangePercentSinceCall !== null) {
        const multiplier = token.multiplierSinceCall;
        const percentChange = token.priceChangePercentSinceCall;
        const performanceClass = percentChange >= 0 ? 'ai-performance-positive' : 'ai-performance-negative';
        const performanceIcon = percentChange >= 0 ? '📈' : '📉';
        const multiplierText = `${multiplier.toFixed(2)}x`;
        const percentText = `${percentChange >= 0 ? '+' : ''}${percentChange.toFixed(2)}%`;
        
        aiPerformanceBadge = `
            <div class="ai-call-performance ${performanceClass}">
                <div class="ai-performance-header">
                    <span class="ai-performance-label">AI Call Performance</span>
                </div>
                <div class="ai-performance-content">
                    <div class="ai-performance-multiplier">${multiplierText}</div>
                    <div class="ai-performance-percent">${percentText}</div>
                </div>
                <div class="ai-performance-subtitle">Since Call</div>
            </div>
        `;
    }

    card.innerHTML = `
        <div class="token-header">
            <div class="token-logo">${logo}</div>
            <div class="token-info">
                <div class="token-name-row">
                    <div class="token-name">${token.name || 'Unknown Token'}</div>
                    ${kolBadge}
                </div>
                <div class="token-symbol">${token.symbol || 'UNKNOWN'}</div>
            </div>
            <div class="chain-badge">${chainBadgeContent}</div>
        </div>
        ${aiPerformanceBadge}
        <div class="token-stats">
            <div class="token-stat">
                <div class="token-stat-label">Price</div>
                <div class="token-stat-value">$${formatNumber(token.price)}</div>
            </div>
            <div class="token-stat">
                <div class="token-stat-label">24h Change</div>
                <div class="token-stat-value ${priceClass}">${priceSign}${priceChange.toFixed(2)}%</div>
            </div>
        </div>

        <div class="token-details">
            <div class="token-detail-row">
                <span class="token-detail-label">Market Cap</span>
                <span class="token-detail-value" data-market-cap="${token.marketCap}" data-price="${token.price}" data-chain="${token.chain}">
                    ${token.marketCap && token.marketCap > 0 ? `$${formatNumber(token.marketCap)}` : '$0'}
                </span>
            </div>
            <div class="token-detail-row">
                <span class="token-detail-label">Holders</span>
                <span class="token-detail-value" data-holders="${token.holders || 0}" data-address="${token.address}" data-chain="${token.chain}">
                    ${token.holders && token.holders > 0 ? formatWholeNumber(token.holders) : 'Loading...'}
                </span>
            </div>
            <div class="token-detail-row">
                <span class="token-detail-label">Launchpad</span>
                <span class="token-detail-value">${launchpadDisplay}</span>
            </div>
            <div class="token-detail-row">
                <span class="token-detail-label">Created</span>
                <span class="token-detail-value">${createdDate}</span>
            </div>
            <div class="token-detail-row">
                <span class="token-detail-label">Contract</span>
                <span class="token-detail-value">${shortAddress}</span>
            </div>
        </div>

        <div class="token-actions">
            <div class="token-actions-group token-actions-group-compact">
                <button class="token-action-btn primary btn-analyze-modal" onclick="event.stopPropagation(); analyzeToken(${JSON.stringify(token).replace(/"/g, '&quot;')})">
                    <span class="btn-analyze-text">AI Analysis (1 CU)</span>
                </button>
                <button class="token-action-btn secondary btn-add-watchlist btn-watchlist-inline" onclick='event.stopPropagation(); quickAddToWatchlist("${token.chain}", "${token.address}", ${JSON.stringify(token).replace(/'/g, "&#39;")})' title="Add to Watchlist">
                    <i class='bx bxs-star'></i> Watchlist
                </button>
            </div>
        </div>
    `;

    return card;
}

// ===== Format Number =====
function formatNumber(num) {
    if (num === 0 || num === null || num === undefined) return '0';
    
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    if (num < 0.000001) return num.toExponential(2);
    if (num < 0.01) return num.toFixed(6);
    return num.toFixed(2);
}

// Format whole numbers (integers) without decimals - for holder counts, etc.
function formatWholeNumber(num) {
    if (num === 0 || num === null || num === undefined) return '0';
    
    const n = Math.round(num); // Ensure it's a whole number
    
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toLocaleString('en-US'); // Add commas for thousands
}

function getRugCheckMeta(score) {
    const value = Number(score);
    
    if (!Number.isFinite(value)) {
        return {
            status: 'pending',
            label: 'RugCheck Pending',
            description: 'Awaiting RugCheck verification',
            icon: '⏳',
            background: 'rgba(255, 255, 255, 0.06)',
            borderColor: 'rgba(255, 255, 255, 0.18)',
            accentColor: 'rgba(255, 255, 255, 0.7)'
        };
    }
    
    if (value <= 15) {
        return {
            status: 'ultra-safe',
            label: 'Very Safe',
            description: 'No critical risks detected by RugCheck',
            icon: '🛡️',
            background: 'rgba(0, 255, 170, 0.12)',
            borderColor: '#00FFA6',
            accentColor: '#6BFFD4'
        };
    }
    
    if (value <= 29) {
        return {
            status: 'safe',
            label: 'Safe',
            description: 'Passed RugCheck safety threshold (≤29)',
            icon: '✅',
            background: 'rgba(0, 212, 255, 0.12)',
            borderColor: '#00D4FF',
            accentColor: '#7FE2FF'
        };
    }
    
    if (value <= 45) {
        return {
            status: 'watch',
            label: 'Caution',
            description: 'Review RugCheck warnings before trading',
            icon: '⚠️',
            background: 'rgba(255, 184, 0, 0.12)',
            borderColor: '#FFB800',
            accentColor: '#FFD16B'
        };
    }
    
    return {
        status: 'high-risk',
        label: 'High Risk',
        description: 'RugCheck flagged significant risks',
        icon: '🚨',
        background: 'rgba(255, 71, 87, 0.12)',
        borderColor: '#FF4757',
        accentColor: '#FF7B8F'
    };
}

function formatDateTime(dateString) {
    if (!dateString) return '—';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function renderSubscriptionActivityList(usageLogs = []) {
    if (!Array.isArray(usageLogs) || usageLogs.length === 0) {
        return `<p class="subscription-empty-state">No usage history yet. Analyses and plan top-ups will appear here.</p>`;
    }
    
    const iconMap = {
        purchase: 'bx bxs-plus-circle',
        usage: 'bx bx-line-chart'
    };
    
    return `
        <ul class="subscription-activity-list">
            ${usageLogs.slice(0, 6).map(entry => {
                const type = entry.type || 'usage';
                const icon = iconMap[type] || iconMap.usage;
                const createdAt = formatDateTime(entry.createdAt);
                let title = '';
                let meta = '';
                
                if (type === 'purchase') {
                    title = `Plan purchase • ${entry.planName || entry.planId || 'Plan'}`;
                    const cuGranted = entry.cuGranted ? `+${entry.cuGranted} CU` : '';
                    const price = typeof entry.priceUsd === 'number' ? `$${entry.priceUsd.toFixed(2)}` : '';
                    meta = [createdAt, cuGranted, price].filter(Boolean).join(' • ');
                } else {
                    const units = entry.units || 0;
                    const source = entry.source ? entry.source.replace(/_/g, ' ') : 'AI Analysis';
                    title = `${source.charAt(0).toUpperCase()}${source.slice(1)} • ${units} CU`;
                    const chainInfo = entry.chain ? `Chain: ${entry.chain.toUpperCase()}` : null;
                    meta = [createdAt, chainInfo].filter(Boolean).join(' • ');
                }
                
                return `
                    <li class="subscription-activity-item ${type}">
                        <div class="activity-icon"><i class='${icon}'></i></div>
                        <div class="activity-content">
                            <div class="activity-title">${title}</div>
                            <div class="activity-meta">${meta || createdAt}</div>
                        </div>
                    </li>
                `;
            }).join('')}
        </ul>
    `;
}

function renderSubscriptionApiKeys(apiKeys = []) {
    const keysSafe = Array.isArray(apiKeys) ? apiKeys : [];
    
    if (keysSafe.length === 0) {
        return `
            <div class="subscription-api-keys-list empty">
                <p class="subscription-empty-state">No API keys yet. Generate a key to integrate with the SDK.</p>
            </div>
        `;
    }
    
    return `
        <div class="subscription-api-keys-list">
            ${keysSafe.map(key => {
                const createdAt = formatDateTime(key.createdAt);
                const lastUsed = key.lastUsedAt ? `• Last used ${formatDateTime(key.lastUsedAt)}` : '';
                const status = key.status || 'active';
                const statusLabel = status === 'revoked' ? 'Revoked' : 'Active';
                const statusClass = status === 'revoked' ? 'revoked' : 'active';
                
                return `
                    <div class="subscription-api-key ${statusClass}">
                        <div class="api-key-prefix"><code>${key.prefix || 'x402_'}••••</code></div>
                        <div class="api-key-meta">${createdAt} ${lastUsed}</div>
                        <div class="api-key-actions">
                            <span class="api-key-status ${statusClass}">${statusLabel}</span>
                            ${status !== 'revoked' ? `
                                <button class="btn-revoke-api-key" onclick="revokeSubscriptionApiKey('${key.id}', this)">
                                    <i class='bx bx-block'></i> Revoke
                                </button>
                            ` : ''}
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderSubscriptionSection(subscription, plans = []) {
    const isActive = subscription && subscription.status === 'active';
    const remainingCu = isActive ? Number(subscription.cuBalance || 0) : 0;
    const monthlyCu = isActive ? Number(subscription.monthlyCu || 0) : 0;
    const renewal = isActive ? formatDateTime(subscription.renewalDate) : '—';
    const planName = isActive ? (subscription.planName || 'Active Plan') : 'No plan active';
    const planDescription = (text) => (text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const remainingDisplay = isActive ? remainingCu : '—';
    const monthlyDisplay = isActive ? `${monthlyCu} CU` : '—';
    const renewalDisplay = isActive ? renewal : '—';
    
    const planCards = (Array.isArray(plans) ? plans : []).map(plan => {
        const isCurrent = isActive && subscription.planId === plan.id;
        const buttonLabel = isCurrent ? 'Current Plan' : (isActive ? 'Switch Plan' : 'Activate Plan');
        const planPrice = Number(plan.monthlyPriceUsd || 0);
        const planCu = Number(plan.monthlyCu || 0);
        const button = isCurrent
            ? `<button class="btn-subscribe-plan current" disabled><i class='bx bx-check'></i> Current Plan</button>`
            : `<button class="btn-subscribe-plan" onclick="purchaseSubscriptionPlan('${plan.id}', this)">
                    <i class='bx bx-rocket'></i> ${buttonLabel}
               </button>`;
        
        return `
            <div class="subscription-plan-card ${isCurrent ? 'current-plan' : ''}">
                <div class="plan-heading">
                    <h5>${plan.name}</h5>
                    <div class="plan-price">$${planPrice.toFixed(2)} <span>per package</span></div>
                </div>
                <div class="plan-cu">${planCu} Compute Units</div>
                <p class="plan-description">${planDescription(plan.description)}</p>
                ${button}
            </div>
        `;
    }).join('');
    
    const usageHtml = renderSubscriptionActivityList(subscription?.usageLogs || []);
    const apiKeysHtml = renderSubscriptionApiKeys(subscription?.apiKeys || []);
    
    return `
        <div class="wallet-subscription-section">
            <div class="subscription-summary-card">
                <div class="subscription-summary-header">
                    <h4><i class='bx bx-bolt-circle'></i> AI Analysis Subscription</h4>
                    <span class="subscription-status ${isActive ? 'active' : 'inactive'}">
                        ${isActive ? 'Active' : 'Inactive'}
                    </span>
                </div>
                <div class="subscription-summary-grid">
                    <div class="summary-item">
                        <span class="summary-label">Plan</span>
                        <span class="summary-value">${planName}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Remaining CU</span>
                        <span class="summary-value">${remainingDisplay}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Monthly Allocation</span>
                        <span class="summary-value">${monthlyDisplay}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Next Renewal</span>
                        <span class="summary-value">${renewalDisplay}</span>
                    </div>
                </div>
                ${!isActive ? `
                    <div class="subscription-summary-note">
                        Choose a plan below to unlock AI analyses. Each analysis costs 1 Compute Unit (CU).
                    </div>
                ` : ''}
            </div>
            
            <div class="subscription-plan-grid">
                ${planCards}
            </div>
            
            <div class="subscription-api-keys">
                <div class="subscription-api-keys-header">
                    <h4><i class='bx bx-key'></i> SDK API Keys</h4>
                    <button class="btn-generate-api-key" onclick="generateSubscriptionApiKey(this)">
                        <i class='bx bx-plus-circle'></i> Generate API Key
                    </button>
                </div>
                ${apiKeysHtml}
                <p class="subscription-api-note">
                    API keys are shown only once after creation. Keep them secure and regenerate if exposed.
                </p>
            </div>
            
            <div class="subscription-activity">
                <h4><i class='bx bx-history'></i> Recent Activity</h4>
                ${usageHtml}
            </div>
        </div>
    `;
}

// ===== Filter Tokens =====
function filterTokens(chain) {
    currentFilter = chain;

    // Update active button
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.chain === chain) {
            btn.classList.add('active');
        }
    });

    // Filter and display
    const filtered = chain === 'all' 
        ? allTokens 
        : allTokens.filter(token => token.chain === chain);

    displayTokens(filtered);
}

// ===== Analyze Token =====
async function analyzeToken(token) {
    // Handle token passed as string from HTML onclick
    if (typeof token === 'string') {
        try {
            token = JSON.parse(token.replace(/&quot;/g, '"'));
        } catch (e) {
            console.error('Error parsing token:', e);
            showToast('Invalid token data', 'error');
            return;
        }
    }
    
    // Show modal with loading state
    const modal = document.getElementById('analysis-modal');
    const modalBody = document.getElementById('modal-body');
    modal.classList.add('active');
    modalBody.innerHTML = `
        <div class="analysis-loading">
            <div class="spinner"></div>
            <p>Collecting comprehensive token data...</p>
            <p class="loading-subtitle">Fetching market data, holder stats, and Twitter insights...</p>
        </div>
    `;

    try {
        // Request analysis (payment required)
        const response = await fetch(`${API_BASE_URL}/api/analyze`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include', // Include cookies for session
            body: JSON.stringify({ 
                tokenData: token,
                chain: token.chain,
                address: token.address
            })
        });

        if (response.ok) {
            // Analysis received
            const data = await response.json();
            
            // Mark analysis as paid
            markAnalysisAsPaid(token.chain, token.address);
            
            showAnalysisModal(token, data.analysis, data.llmUsed, false);
            showToast('Analysis complete!', 'success');
            
            // If token details modal is open, refresh trading indicators
            const tokenDetailsModal = document.getElementById('token-details-modal');
            if (tokenDetailsModal && tokenDetailsModal.classList.contains('active')) {
                // Reload token details to show unlocked indicators
                const currentToken = { chain: token.chain, address: token.address };
                showTokenDetailsModal(currentToken);
            }
        } else if (response.status === 402) {
            // Open-source: Should not receive 402 errors (no payment required)
            // If we do, it's likely an API key issue
            const errorData = await response.json().catch(() => ({}));
            modal.classList.remove('active');
            const warningMessage = errorData.message || 'Analysis failed. Please check your API keys in .env file.';
            showToast(warningMessage, 'warning');
        } else {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || 'Analysis failed');
        }
    } catch (error) {
        console.error('Error analyzing token:', error);
        const modal = document.getElementById('analysis-modal');
        modal.classList.remove('active');
        showToast(error.message || 'Analysis failed. Please try again.', 'error');
    }
}

// ===== Show Payment Modal =====
// Open-source: Payment modal removed - no payment required
async function showPaymentModal(paymentInfo = {}) {
    console.log('Payment modal called (open-source: no payment required)');
}

// ===== Close Payment Modal =====
function closePaymentModal() {
    const modal = document.getElementById('payment-modal');
    modal.classList.remove('active');
}

// ===== Process Payment =====
async function processPayment() {
        if (!currentUser) {
        window.location.href = `${API_BASE_URL}/api/auth/google`;
            return;
        }

    openSubscriptionPlansFromModal();
}

function openSubscriptionPlansFromModal() {
        closePaymentModal();
    const analysisModal = document.getElementById('analysis-modal');
    if (analysisModal) {
        analysisModal.classList.remove('active');
    }

    showToast('Opening subscription dashboard…', 'info');
    openWalletDashboard();

    setTimeout(() => {
        const subscriptionSection = document.querySelector('#wallet-dashboard-body .wallet-subscription-section');
        if (subscriptionSection) {
            subscriptionSection.classList.add('highlight-subscription');
            subscriptionSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            setTimeout(() => subscriptionSection.classList.remove('highlight-subscription'), 2000);
        }
    }, 600);
}
// ===== Show Analysis Modal =====
function showAnalysisModal(token, analysis, llmUsed, isPreview = false) {
    const modal = document.getElementById('analysis-modal');
    const modalBody = document.getElementById('modal-body');

    // Debug: Log if twitterInsights is present
    console.log('📊 showAnalysisModal called with:', {
        tokenName: token.name,
        hasAnalysis: !!analysis,
        hasTwitterInsights: !!analysis?.twitterInsights,
        twitterInsightsValue: analysis?.twitterInsights ? analysis.twitterInsights.substring(0, 100) + '...' : 'NULL',
        isPreview: isPreview
    });

    const riskClass = `risk-${(analysis.risk || 'Medium').toLowerCase().replace(' ', '-')}`;
    const opportunities = Array.isArray(analysis.opportunities) 
        ? analysis.opportunities 
        : [analysis.opportunities || 'No specific opportunities identified'];
    const warnings = Array.isArray(analysis.warnings) 
        ? analysis.warnings 
        : [analysis.warnings || 'No specific warnings identified'];
    
    const riskScore = analysis.riskScore || 50;
    const securityScore = analysis.securityScore || 60;
    const confidence = analysis.confidence || 65;
    const recommendation = analysis.recommendation || 'Hold';
    const recommendationClass = recommendation.toLowerCase() === 'buy' ? 'recommendation-buy' : 
                                 recommendation.toLowerCase() === 'avoid' ? 'recommendation-avoid' : 
                                 recommendation.toLowerCase() === 'speculate' ? 'recommendation-speculate' : 'recommendation-hold';

    modalBody.innerHTML = `
        <div class="analysis-header">
            <div class="analysis-header-content">
                <div class="analysis-token-info">
                    <h2 class="analysis-title">🤖 AI Analysis: ${token.name || 'Token'}</h2>
                    <p class="analysis-meta">
                        <span class="analysis-llm">Powered by ${llmUsed === 'gemini' ? 'Gemini AI' : llmUsed === 'chatgpt' ? 'ChatGPT' : 'AI'}</span>
                        <span class="analysis-divider">•</span>
                        <span class="analysis-time">${new Date().toLocaleString()}</span>
                    </p>
                </div>
                <div class="analysis-scores-header">
                    <div class="score-card risk-score">
                        <div class="score-label">Risk Score</div>
                        <div class="score-value ${riskScore < 40 ? 'low-risk' : riskScore < 70 ? 'medium-risk' : 'high-risk'}">${riskScore}</div>
                    </div>
                    <div class="score-card security-score">
                        <div class="score-label">Security</div>
                        <div class="score-value ${securityScore >= 70 ? 'high-security' : securityScore >= 50 ? 'medium-security' : 'low-security'}">${securityScore}</div>
                    </div>
                    <div class="score-card confidence-score">
                        <div class="score-label">Confidence</div>
                        <div class="score-value">${confidence}%</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="analysis-executive-summary">
            <div class="summary-icon">📋</div>
            <div class="summary-content">
                <h3>Executive Summary</h3>
                <p>${analysis.summary || analysis.detailedAnalysis || 'No summary available'}</p>
            </div>
        </div>

        <div class="analysis-grid">
            <div class="analysis-section risk-section">
                <div class="section-header">
                    <h3>📊 Risk Assessment</h3>
                    <div class="risk-badge ${riskClass}">${analysis.risk || 'Medium'} Risk</div>
                </div>
                <div class="risk-score-visual">
                    <div class="risk-bar-container">
                        <div class="risk-bar-fill" style="width: ${riskScore}%; background: ${riskScore < 40 ? '#00FF88' : riskScore < 70 ? '#FFB800' : '#FF4757'}"></div>
                    </div>
                    <div class="risk-score-text">Risk Score: ${riskScore}/100</div>
                </div>
            </div>

            <div class="analysis-section recommendation-section ${recommendationClass}">
                <div class="section-header">
                    <h3>🎯 Recommendation</h3>
                </div>
                <div class="recommendation-content">
                    <div class="recommendation-main ${recommendationClass}">${recommendation}</div>
                    <p class="recommendation-reason">${analysis.recommendationReason || 'Based on comprehensive analysis'}</p>
                </div>
            </div>
        </div>

        <div class="analysis-section detailed-section">
            <h3>📖 Detailed Analysis</h3>
            <div class="detailed-analysis-content">
                <p>${analysis.detailedAnalysis || analysis.summary || 'Comprehensive analysis based on all available token data.'}</p>
            </div>
        </div>

        ${analysis.keyMetrics && Object.keys(analysis.keyMetrics).length > 0 ? `
            <div class="analysis-section metrics-section">
                <h3>📈 Key Metrics Analysis</h3>
                <div class="metrics-analysis-grid">
                    ${Object.entries(analysis.keyMetrics).map(([key, value]) => `
                        <div class="metric-analysis-item">
                            <div class="metric-name">${key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1')}</div>
                            <div class="metric-analysis">${value}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        ` : ''}

        <div class="analysis-grid">
            <div class="analysis-section opportunities-section">
                <div class="section-header">
                    <h3>💡 Key Opportunities</h3>
                    <span class="opportunities-count">${opportunities.length}</span>
                </div>
                <ul class="analysis-list opportunities-list">
                    ${opportunities.map((opp, idx) => `
                        <li class="opportunity-item">
                            <span class="opportunity-icon">✨</span>
                            <span class="opportunity-text">${opp}</span>
                        </li>
                    `).join('')}
                </ul>
            </div>

            <div class="analysis-section warnings-section">
                <div class="section-header">
                    <h3>⚠️ Warning Signs</h3>
                    <span class="warnings-count">${warnings.length}</span>
                </div>
                <ul class="analysis-list warnings-list">
                    ${warnings.map((warn, idx) => `
                        <li class="warning-item">
                            <span class="warning-icon">⚠️</span>
                            <span class="warning-text">${warn}</span>
                        </li>
                    `).join('')}
                </ul>
            </div>
        </div>

        ${analysis.twitterInsights ? `
        <div class="analysis-section twitter-insights-section">
            <div class="section-header">
                <h3><i class='bx bxl-twitter'></i> Twitter/Community Insights</h3>
                <span class="twitter-badge">Powered by Grok AI</span>
            </div>
            <div class="twitter-insights-content">
                ${formatTwitterInsights(analysis.twitterInsights)}
            </div>
        </div>
        ` : ''}

        <div class="analysis-section confidence-section">
            <div class="confidence-header">
                <h3>📈 Confidence Score</h3>
                <span class="confidence-percentage">${confidence}%</span>
            </div>
            <div class="confidence-bar-container">
                <div class="confidence-bar">
                    <div class="confidence-fill" style="width: ${confidence}%; background: ${confidence >= 70 ? 'linear-gradient(90deg, #00FF88, #00D4FF)' : confidence >= 50 ? 'linear-gradient(90deg, #FFB800, #FFA500)' : 'linear-gradient(90deg, #FF4757, #FF6B7A)'}"></div>
                </div>
                <div class="confidence-label">Based on data completeness and signal clarity</div>
            </div>
        </div>

        <!-- Trading Indicators Section -->
        <div class="analysis-section trading-indicators-analysis-section">
            <div class="section-header">
                <h3><i class='bx bx-line-chart'></i> Trading Indicators</h3>
            </div>
            <div id="analysis-modal-trading-indicators" class="trading-indicators-container">
                <div class="indicators-loading">
                    <div class="spinner"></div>
                    <p>Loading trading indicators...</p>
                </div>
            </div>
        </div>

    `;

    modal.classList.add('active');
    
    // Load trading indicators after modal is shown
    setTimeout(async () => {
        try {
            // Fetch token details to get comprehensive data for trading indicators
            const detailsResponse = await fetch(`${API_BASE_URL}/api/token-details/${token.chain}/${token.address}`);
            if (detailsResponse.ok) {
                const details = await detailsResponse.json();
                if (!details.error) {
                    // Create trading indicators in the analysis modal
                    const analysisIndicatorsContainer = document.getElementById('analysis-modal-trading-indicators');
                    if (analysisIndicatorsContainer) {
                        await createTradingIndicatorsForAnalysisModal(token, details, analysisIndicatorsContainer);
                    }
                }
            }
        } catch (error) {
            console.error('Error loading trading indicators for analysis modal:', error);
            const analysisIndicatorsContainer = document.getElementById('analysis-modal-trading-indicators');
            if (analysisIndicatorsContainer) {
                analysisIndicatorsContainer.innerHTML = `
                    <div class="token-no-data">
                        <p>Could not load trading indicators</p>
                    </div>
                `;
            }
        }
    }, 100);
}

// ===== Close Modal =====
function closeModal() {
    const modal = document.getElementById('analysis-modal');
    modal.classList.remove('active');
}
// ===== Show Toast =====
function showToast(message, type = 'success') {
    try {
        const toast = document.getElementById('toast');
        if (!toast) {
            console.warn('Toast element not found, message:', message);
            return;
        }
        toast.textContent = message;
        toast.className = `toast ${type}`;
        toast.classList.add('show');

        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    } catch (error) {
        console.error('Toast error:', error, 'Message was:', message);
    }
}

// ===== Auto Refresh =====
// Auto-refresh disabled to reduce API calls and improve performance
// function setupAutoRefresh() {
//     // Refresh tokens every 5 minutes
//     setInterval(() => {
//         loadTokens();
//         checkApiHealth();
//     }, 5 * 60 * 1000);
// }

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
        closePaymentModal();
        closeTokenDetailsModal();
    }
});

// ===== Token Details Modal =====
async function showTokenDetailsModal(token) {
    const modal = document.getElementById('token-details-modal');
    const modalBody = document.getElementById('token-details-body');
    
    // Show modal with loading state
    modal.classList.add('active');
    modalBody.innerHTML = `
        <div class="loading-spinner">
            <div class="spinner"></div>
            <p>Loading token details...</p>
        </div>
    `;
    
    try {
        // Fetch detailed token data
        const response = await fetch(`${API_BASE_URL}/api/token-details/${token.chain}/${token.address}`);
        const details = await response.json();
        
        if (details.error) {
            throw new Error(details.error);
        }
        
        // Render detailed token information
        renderTokenDetails(token, details);
    } catch (error) {
        console.error('Error fetching token details:', error);
        modalBody.innerHTML = `
            <div class="token-no-data">
                <h3>⚠️ Error Loading Token Details</h3>
                <p>${error.message}</p>
                <button class="token-action-btn primary" onclick="closeTokenDetailsModal()">Close</button>
            </div>
        `;
    }
}
function renderTokenDetails(token, details) {
    const modalBody = document.getElementById('token-details-body');
    
    const chainLogos = {
        bnb: 'bnb-logo.png',
        base: 'base-logo.png',
        ethereum: 'eth_light_3.png',
        solana: 'solana-logo.png'
    };
    
    const chainNames = {
        bnb: 'BNB Chain',
        base: 'Base',
        ethereum: 'Ethereum',
        solana: 'Solana'
    };
    
    // Extract data - use details from token-details API or fallback to token data
    const metadata = details.metadata || {};
    const price = details.price || {};
    const stats = details.stats || {};
    const pairs = details.pairs || [];
    const transfers = details.transfers || [];
    
    // Use token-details API response (Moralis Discovery API format with underscores)
    const tokenName = details.token_name || metadata.name || token.name || 'Unknown Token';
    const tokenSymbol = details.token_symbol || metadata.symbol || token.symbol || 'UNKNOWN';
    const tokenLogoRaw = details.token_logo || metadata.logo || token.logo;
    // Use crypto icon helper to prioritize local icons
    const tokenLogo = getCryptoIconUrl(tokenSymbol, tokenLogoRaw) || tokenLogoRaw;
    const tokenDecimals = metadata.decimals || token.decimals || 18;
    
    // Extract price and market data from Moralis response
    const currentPrice = parseFloat(details.price_usd || price.usdPrice || token.price || 0);
    const priceChange = parseFloat(details.price_percent_change_usd?.['1d'] || price['24hrPercentChange'] || token.priceChange24h || 0);
    const marketCap = parseFloat(details.market_cap || token.marketCap || 0);
    const fullyDilutedValuation = parseFloat(details.fully_diluted_valuation || 0);
    
    // Extract liquidity from liquidity_change_usd (use 1d as baseline, add to get current)
    const liquidityChange1d = parseFloat(details.liquidity_change_usd?.['1d'] || 0);
    const liquidity = liquidityChange1d > 0 ? liquidityChange1d : parseFloat(token.liquidity || 0);
    
    // Extract volume from volume_change_usd
    const volume24h = parseFloat(details.volume_change_usd?.['1d'] || stats.volume_24h || 0);
    
    // Extract holder count (use absolute value of 1d change as current holders)
    const holdersChange1d = details.holders_change?.['1d'] || 0;
    const tokenHolders = Math.abs(holdersChange1d) || token.holders || 0;
    
    const priceChangeClass = priceChange >= 0 ? 'positive' : 'negative';
    const priceChangeSign = priceChange >= 0 ? '+' : '';
    
    // Fetch DEXScreener paid status
    let dexScreenerPaidStatus = null;
    checkDexScreenerPaidStatus(token.chain, token.address).then(status => {
        dexScreenerPaidStatus = status;
        updateDexScreenerBadge(status);
    });
    
    // Build HTML
    let html = `
        <!-- Header -->
        <div class="token-details-header">
            <div class="token-details-header-content">
                <div class="token-details-logo">
                    ${tokenLogo 
                        ? `<img src="${tokenLogo}" alt="${tokenName}" class="token-details-logo-img" onerror="this.onerror=null; this.parentElement.innerHTML='<span class=\\'token-details-logo-fallback\\'>${tokenSymbol.charAt(0)}</span>'">`
                        : `<span class="token-details-logo-fallback">${tokenSymbol.charAt(0)}</span>`}
                </div>
                <div class="token-details-info">
                    <h2>${tokenName}</h2>
                    <div class="token-details-symbol">${tokenSymbol}</div>
                    <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                        <div class="token-details-chain-badge">
                            <img src="${chainLogos[token.chain]}" alt="${chainNames[token.chain]}" class="chain-badge-img"> ${chainNames[token.chain]}
                        </div>
                        <div id="dexscreener-badge" class="dexscreener-status-badge" style="display: none;">
                            <span class="badge-loading">Checking DEX status...</span>
                        </div>
                    </div>
                </div>
                <div class="token-details-header-right">
                    <div class="token-details-contract-address">
                        <span class="contract-label">Contract</span>
                        <div class="contract-value-row">
                            <span class="contract-value">${token.address ? `${token.address.slice(0, 8)}...${token.address.slice(-6)}` : 'N/A'}</span>
                            <button class="contract-copy-btn" onclick="event.stopPropagation(); copyToClipboard('${token.address || ''}')" title="Copy full address">
                                <i class='bx bx-copy'></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Body -->
        <div class="token-details-body">
            <!-- Price Section -->
            <div class="token-details-section">
                <h3><i class='bx bx-dollar'></i> Current Price</h3>
                <div class="token-price-main">$${formatNumber(currentPrice)}</div>
                <div class="token-price-change ${priceChangeClass}">
                    ${priceChangeSign}${priceChange.toFixed(2)}% (24h)
                </div>
            </div>
            
            <!-- Stats Grid -->
            <div class="token-details-section">
                <h3><i class='bx bx-bar-chart-alt-2'></i> Market Stats</h3>
                <div class="token-stats-grid">
                    ${marketCap > 0 ? `
                        <div class="token-stat-item">
                            <div class="token-stat-label">Market Cap</div>
                            <div class="token-stat-value">$${formatNumber(marketCap)}</div>
                        </div>
                    ` : ''}
                    ${fullyDilutedValuation > 0 ? `
                        <div class="token-stat-item">
                            <div class="token-stat-label">Fully Diluted Valuation</div>
                            <div class="token-stat-value">$${formatNumber(fullyDilutedValuation)}</div>
                        </div>
                    ` : ''}
                    ${volume24h > 0 ? `
                        <div class="token-stat-item">
                            <div class="token-stat-label">24h Volume</div>
                            <div class="token-stat-value">$${formatNumber(volume24h)}</div>
                        </div>
                    ` : ''}
                    ${liquidity > 0 ? `
                        <div class="token-stat-item">
                            <div class="token-stat-label">Liquidity (24h Change)</div>
                            <div class="token-stat-value">$${formatNumber(liquidity)}</div>
                        </div>
                    ` : ''}
                    ${details.token_age_in_days ? `
                        <div class="token-stat-item">
                            <div class="token-stat-label">Token Age</div>
                            <div class="token-stat-value">${details.token_age_in_days} days</div>
                        </div>
                    ` : ''}
                    ${details.on_chain_strength_index !== null && details.on_chain_strength_index !== undefined ? `
                        <div class="token-stat-item">
                            <div class="token-stat-label">On-Chain Strength</div>
                            <div class="token-stat-value ${details.on_chain_strength_index > 0 ? 'positive' : 'negative'}">${details.on_chain_strength_index}</div>
                        </div>
                    ` : ''}
                    <div class="token-stat-item">
                        <div class="token-stat-label">Decimals</div>
                        <div class="token-stat-value">${tokenDecimals}</div>
                    </div>
                </div>
            </div>
            
            ${details.holderStats || token.holders ? `
            <!-- Holder Statistics -->
            <div class="token-details-section">
                <h3><i class='bx bx-group'></i> Holder Statistics</h3>
                <div class="holder-stats-container">
                    <div class="holder-stats-main">
                        <div class="holder-stats-total">
                            <div class="holder-stats-label">Total Holders</div>
                            <div class="holder-stats-value">${formatWholeNumber(details.holderStats?.totalHolders || token.holders || 0)}</div>
                        </div>
                    </div>
                    ${details.holderStats && (token.chain === 'solana' || ['bnb', 'base', 'ethereum', 'eth'].includes(token.chain.toLowerCase())) ? `
                    <div class="holder-stats-breakdown">
                        <div class="holder-stats-title">Acquisition Method Breakdown</div>
                        <div class="holder-stats-methods">
                            <div class="holder-method-item swap-method">
                                <div class="method-icon">🔄</div>
                                <div class="method-info">
                                    <div class="method-label">Swap</div>
                                    <div class="method-value">${formatWholeNumber(details.holderStats.holdersByAcquisition?.swap || 0)}</div>
                                    <div class="method-percentage">${details.holderStats.totalHolders > 0 ? ((details.holderStats.holdersByAcquisition?.swap || 0) / details.holderStats.totalHolders * 100).toFixed(1) : 0}%</div>
                                </div>
                            </div>
                            <div class="holder-method-item transfer-method">
                                <div class="method-icon">↔️</div>
                                <div class="method-info">
                                    <div class="method-label">Transfer</div>
                                    <div class="method-value">${formatWholeNumber(details.holderStats.holdersByAcquisition?.transfer || 0)}</div>
                                    <div class="method-percentage">${details.holderStats.totalHolders > 0 ? ((details.holderStats.holdersByAcquisition?.transfer || 0) / details.holderStats.totalHolders * 100).toFixed(1) : 0}%</div>
                                </div>
                            </div>
                            <div class="holder-method-item airdrop-method">
                                <div class="method-icon">🎁</div>
                                <div class="method-info">
                                    <div class="method-label">Airdrop</div>
                                    <div class="method-value">${formatWholeNumber(details.holderStats.holdersByAcquisition?.airdrop || 0)}</div>
                                    <div class="method-percentage">${details.holderStats.totalHolders > 0 ? ((details.holderStats.holdersByAcquisition?.airdrop || 0) / details.holderStats.totalHolders * 100).toFixed(1) : 0}%</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    ${details.holderStats.holderChange ? `
                    <div class="holder-stats-changes">
                        <div class="holder-stats-title">Holder Changes</div>
                        <div class="holder-changes-grid">
                            ${details.holderStats.holderChange['24h'] ? `
                                <div class="holder-change-item">
                                    <div class="change-label">24h</div>
                                    <div class="change-value ${(details.holderStats.holderChange['24h'].change || 0) >= 0 ? 'positive' : 'negative'}">
                                        ${(details.holderStats.holderChange['24h'].change || 0) >= 0 ? '+' : ''}${details.holderStats.holderChange['24h'].change || 0}
                                    </div>
                                    <div class="change-percentage">${(details.holderStats.holderChange['24h'].changePercent || 0) >= 0 ? '+' : ''}${(details.holderStats.holderChange['24h'].changePercent || 0).toFixed(2)}%</div>
                                </div>
                            ` : ''}
                            ${details.holderStats.holderChange['7d'] ? `
                                <div class="holder-change-item">
                                    <div class="change-label">7d</div>
                                    <div class="change-value ${(details.holderStats.holderChange['7d'].change || 0) >= 0 ? 'positive' : 'negative'}">
                                        ${(details.holderStats.holderChange['7d'].change || 0) >= 0 ? '+' : ''}${details.holderStats.holderChange['7d'].change || 0}
                                    </div>
                                    <div class="change-percentage">${(details.holderStats.holderChange['7d'].changePercent || 0) >= 0 ? '+' : ''}${(details.holderStats.holderChange['7d'].changePercent || 0).toFixed(2)}%</div>
                                </div>
                            ` : ''}
                            ${details.holderStats.holderChange['30d'] ? `
                                <div class="holder-change-item">
                                    <div class="change-label">30d</div>
                                    <div class="change-value ${(details.holderStats.holderChange['30d'].change || 0) >= 0 ? 'positive' : 'negative'}">
                                        ${(details.holderStats.holderChange['30d'].change || 0) >= 0 ? '+' : ''}${details.holderStats.holderChange['30d'].change || 0}
                                    </div>
                                    <div class="change-percentage">${(details.holderStats.holderChange['30d'].changePercent || 0) >= 0 ? '+' : ''}${(details.holderStats.holderChange['30d'].changePercent || 0).toFixed(2)}%</div>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                    ` : ''}
                    ${details.holderStats.holderSupply ? `
                    <div class="holder-stats-supply">
                        <div class="holder-stats-title">Holder Concentration</div>
                        <div class="holder-supply-list">
                            ${details.holderStats.holderSupply.top10 ? `
                                <div class="supply-item">
                                    <div class="supply-label">Top 10 Holders</div>
                                    <div class="supply-percentage">${(details.holderStats.holderSupply.top10.supplyPercent || 0).toFixed(1)}%</div>
                                </div>
                            ` : ''}
                            ${details.holderStats.holderSupply.top25 ? `
                                <div class="supply-item">
                                    <div class="supply-label">Top 25 Holders</div>
                                    <div class="supply-percentage">${(details.holderStats.holderSupply.top25.supplyPercent || 0).toFixed(1)}%</div>
                                </div>
                            ` : ''}
                            ${details.holderStats.holderSupply.top50 ? `
                                <div class="supply-item">
                                    <div class="supply-label">Top 50 Holders</div>
                                    <div class="supply-percentage">${(details.holderStats.holderSupply.top50.supplyPercent || 0).toFixed(1)}%</div>
                                </div>
                            ` : ''}
                            ${details.holderStats.holderSupply.top100 ? `
                                <div class="supply-item">
                                    <div class="supply-label">Top 100 Holders</div>
                                    <div class="supply-percentage">${(details.holderStats.holderSupply.top100.supplyPercent || 0).toFixed(1)}%</div>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                    ` : ''}
                    ${details.holderStats.holderDistribution ? `
                    <div class="holder-stats-distribution">
                        <div class="holder-stats-title">Holder Distribution by Size</div>
                        <div class="holder-distribution-grid">
                            ${details.holderStats.holderDistribution.whales ? `
                                <div class="distribution-item">
                                    <div class="distribution-icon">🐋</div>
                                    <div class="distribution-label">Whales</div>
                                    <div class="distribution-value">${formatWholeNumber(details.holderStats.holderDistribution.whales)}</div>
                                </div>
                            ` : ''}
                            ${details.holderStats.holderDistribution.sharks ? `
                                <div class="distribution-item">
                                    <div class="distribution-icon">🦈</div>
                                    <div class="distribution-label">Sharks</div>
                                    <div class="distribution-value">${formatWholeNumber(details.holderStats.holderDistribution.sharks)}</div>
                                </div>
                            ` : ''}
                            ${details.holderStats.holderDistribution.dolphins ? `
                                <div class="distribution-item">
                                    <div class="distribution-icon">🐬</div>
                                    <div class="distribution-label">Dolphins</div>
                                    <div class="distribution-value">${formatWholeNumber(details.holderStats.holderDistribution.dolphins)}</div>
                                </div>
                            ` : ''}
                            ${details.holderStats.holderDistribution.fish ? `
                                <div class="distribution-item">
                                    <div class="distribution-icon">🐟</div>
                                    <div class="distribution-label">Fish</div>
                                    <div class="distribution-value">${formatWholeNumber(details.holderStats.holderDistribution.fish)}</div>
                                </div>
                            ` : ''}
                            ${details.holderStats.holderDistribution.shrimps ? `
                                <div class="distribution-item">
                                    <div class="distribution-icon">🦐</div>
                                    <div class="distribution-label">Shrimps</div>
                                    <div class="distribution-value">${formatWholeNumber(details.holderStats.holderDistribution.shrimps)}</div>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                    ` : ''}
                    ` : ''}
                </div>
            </div>
            ` : ''}
            
            <!-- Security Score Radar -->
            <div class="token-details-section">
                <h3><i class='bx bx-shield-quarter'></i> Token Health Score</h3>
                <div class="security-score-container">
                    <canvas id="security-radar-chart"></canvas>
                    <div id="security-score-legend" class="security-score-legend"></div>
                </div>
            </div>
            
            <!-- Trading Indicators -->
            <div class="token-details-section">
                <h3><i class='bx bx-line-chart'></i> Trading Indicators</h3>
                <div id="trading-indicators-container" class="trading-indicators-container">
                    <div class="indicators-loading">
                        <div class="spinner"></div>
                        <p>Checking analysis status...</p>
                    </div>
                </div>
            </div>
            
            <!-- RugCheck Report (Solana only) -->
            ${token.chain === 'solana' ? `
                <div class="token-details-section">
                    <h3><i class='bx bx-shield-alt-2'></i> RugCheck Analysis</h3>
                    <div id="rugcheck-container" class="rugcheck-container">
                        <div class="rugcheck-loading">
                            <div class="spinner"></div>
                            <p>Running rug check analysis...</p>
                        </div>
                    </div>
                </div>
            ` : ''}
            
            <!-- Chart -->
            <div class="token-details-section">
                <h3><i class='bx bx-trending-up'></i> Price Chart</h3>
                <div class="token-chart-container">
                    <iframe 
                        class="token-chart-iframe"
                        src="${getDexScreenerEmbedUrl(details.dexScreenerUrl)}"
                        title="${tokenName} Chart"
                        frameborder="0"
                        allowfullscreen
                    ></iframe>
                </div>
            </div>
            
            
            <!-- Liquidity Pairs -->
            ${pairs.length > 0 ? `
                <div class="token-details-section">
                    <h3><i class='bx bx-water'></i> Liquidity Pairs</h3>
                    <div class="token-pairs-list">
                        ${pairs.slice(0, 5).map(pair => `
                            <div class="token-pair-item">
                                <div>
                                    <div class="token-pair-name">${pair.pairLabel || 'Unknown Pair'}</div>
                                    <div class="token-pair-exchange">${pair.exchangeName || 'Unknown DEX'}</div>
                                </div>
                                <div class="token-pair-liquidity">
                                    ${pair.liquidityUsd ? `$${formatNumber(pair.liquidityUsd)}` : 'N/A'}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            
            <!-- Recent Transfers (Solana only) -->
            ${token.chain === 'solana' && transfers.length > 0 ? `
                <div class="token-details-section">
                    <h3><i class='bx bx-transfer'></i> Recent Transfers</h3>
                    <div class="token-transfers-list">
                        ${transfers.slice(0, 10).map(transfer => {
                            const amount = (parseInt(transfer.value) / Math.pow(10, tokenDecimals)).toFixed(4);
                            return `
                                <div class="token-transfer-item">
                                    <div class="token-transfer-from-to">
                                        ${transfer.from_address?.slice(0, 6)}...${transfer.from_address?.slice(-4)} 
                                        → 
                                        ${transfer.to_address?.slice(0, 6)}...${transfer.to_address?.slice(-4)}
                                    </div>
                                    <div class="token-transfer-amount">${amount} ${tokenSymbol}</div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            ` : ''}
            
            <!-- Action Buttons -->
            <div class="token-details-section">
                <div class="token-actions">
                    <button class="token-action-btn secondary" onclick="window.open('${details.explorerUrl}', '_blank')">
                        <i class='bx bx-search'></i> View on Explorer
                    </button>
                    <button class="token-action-btn secondary" onclick="window.open('${details.dexScreenerUrl}', '_blank')">
                        <i class='bx bx-bar-chart-alt-2'></i> DEXScreener
                    </button>
                    <div class="token-actions-group">
                        <button class="token-action-btn primary btn-analyze-modal" onclick="event.stopPropagation(); analyzeToken(${JSON.stringify(token).replace(/"/g, '&quot;')})">
                            <span class="btn-analyze-text">AI Analysis (1 CU)</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    modalBody.innerHTML = html;
    
    // Load security radar, trading indicators, and rugcheck after rendering
    // Trading indicators will only show after payment
    setTimeout(() => {
        createSecurityRadar(token, details);
        // Check if analysis has been paid for this token before showing trading indicators
        checkAndShowTradingIndicators(token, details);
        if (token.chain === 'solana') {
            loadRugCheck(token);
        }
    }, 100);
}
function closeTokenDetailsModal() {
    const modal = document.getElementById('token-details-modal');
    modal.classList.remove('active');
}
// ===== QUEST DASHBOARD =====

async function openQuestDashboard() {
    hideAITokenCallsHeader();
    aiTokenCallsSticky = false;
    if (!currentUser) {
        showToast('Please login to view your quests', 'warning');
        return;
    }
    
    const modal = document.getElementById('quest-dashboard-modal');
    if (!modal) {
        console.error('Quest Dashboard modal not found');
        return;
    }
    
    modal.classList.add('active');
    await loadQuestDashboard();
}

function closeQuestDashboard() {
    const modal = document.getElementById('quest-dashboard-modal');
    modal.classList.remove('active');
}
async function loadQuestDashboard() {
    const container = document.getElementById('quest-dashboard-body');
    
    if (!container) {
        console.error('Quest dashboard body not found');
        return;
    }
    
    container.innerHTML = `
        <div class="quest-loading">
            <div class="spinner"></div>
            <p>Loading quest progress...</p>
        </div>
    `;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/quests`, {
            credentials: 'include'
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            throw new Error(errorData.error || errorData.message || `Failed to load quests (${response.status})`);
        }
        
        const data = await response.json();
        renderQuestDashboard(data);
        
    } catch (error) {
        console.error('Error loading quests:', error);
        
        // Check if it's an authentication error
        let errorMessage = error.message;
        if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('Unauthorized')) {
            errorMessage = 'Please login to view your quests.';
        }
        
        container.innerHTML = `
            <div class="quest-error">
                <p>❌ Failed to load quests</p>
                <p style="font-size: 14px; color: var(--text-secondary);">${errorMessage}</p>
                ${!currentUser ? `
                    <button class="btn-primary" onclick="loginWithGoogle(); closeQuestDashboard();" style="margin-top: 16px;">
                        Login with Google
                    </button>
                ` : `
                    <button class="btn-primary" onclick="loadQuestDashboard()" style="margin-top: 16px;">
                        Retry
                    </button>
                `}
            </div>
        `;
    }
}

function renderQuestDashboard(data) {
    const container = document.getElementById('quest-dashboard-body');
    const quests = data.quests || {};
    const points = data.points || 0;
    const completedCount = data.completedCount || 0;
    const totalCount = 1; // Only follow quest
    const allCompleted = data.allCompleted || false;
    const progress = (completedCount / totalCount) * 100;
    const rewards = data.rewards || {};
    const totalPossiblePoints = rewards.totalPoints || 300;
    
    const twitterUsername = 'YunaraX402'; // Your updated Twitter username
    
    container.innerHTML = `
        <div class="quest-dashboard-content">
            <!-- Points Banner -->
            <div class="quest-credits-banner">
                <div class="quest-credits-icon">
                    <i class='bx bx-coins'></i>
                </div>
                <div class="quest-credits-info">
                    <div class="quest-credits-title">Your Airdrop Points</div>
                    <div class="quest-credits-count">${points} points</div>
                    <div class="quest-credits-description">Earn points by completing quests. Points will be used for airdrop eligibility later.</div>
                </div>
            </div>
            
            <!-- Progress Overview -->
            <div class="quest-progress-section">
                <div class="quest-progress-header">
                    <h3>Quest Progress</h3>
                    <div class="quest-progress-stats">
                        <span class="quest-completed">${completedCount}/${totalCount} Completed</span>
                    </div>
                </div>
                <div class="quest-progress-bar-container">
                    <div class="quest-progress-bar" style="width: ${progress}%"></div>
                </div>
            </div>
            
            ${allCompleted && points >= 100 ? `
            <div class="quest-reward-banner">
                <i class='bx bx-party'></i>
                <div>
                    <strong>🎉 Congratulations!</strong>
                    <p>You've completed all quests and earned ${points} points! You're eligible for the airdrop.</p>
                </div>
            </div>
            ` : points > 0 ? `
            <div class="quest-reward-banner">
                <i class='bx bx-coins'></i>
                <div>
                    <strong>💰 Points Earned!</strong>
                    <p>You've earned ${points} points so far. Complete the quest to earn 100 points!</p>
                </div>
            </div>
            ` : ''}
            
            <!-- Quest List -->
            <div class="quest-list">
                <!-- Follow Quest -->
                <div class="quest-item ${quests.twitterFollow?.completed ? 'quest-completed' : ''}">
                    <div class="quest-icon">
                        ${quests.twitterFollow?.completed 
                            ? '<i class=\'bx bx-check-circle\' style="color: #00FF88; font-size: 32px;"></i>' 
                            : '<i class=\'bx bxl-twitter\' style="font-size: 32px; color: var(--text-secondary);"></i>'}
                    </div>
                    <div class="quest-content">
                        <div class="quest-title">
                            Follow @${twitterUsername} on X
                            <span class="quest-points-badge">+100 points</span>
                        </div>
                        <div class="quest-description">Follow our X account to stay updated with the latest crypto insights</div>
                        ${quests.twitterFollow?.completed 
                            ? `<div class="quest-completed-badge">Completed on ${new Date(quests.twitterFollow.completedAt).toLocaleDateString()}</div>`
                            : `<div class="quest-verify-form">
                                <div class="quest-form-group">
                                    <label for="follow-twitter-handle">Your Twitter/X Handle:</label>
                                    <input type="text" id="follow-twitter-handle" class="quest-input" placeholder="@username" maxlength="50">
                                </div>
                                <div class="quest-actions">
                                    <a href="https://x.com/${twitterUsername}" target="_blank" class="quest-action-btn primary">
                                        <i class='bx bxl-twitter'></i> Visit @${twitterUsername}
                                    </a>
                                    <button class="quest-action-btn secondary" onclick="verifyFollowQuestFromForm()">
                                        <i class='bx bx-check'></i> Verify Follow
                                    </button>
                                </div>
                            </div>`}
                    </div>
                </div>
            </div>
            
            <!-- Reward Info -->
            <div class="quest-reward-info">
                <div class="quest-reward-icon">
                    <i class='bx bx-trophy'></i>
                </div>
                <div class="quest-reward-text">
                    <strong>Complete the quest to earn 100 airdrop points!</strong>
                    <p>Points will be used for airdrop eligibility. More points = better airdrop allocation!</p>
                </div>
            </div>
        </div>
    `;
}

async function verifyFollowQuestFromForm() {
    try {
        const twitterHandleInput = document.getElementById('follow-twitter-handle');
        const twitterHandle = twitterHandleInput?.value?.trim() || '';
        
        if (!twitterHandle) {
            showToast('Please enter your Twitter handle', 'warning');
            if (twitterHandleInput) twitterHandleInput.focus();
            return;
        }
        
        showToast('Verifying follow quest...', 'info');
        
        const response = await fetch(`${API_BASE_URL}/api/quests/verify-follow`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ twitterHandle: twitterHandle.replace('@', '') })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
            showToast('Follow quest verified and completed! 🎉', 'success');
            await loadQuestDashboard(); // Reload to show updated progress
            updateFreeCreditsBadge();
        } else {
            showToast(data.message || data.error || 'Failed to verify follow quest', 'error');
        }
    } catch (error) {
        console.error('Error verifying follow quest:', error);
        showToast('Failed to verify follow quest', 'error');
    }
}

// Legacy function for backwards compatibility
async function verifyFollowQuest() {
    verifyFollowQuestFromForm();
}

async function verifyLikeQuestFromForm() {
    try {
        const twitterHandleInput = document.getElementById('like-twitter-handle');
        const tweetIdInput = document.getElementById('like-tweet-id');
        
        const twitterHandle = twitterHandleInput?.value?.trim() || '';
        const tweetId = tweetIdInput?.value?.trim() || '';
        
        if (!twitterHandle) {
            showToast('Please enter your Twitter handle', 'warning');
            if (twitterHandleInput) twitterHandleInput.focus();
            return;
        }
        
        if (!tweetId) {
            showToast('Please enter the Tweet ID', 'warning');
            if (tweetIdInput) tweetIdInput.focus();
            return;
        }
        
        showToast('Verifying like quest...', 'info');
        
        const response = await fetch(`${API_BASE_URL}/api/quests/verify-like`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ 
                tweetId, 
                twitterHandle: twitterHandle.replace('@', '') 
            })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
            showToast('Like quest verified and completed! 🎉', 'success');
            await loadQuestDashboard(); // Reload to show updated progress
            updateFreeCreditsBadge();
        } else {
            showToast(data.message || data.error || 'Failed to verify like quest', 'error');
        }
    } catch (error) {
        console.error('Error verifying like quest:', error);
        showToast('Failed to verify like quest', 'error');
    }
}

// Legacy function for backwards compatibility
async function verifyLikeQuest() {
    verifyLikeQuestFromForm();
}
async function verifyCommentQuestFromForm() {
    try {
        const twitterHandleInput = document.getElementById('comment-twitter-handle');
        const tweetIdInput = document.getElementById('comment-tweet-id');
        
        const twitterHandle = twitterHandleInput?.value?.trim() || '';
        const tweetId = tweetIdInput?.value?.trim() || '';
        
        if (!twitterHandle) {
            showToast('Please enter your Twitter handle', 'warning');
            if (twitterHandleInput) twitterHandleInput.focus();
            return;
        }
        
        if (!tweetId) {
            showToast('Please enter the Tweet ID', 'warning');
            if (tweetIdInput) tweetIdInput.focus();
            return;
        }
        
        showToast('Verifying comment quest...', 'info');
        
        const response = await fetch(`${API_BASE_URL}/api/quests/verify-comment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ 
                tweetId, 
                twitterHandle: twitterHandle.replace('@', '') 
            })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
            showToast('Comment quest verified and completed! 🎉', 'success');
            await loadQuestDashboard(); // Reload to show updated progress
            updateFreeCreditsBadge();
        } else {
            showToast(data.message || data.error || 'Failed to verify comment quest', 'error');
        }
    } catch (error) {
        console.error('Error verifying comment quest:', error);
        showToast('Failed to verify comment quest', 'error');
    }
}

// Legacy function for backwards compatibility
async function verifyCommentQuest() {
    verifyCommentQuestFromForm();
}

async function updateFreeCreditsBadge() {
    // Legacy function name - now updates points badge
    if (!currentUser) return;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/quests`, {
            credentials: 'include'
        });
        
        if (response.ok) {
            const data = await response.json();
            const points = data.points || 0;
            
            const badge = document.getElementById('free-credits-badge');
            if (badge) {
                if (points > 0) {
                    badge.textContent = `${points} pts`;
                    badge.style.display = 'inline-block';
                    badge.title = `${points} airdrop points`;
                } else {
                    badge.style.display = 'none';
                }
            }
        }
    } catch (error) {
        console.error('Error updating points badge:', error);
    }
}

// ===== AI ANALYSIS DASHBOARD =====

async function openAIAnalysisDashboard() {
    hideAITokenCallsHeader();
    aiTokenCallsSticky = false;
    if (!currentUser) {
        showToast('Please login to view your AI analyses', 'warning');
        return;
    }
    
    const modal = document.getElementById('ai-analysis-dashboard-modal');
    if (!modal) {
        console.error('AI Analysis Dashboard modal not found');
        return;
    }
    
    modal.classList.add('active');
    await loadAIAnalysisDashboard();
}

function closeAIAnalysisDashboard() {
    const modal = document.getElementById('ai-analysis-dashboard-modal');
    modal.classList.remove('active');
}

async function loadAIAnalysisDashboard() {
    const container = document.getElementById('ai-analysis-dashboard-body');
    
    if (!container) {
        console.error('AI Analysis dashboard body not found');
        return;
    }
    
    container.innerHTML = `
        <div class="quest-loading">
            <div class="spinner"></div>
            <p>Loading your AI analyses...</p>
        </div>
    `;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/ai-analyses`, {
            credentials: 'include'
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            throw new Error(errorData.error || errorData.message || `Failed to load analyses (${response.status})`);
        }
        
        const data = await response.json();
        renderAIAnalysisDashboard(data);
        
    } catch (error) {
        console.error('Error loading AI analyses:', error);
        
        let errorMessage = error.message;
        if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('Unauthorized')) {
            errorMessage = 'Please login to view your AI analyses.';
        }
        
        container.innerHTML = `
            <div class="quest-error">
                <p>❌ Failed to load AI analyses</p>
                <p style="font-size: 14px; color: var(--text-secondary);">${errorMessage}</p>
                ${!currentUser ? `
                    <button class="btn-primary" onclick="loginWithGoogle(); closeAIAnalysisDashboard();" style="margin-top: 16px;">
                        Login with Google
                    </button>
                ` : `
                    <button class="btn-primary" onclick="loadAIAnalysisDashboard()" style="margin-top: 16px;">
                        Retry
                    </button>
                `}
            </div>
        `;
    }
}

function renderAIAnalysisDashboard(data) {
    const container = document.getElementById('ai-analysis-dashboard-body');
    const analyses = data.analyses || [];
    const totalCount = data.totalCount || 0;
    const paidCount = data.paidCount || 0;
    const previewCount = data.previewCount || 0;
    
    if (analyses.length === 0) {
        container.innerHTML = `
            <div class="quest-error" style="text-align: center; padding: 60px 20px;">
                <div style="font-size: 64px; margin-bottom: 20px; opacity: 0.5;">🤖</div>
                <h3 style="margin-bottom: 12px;">No AI Analyses Yet</h3>
                <p style="color: var(--text-secondary); margin-bottom: 24px;">
                    You haven't generated any AI analyses yet. Click "AI Analysis" on any token to get started!
                </p>
                <button class="btn-primary" onclick="closeAIAnalysisDashboard(); openMemeScope()">
                    Browse Tokens
                </button>
            </div>
        `;
        return;
    }
    
    container.innerHTML = `
        <div class="ai-analysis-dashboard-content">
            <!-- Stats Overview -->
            <div class="analysis-stats-overview">
                <div class="stat-card">
                    <div class="stat-icon">📊</div>
                    <div class="stat-info">
                        <div class="stat-value">${totalCount}</div>
                        <div class="stat-label">Total Analyses</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">💎</div>
                    <div class="stat-info">
                        <div class="stat-value">${paidCount}</div>
                        <div class="stat-label">Paid Analyses</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">👁️</div>
                    <div class="stat-info">
                        <div class="stat-value">${previewCount}</div>
                        <div class="stat-label">Previews</div>
                    </div>
                </div>
            </div>
            
            <!-- Analyses List -->
            <div class="analyses-list">
                ${analyses.map((savedAnalysis, index) => {
                    const token = savedAnalysis.tokenData || {};
                    const analysis = savedAnalysis.analysis || {};
                    const createdAt = new Date(savedAnalysis.createdAt);
                    const chainNames = {
                        solana: 'Solana',
                        bnb: 'BNB Chain',
                        base: 'Base',
                        ethereum: 'Ethereum'
                    };
                    
                    const riskScore = analysis.riskScore || 50;
                    const recommendation = analysis.recommendation || 'Hold';
                    const recommendationClass = recommendation.toLowerCase() === 'buy' ? 'recommendation-buy' : 
                                                 recommendation.toLowerCase() === 'avoid' ? 'recommendation-avoid' : 
                                                 recommendation.toLowerCase() === 'speculate' ? 'recommendation-speculate' : 'recommendation-hold';
                    
                    return `
                        <div class="analysis-card" onclick="viewSavedAnalysis(${index})">
                            <div class="analysis-card-header">
                                <div class="analysis-card-token">
                                    ${token.logo ? `
                                        <img src="${token.logo}" alt="${token.name}" class="analysis-card-logo" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                                        <div class="analysis-card-logo-fallback" style="display: none;">${(token.symbol || token.name || '?').charAt(0).toUpperCase()}</div>
                                    ` : `
                                        <div class="analysis-card-logo-fallback">${(token.symbol || token.name || '?').charAt(0).toUpperCase()}</div>
                                    `}
                                    <div class="analysis-card-token-info">
                                        <div class="analysis-card-name">${token.name || 'Unknown Token'}</div>
                                        <div class="analysis-card-symbol">${token.symbol || 'UNKNOWN'}</div>
                                    </div>
                                </div>
                                <div class="analysis-card-badges">
                                    ${savedAnalysis.isPreview ? `
                                        <span class="analysis-badge preview-badge">Preview</span>
                                    ` : `
                                        <span class="analysis-badge paid-badge">Paid</span>
                                    `}
                                    <span class="analysis-badge chain-badge">${chainNames[savedAnalysis.chain] || savedAnalysis.chain}</span>
                                </div>
                            </div>
                            
                            <div class="analysis-card-body">
                                <div class="analysis-card-summary">
                                    ${analysis.summary || analysis.detailedAnalysis || 'No summary available'}
                                </div>
                                
                                <div class="analysis-card-metrics">
                                    <div class="metric-item">
                                        <span class="metric-label">Risk Score</span>
                                        <span class="metric-value risk-${riskScore < 40 ? 'low' : riskScore < 70 ? 'medium' : 'high'}">${riskScore}/100</span>
                                    </div>
                                    <div class="metric-item">
                                        <span class="metric-label">Recommendation</span>
                                        <span class="metric-value ${recommendationClass}">${recommendation}</span>
                                    </div>
                                    <div class="metric-item">
                                        <span class="metric-label">Confidence</span>
                                        <span class="metric-value">${analysis.confidence || 65}%</span>
                                    </div>
                                </div>
                            </div>
                            
                            <div class="analysis-card-footer">
                                <div class="analysis-card-date">
                                    <i class='bx bx-time-five'></i>
                                    ${createdAt.toLocaleDateString()} ${createdAt.toLocaleTimeString()}
                                </div>
                                <div class="analysis-card-llm">
                                    Powered by ${savedAnalysis.llmUsed === 'gemini' ? 'Gemini AI' : savedAnalysis.llmUsed === 'chatgpt' ? 'ChatGPT' : 'AI'}
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
    
    // Store analyses globally for view function
    window.savedAnalysesData = data.analyses;
}

function viewSavedAnalysis(index) {
    const analyses = window.savedAnalysesData || [];
    if (!analyses[index]) {
        showToast('Analysis not found', 'error');
        return;
    }
    
    const savedAnalysis = analyses[index];
    const token = savedAnalysis.tokenData || {};
    
    // Use the same showAnalysisModal function but with saved data
    showAnalysisModal(
        {
            name: token.name,
            symbol: token.symbol,
            address: savedAnalysis.address,
            chain: savedAnalysis.chain,
            logo: token.logo
        },
        savedAnalysis.analysis,
        savedAnalysis.llmUsed,
        savedAnalysis.isPreview
    );
    
    // Close the dashboard modal
    closeAIAnalysisDashboard();
}

// ===== KOL DASHBOARD =====

function openKOLDashboard() {
    const modal = document.getElementById('kol-dashboard-modal');
    if (!modal) {
        console.error('KOL Dashboard modal not found');
        return;
    }
    
    modal.classList.add('active');
    loadKOLActivity();
}

function closeKOLDashboard() {
    const modal = document.getElementById('kol-dashboard-modal');
    modal.classList.remove('active');
}

// Store KOL data globally
let currentKOLData = null;
let selectedTokenIndex = 0;

async function loadKOLActivity() {
    const container = document.getElementById('kol-dashboard-content');
    
    if (!container) {
        console.error('KOL dashboard content container not found');
        return;
    }
    
    container.innerHTML = `
        <div class="kol-loading">
            <div class="loading-spinner"></div>
            <p>Loading live KOL activity...</p>
        </div>
    `;
    
    try {
        console.log('⭐ Fetching live KOL trading activity...');
        
        const response = await fetch(`${API_BASE_URL}/api/kol-activity`);
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        console.log(`✓ Found ${data.topTokens.length} tokens being traded by KOLs`);
        
        // Store data globally
        currentKOLData = data;
        selectedTokenIndex = 0;
        
        // Render new layout: Network view + Data table + Token details sidebar
        renderKOLDashboard(data);
        
    } catch (error) {
        console.error('Error loading KOL activity:', error);
        container.innerHTML = `
            <div class="kol-error">
                <p>❌ Failed to load KOL activity</p>
                <p style="font-size: 14px; color: var(--text-secondary);">${error.message}</p>
            </div>
        `;
    }
}

function renderKOLDashboard(data) {
    const container = document.getElementById('kol-dashboard-content');
    
    if (data.topTokens.length === 0) {
        container.innerHTML = `
            <div class="kol-empty-state">
                <p>No recent KOL activity detected</p>
            </div>
        `;
        return;
    }
    
    // Calculate percentages for each KOL based on their swap count
    const selectedToken = data.topTokens[selectedTokenIndex];
    const totalKolSwaps = selectedToken.kolsTrading.reduce((sum, kol) => {
        // Count swaps per KOL (we don't have exact counts, so we estimate)
        return sum + 1; // Each KOL has at least 1 swap
    }, 0);
    
    let html = `
        <div class="kol-dashboard-layout">
            <!-- Main Content Area (Center) -->
            <div class="kol-main-content">
                <!-- Network Visualization -->
                <div id="kol-network-view" class="kol-network-view-new">
                    <canvas id="kol-network-canvas" class="kol-network-canvas-new"></canvas>
                    <div class="kol-network-controls">
                        <button class="kol-nav-btn" onclick="previousToken()">← Prev</button>
                        <span class="kol-token-counter">Token ${selectedTokenIndex + 1} of ${data.topTokens.length}</span>
                        <button class="kol-nav-btn" onclick="nextToken()">Next →</button>
                    </div>
                </div>
                
                <!-- Data Table with Tabs -->
                <div class="kol-data-table-section">
                    <div class="kol-table-tabs">
                        <button class="kol-table-tab active" onclick="switchKOLTableTab('transactions')">KOL Transactions</button>
                        <button class="kol-table-tab" onclick="switchKOLTableTab('leaderboard')">KOL Leaderboard</button>
                        <button class="kol-table-tab" onclick="switchKOLTableTab('holders')">Top Holders</button>
                    </div>
                    
                    <!-- KOL Transactions Table -->
                    <div id="kol-table-transactions" class="kol-table-content active">
                        ${renderKOLTransactionsTable(selectedToken)}
                    </div>
                    
                    <!-- KOL Leaderboard Table -->
                    <div id="kol-table-leaderboard" class="kol-table-content">
                        ${renderKOLLeaderboardTable(data.kols)}
                    </div>
                    
                    <!-- Top Holders Table -->
                    <div id="kol-table-holders" class="kol-table-content">
                        ${renderTopHoldersTable(selectedToken)}
                    </div>
                </div>
            </div>
            
            <!-- Token Details Sidebar (Right) -->
            <div class="kol-token-sidebar">
                ${renderTokenDetailsSidebar(selectedToken)}
            </div>
        </div>
    `;
    
    container.innerHTML = html;
    
    // Initialize network visualization
    initializeKOLNetworkNew(data.topTokens, selectedTokenIndex);
}

// Navigation functions
function nextToken() {
    if (!currentKOLData) return;
    selectedTokenIndex = (selectedTokenIndex + 1) % currentKOLData.topTokens.length;
    renderKOLDashboard(currentKOLData);
}

function previousToken() {
    if (!currentKOLData) return;
    selectedTokenIndex = selectedTokenIndex === 0 ? currentKOLData.topTokens.length - 1 : selectedTokenIndex - 1;
    renderKOLDashboard(currentKOLData);
}

// Switch table tabs
function switchKOLTableTab(tabName) {
    const tabs = document.querySelectorAll('.kol-table-tab');
    const contents = document.querySelectorAll('.kol-table-content');
    
    tabs.forEach(tab => tab.classList.remove('active'));
    contents.forEach(content => content.classList.remove('active'));
    
    document.querySelector(`[onclick="switchKOLTableTab('${tabName}')"]`).classList.add('active');
    document.getElementById(`kol-table-${tabName}`).classList.add('active');
}
// Render KOL Transactions Table
function renderKOLTransactionsTable(token) {
    if (!token.kolsTrading || token.kolsTrading.length === 0) {
        return '<div class="kol-table-empty">No KOL transactions found</div>';
    }
    
    // Calculate percentage for each KOL (equal distribution for now)
    const kolCount = token.kolsTrading.length;
    const percentagePerKol = (100 / kolCount).toFixed(2);
    
    return `
        <table class="kol-transactions-table">
            <thead>
                <tr>
                    <th>Address</th>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>Percentage</th>
                    <th>Solscan</th>
                </tr>
            </thead>
            <tbody>
                ${token.kolsTrading.map((kol, index) => `
                    <tr>
                        <td class="kol-address-cell">
                            ${kol.name || kol.address.slice(0, 6) + '...' + kol.address.slice(-4)}
                        </td>
                        <td class="kol-type-cell">
                            <span class="kol-type-badge ${kol.swapType === 'buy' ? 'buy' : 'sell'}">
                                ${kol.swapType === 'buy' ? 'Buy' : 'Sell'}
                            </span>
                        </td>
                        <td class="kol-amount-cell">${token.totalSwaps}</td>
                        <td class="kol-percentage-cell">${percentagePerKol}%</td>
                        <td class="kol-solscan-cell">
                            <a href="https://solscan.io/account/${kol.address}" target="_blank" class="kol-solscan-link">
                                <div class="kol-solscan-icon">Q</div>
                            </a>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}
// Render KOL Leaderboard Table
function renderKOLLeaderboardTable(kols) {
    const activeKols = kols.filter(k => k.swaps && k.swaps.length > 0);
    
    if (activeKols.length === 0) {
        return '<div class="kol-table-empty">No active KOLs found</div>';
    }
    
    return `
        <table class="kol-leaderboard-table">
            <thead>
                <tr>
                    <th>Rank</th>
                    <th>Name</th>
                    <th>Address</th>
                    <th>Swaps</th>
                    <th>Last Activity</th>
                </tr>
            </thead>
            <tbody>
                ${activeKols.map((kol, index) => `
                    <tr>
                        <td class="kol-rank-cell">#${kol.kol.rank || index + 1}</td>
                        <td class="kol-name-cell">${kol.kol.name}</td>
                        <td class="kol-address-cell">${kol.kol.address.slice(0, 6)}...${kol.kol.address.slice(-4)}</td>
                        <td class="kol-swaps-cell">${kol.swaps.length}</td>
                        <td class="kol-activity-cell">
                            ${kol.lastActivity ? new Date(kol.lastActivity).toLocaleDateString() : 'N/A'}
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

// Render Top Holders Table
function renderTopHoldersTable(token) {
    // For now, we'll show a placeholder since we need to fetch holder data
    return `
        <div class="kol-table-empty">
            <p>Top holders data will be loaded...</p>
            <button onclick="loadKOLHolders('${token.tokenAddress}')" class="kol-load-btn">Load Holders</button>
        </div>
    `;
}

// Render Token Details Sidebar
function renderTokenDetailsSidebar(token) {
    const rugCheckScore = token.rugCheck?.report?.score_normalised || token.rugCheck?.report?.score || null;
    const rugCheckStatus = rugCheckScore ? (rugCheckScore <= 20 ? 'safe' : rugCheckScore <= 40 ? 'low-risk' : rugCheckScore <= 70 ? 'medium-risk' : 'high-risk') : 'unknown';
    const rugCheckText = rugCheckScore ? (rugCheckScore <= 20 ? 'No problems found' : rugCheckScore <= 40 ? 'Low risk' : rugCheckScore <= 70 ? 'Medium risk' : 'High risk detected') : 'Analysis unavailable';
    const rugCheckColor = rugCheckScore <= 20 ? '#00FF88' : rugCheckScore <= 40 ? '#00D4FF' : rugCheckScore <= 70 ? '#FFB800' : '#FF4757';
    
    const logo = token.logo ? `<img src="${token.logo}" alt="${token.name}" />` : '<div class="token-placeholder">' + (token.symbol || 'T').charAt(0) + '</div>';
    const priceChange = token.priceChange24h || 0;
    const priceChangeClass = priceChange >= 0 ? 'positive' : 'negative';
    const priceChangeSign = priceChange >= 0 ? '+' : '';
    
    // Calculate KOL transaction summary (using buys/sells)
    const kolBuyTotal = token.buys || 0;
    const kolSellTotal = token.sells || 0;
    const kolProfit = kolBuyTotal - kolSellTotal; // Simplified calculation
    
    return `
        <div class="kol-sidebar-header">
            <div class="kol-sidebar-logo">${logo}</div>
            <div class="kol-sidebar-token-info">
                <h3 class="kol-sidebar-token-name">${token.name || token.symbol || 'Unknown'}</h3>
                <p class="kol-sidebar-token-symbol">${token.symbol || 'N/A'}/${token.isPumpFun ? 'PUMP' : 'SOL'}</p>
                <p class="kol-sidebar-token-address">
                    <span class="kol-address-text">${token.tokenAddress.slice(0, 6)}...${token.tokenAddress.slice(-4)}</span>
                    <button class="kol-address-copy-btn" onclick="event.stopPropagation(); copyToClipboard('${token.tokenAddress || ''}')" title="Copy full address">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                    </button>
                </p>
            </div>
        </div>
        
        <div class="kol-sidebar-rugcheck" style="background: ${rugCheckScore <= 20 ? 'rgba(0, 255, 136, 0.1)' : rugCheckScore <= 40 ? 'rgba(0, 212, 255, 0.1)' : rugCheckScore <= 70 ? 'rgba(255, 184, 0, 0.1)' : 'rgba(255, 71, 87, 0.1)'}; border: 1px solid ${rugCheckColor};">
            <div class="kol-rugcheck-icon">${rugCheckScore <= 20 ? '✅' : rugCheckScore <= 40 ? '⚠️' : '🚨'}</div>
            <div class="kol-rugcheck-text">
                <strong>RUG CHECK:</strong> ${rugCheckText}
            </div>
        </div>
        
        <div class="kol-sidebar-metrics">
            <div class="kol-metric-row">
                <span class="kol-metric-label">LP LOCKED</span>
                <span class="kol-metric-value">100%</span>
            </div>
            <div class="kol-metric-row">
                <span class="kol-metric-label">TOP HOLDERS</span>
                <span class="kol-metric-value highlight">33.52%</span>
            </div>
            <div class="kol-metric-row">
                <span class="kol-metric-label">BUNDLES</span>
                <span class="kol-metric-value">24</span>
            </div>
            <div class="kol-metric-row">
                <span class="kol-metric-label">% BUNDLED</span>
                <span class="kol-metric-value">62.30%</span>
            </div>
            <div class="kol-metric-row">
                <span class="kol-metric-label">ACTIVE %</span>
                <span class="kol-metric-value">0.00%</span>
            </div>
        </div>
        
        <div class="kol-sidebar-financial">
            <div class="kol-financial-row">
                <span class="kol-financial-label">MCAP</span>
                <span class="kol-financial-value">$${formatNumber(token.marketCap || 0)}</span>
            </div>
            <div class="kol-financial-row">
                <span class="kol-financial-label">LIQUIDITY</span>
                <span class="kol-financial-value">$${formatNumber(token.liquidity || 0)}</span>
            </div>
            <div class="kol-financial-row">
                <span class="kol-financial-label">VOLUME (24H)</span>
                <span class="kol-financial-value">$${formatNumber(token.volume24h || 0)}</span>
            </div>
            <div class="kol-financial-row">
                <span class="kol-financial-label">PRICE USD</span>
                <span class="kol-financial-value">$${token.price ? token.price.toFixed(6) : '0.00'}</span>
            </div>
            <div class="kol-financial-row">
                <span class="kol-financial-label">PRICE (24H)</span>
                <span class="kol-financial-value ${priceChangeClass}">${priceChangeSign}${priceChange.toFixed(2)}%</span>
            </div>
        </div>
        
        <div class="kol-sidebar-stats">
            <div class="kol-stat-row">
                <span class="kol-stat-label">HOLDERS</span>
                <span class="kol-stat-value">${formatWholeNumber(token.holders || 0)}</span>
            </div>
            <div class="kol-stat-row">
                <span class="kol-stat-label">KOLS</span>
                <span class="kol-stat-value">${token.kolsTrading?.length || 0}</span>
            </div>
        </div>
        
        <div class="kol-sidebar-transactions">
            <h4 class="kol-transactions-title">KOL TRANSACTIONS (SOL)</h4>
            <div class="kol-transactions-summary">
                <div class="kol-transaction-item">
                    <span class="kol-transaction-label">BUY:</span>
                    <span class="kol-transaction-value">${kolBuyTotal}</span>
                </div>
                <div class="kol-transaction-item">
                    <span class="kol-transaction-label">SELL:</span>
                    <span class="kol-transaction-value">${kolSellTotal}</span>
                </div>
                <div class="kol-transaction-item">
                    <span class="kol-transaction-label">PROFIT:</span>
                    <span class="kol-transaction-value ${kolProfit >= 0 ? 'positive' : 'negative'}">${kolProfit >= 0 ? '+' : ''}${kolProfit}</span>
                </div>
            </div>
        </div>
    `;
}
// Initialize new network visualization
function initializeKOLNetworkNew(tokens, tokenIndex) {
    const token = tokens[tokenIndex];
    if (!token) return;
    
    const canvas = document.getElementById('kol-network-canvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const container = canvas.parentElement;
    canvas.width = container.clientWidth - 40;
    canvas.height = 500;
    
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = Math.min(canvas.width, canvas.height) * 0.3;
    
    // Clear and draw background
    ctx.fillStyle = '#0a0f1c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw connections first
    token.kolsTrading.forEach((kol, index) => {
        const angle = (Math.PI * 2 * index) / token.kolsTrading.length - Math.PI / 2;
        const kolX = centerX + Math.cos(angle) * radius;
        const kolY = centerY + Math.sin(angle) * radius;
        
        const isBuy = kol.swapType === 'buy';
        ctx.strokeStyle = isBuy ? '#00ff88' : '#ff4757';
        ctx.lineWidth = 2;
        
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(kolX, kolY);
        ctx.stroke();
        
        // Draw percentage
        const midX = centerX + Math.cos(angle) * (radius / 2);
        const midY = centerY + Math.sin(angle) * (radius / 2);
        const percentage = ((1 / token.kolsTrading.length) * 100).toFixed(2);
        
        ctx.fillStyle = '#ffffff';
        ctx.font = '11px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(percentage + '%', midX, midY);
    });
    
    // Draw center token node
    const tokenImg = new Image();
    tokenImg.onload = () => {
        ctx.save();
        ctx.beginPath();
        ctx.arc(centerX, centerY, 70, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(tokenImg, centerX - 70, centerY - 70, 140, 140);
        ctx.restore();
        
        ctx.beginPath();
        ctx.arc(centerX, centerY, 70, 0, Math.PI * 2);
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 3;
        ctx.stroke();
        
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 16px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(token.name || token.symbol || 'Unknown', centerX, centerY + 100);
    };
    
    tokenImg.onerror = () => {
        ctx.beginPath();
        ctx.arc(centerX, centerY, 70, 0, Math.PI * 2);
        ctx.fillStyle = '#1e293b';
        ctx.fill();
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 3;
        ctx.stroke();
        
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 32px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((token.symbol || 'T').charAt(0).toUpperCase(), centerX, centerY);
        
        ctx.font = 'bold 16px Arial';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(token.name || token.symbol || 'Unknown', centerX, centerY + 100);
    };
    
    if (token.logo) {
        tokenImg.src = token.logo;
    } else {
        tokenImg.onerror();
    }
    
    // Draw KOL nodes
    token.kolsTrading.forEach((kol, index) => {
        const angle = (Math.PI * 2 * index) / token.kolsTrading.length - Math.PI / 2;
        const kolX = centerX + Math.cos(angle) * radius;
        const kolY = centerY + Math.sin(angle) * radius;
        
        const img = new Image();
        img.onload = () => {
            ctx.save();
            ctx.beginPath();
            ctx.arc(kolX, kolY, 35, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(img, kolX - 35, kolY - 35, 70, 70);
            ctx.restore();
            
            ctx.beginPath();
            ctx.arc(kolX, kolY, 35, 0, Math.PI * 2);
            ctx.strokeStyle = kol.swapType === 'buy' ? '#00ff88' : '#ff4757';
            ctx.lineWidth = 2;
            ctx.stroke();
        };
        
        img.onerror = () => {
            ctx.beginPath();
            ctx.arc(kolX, kolY, 35, 0, Math.PI * 2);
            ctx.fillStyle = '#2d3748';
            ctx.fill();
            ctx.strokeStyle = kol.swapType === 'buy' ? '#00ff88' : '#ff4757';
            ctx.lineWidth = 2;
            ctx.stroke();
            
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 20px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(kol.name.charAt(0), kolX, kolY);
        };
        
        if (kol.image) {
            img.src = kol.image;
        } else {
            img.onerror();
        }
    });
}

// Search for a token by address
async function searchTokenByAddress(address) {
    closeKOLDashboard();
    document.getElementById('search-input').value = address;
    await searchToken();
}

// Initialize KOL network visualization
let currentTokenIndex = 0;
let tokensData = [];

function initializeKOLNetwork(tokens) {
    tokensData = tokens;
    currentTokenIndex = 0;
    drawKOLNetwork(currentTokenIndex);
    
    // Add navigation controls
    const canvas = document.getElementById('kol-network-canvas');
    canvas.onclick = () => {
        currentTokenIndex = (currentTokenIndex + 1) % tokensData.length;
        drawKOLNetwork(currentTokenIndex);
    };
}

// Draw KOL network visualization
function drawKOLNetwork(tokenIndex) {
    const canvas = document.getElementById('kol-network-canvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    
    // Set canvas size
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = 600;
    
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = 200;
    
    // Clear canvas
    ctx.fillStyle = '#0a0f1c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const token = tokensData[tokenIndex];
    if (!token) return;
    
    // Draw connecting lines first (behind nodes)
    token.kolsTrading.forEach((kol, index) => {
        const angle = (Math.PI * 2 * index) / token.kolsTrading.length - Math.PI / 2;
        const kolX = centerX + Math.cos(angle) * radius;
        const kolY = centerY + Math.sin(angle) * radius;
        
        // Determine line color based on swap type
        const isBuy = kol.swapType === 'buy';
        ctx.strokeStyle = isBuy ? '#00ff88' : '#ff4757';
        ctx.lineWidth = 3;
        
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(kolX, kolY);
        ctx.stroke();
        
        // Draw percentage
        const midX = centerX + Math.cos(angle) * (radius / 2);
        const midY = centerY + Math.sin(angle) * (radius / 2);
        
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        const percentage = ((1 / token.kolsTrading.length) * 100).toFixed(2) + '%';
        ctx.fillText(percentage, midX, midY);
    });
    
    // Draw center token node
    const tokenImg = new Image();
    tokenImg.onload = () => {
        ctx.save();
        ctx.beginPath();
        ctx.arc(centerX, centerY, 80, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(tokenImg, centerX - 80, centerY - 80, 160, 160);
        ctx.restore();
        
        // Draw border
        ctx.beginPath();
        ctx.arc(centerX, centerY, 80, 0, Math.PI * 2);
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 4;
        ctx.stroke();
        
        // Draw token name below
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(token.name || token.symbol || 'Unknown', centerX, centerY + 110);
    };
    
    tokenImg.onerror = () => {
        // Fallback: draw circle with token symbol
        ctx.beginPath();
        ctx.arc(centerX, centerY, 80, 0, Math.PI * 2);
        ctx.fillStyle = '#1e293b';
        ctx.fill();
        ctx.strokeStyle = '#00d4ff';
        ctx.lineWidth = 4;
        ctx.stroke();
        
        // Draw token symbol
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 32px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((token.symbol || 'T').charAt(0).toUpperCase(), centerX, centerY);
        
        // Draw token name below
        ctx.font = 'bold 18px Arial';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(token.name || token.symbol || 'Unknown', centerX, centerY + 110);
    };
    
    if (token.logo) {
        tokenImg.src = token.logo;
    } else {
        tokenImg.onerror();
    }
    
    // Draw KOL nodes
    token.kolsTrading.forEach((kol, index) => {
        const angle = (Math.PI * 2 * index) / token.kolsTrading.length - Math.PI / 2;
        const kolX = centerX + Math.cos(angle) * radius;
        const kolY = centerY + Math.sin(angle) * radius;
        
        // Load and draw KOL image
        const img = new Image();
        img.onload = () => {
            ctx.save();
            ctx.beginPath();
            ctx.arc(kolX, kolY, 40, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(img, kolX - 40, kolY - 40, 80, 80);
            ctx.restore();
            
            // Draw border
            ctx.beginPath();
            ctx.arc(kolX, kolY, 40, 0, Math.PI * 2);
            ctx.strokeStyle = kol.swapType === 'buy' ? '#00ff88' : '#ff4757';
            ctx.lineWidth = 3;
            ctx.stroke();
            
            // Draw KOL name
            ctx.fillStyle = '#ffffff';
            ctx.font = '12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(kol.name, kolX, kolY + 55);
        };
        
        img.onerror = () => {
            // Fallback: draw circle with initial
            ctx.beginPath();
            ctx.arc(kolX, kolY, 40, 0, Math.PI * 2);
            ctx.fillStyle = '#2d3748';
            ctx.fill();
            ctx.strokeStyle = kol.swapType === 'buy' ? '#00ff88' : '#ff4757';
            ctx.lineWidth = 3;
            ctx.stroke();
            
            // Draw initial
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 24px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(kol.name.charAt(0), kolX, kolY);
            
            // Draw name
            ctx.font = '12px Arial';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(kol.name, kolX, kolY + 55);
        };
        
        if (kol.image) {
            img.src = kol.image;
        } else {
            img.onerror();
        }
    });
    
    // Draw navigation hint
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '14px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`Click to view next token (${tokenIndex + 1}/${tokensData.length})`, centerX, canvas.height - 20);
}

// Load and display top token holders
async function loadTopHolders(token) {
    const container = document.getElementById('top-holders-container');
    
    if (!container) {
        console.log('Top holders container not found');
        return;
    }
    
    try {
        console.log(`📊 Fetching top holders for ${token.address} on ${token.chain}...`);
        
        let holders = [];
        
        // For Solana, use the Solana gateway endpoint
        if (token.chain === 'solana') {
            const response = await fetch(`${API_BASE_URL}/api/solana-holders/${token.address}`);
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }
            
            holders = data.holders || [];
        } 
        // For EVM chains (ETH, BNB, Base), use the ERC20 owners endpoint
        else if (['ethereum', 'bnb', 'base'].includes(token.chain)) {
            const response = await fetch(`${API_BASE_URL}/api/evm-holders/${token.chain}/${token.address}`);
            const data = await response.json();
            
            if (data.error) {
                throw new Error(data.error);
            }
            
            holders = data.holders || [];
        } else {
            throw new Error('Unsupported chain for holders');
        }
        
        if (holders.length === 0) {
            container.innerHTML = `
                <div class="token-no-data">
                    <p>No holder data available</p>
                </div>
            `;
            return;
        }
        
        // Render holders list
        renderTopHolders(holders, container, token);
        
    } catch (error) {
        console.error('Error loading top holders:', error);
        container.innerHTML = `
            <div class="token-no-data">
                <p>⚠️ Could not load holder data</p>
                <p style="font-size: 14px; color: var(--text-muted);">${error.message}</p>
            </div>
        `;
    }
}

// Render top holders list
function renderTopHolders(holders, container, token) {
    const html = `
        <div class="top-holders-list">
            <div class="top-holders-header">
                <div class="holder-rank">#</div>
                <div class="holder-address">Address</div>
                <div class="holder-balance">Balance</div>
                <div class="holder-percentage">%</div>
            </div>
            ${holders.slice(0, 20).map((holder, index) => {
                const percentage = holder.percentage || holder.percentage_relative_to_total_supply || 0;
                const balance = holder.balance ? formatNumber(holder.balance) : formatNumber(holder.value);
                const address = holder.owner_address || holder.owner || holder.address || 'Unknown';
                const label = holder.owner_label || '';
                
                return `
                    <div class="top-holder-item">
                        <div class="holder-rank">${index + 1}</div>
                        <div class="holder-address">
                            <div class="holder-address-text" title="${address}">
                                ${address.slice(0, 6)}...${address.slice(-4)}
                                ${label ? `<span class="holder-label">${label}</span>` : ''}
                            </div>
                        </div>
                        <div class="holder-balance">${balance}</div>
                        <div class="holder-percentage">
                            <div class="holder-percentage-bar-container">
                                <div class="holder-percentage-bar" style="width: ${Math.min(percentage, 100)}%"></div>
                                <span class="holder-percentage-text">${parseFloat(percentage).toFixed(2)}%</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
    
    container.innerHTML = html;
}

// Create security radar chart
function createSecurityRadar(token, details) {
    const canvas = document.getElementById('security-radar-chart');
    const legendContainer = document.getElementById('security-score-legend');
    
    if (!canvas || !legendContainer) {
        console.log('Security radar elements not found');
        return;
    }
    
    // Calculate security scores based on available data
    const scores = calculateSecurityScores(token, details);
    
    // Destroy existing chart if it exists
    if (window.securityRadarChart) {
        window.securityRadarChart.destroy();
    }
    
    // Create radar chart
    const ctx = canvas.getContext('2d');
    window.securityRadarChart = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: scores.labels,
            datasets: [{
                label: 'Security Score',
                data: scores.values,
                backgroundColor: 'rgba(139, 92, 246, 0.3)',
                borderColor: 'rgba(139, 92, 246, 1)',
                borderWidth: 2,
                pointBackgroundColor: 'rgba(139, 92, 246, 1)',
                pointBorderColor: '#fff',
                pointHoverBackgroundColor: '#fff',
                pointHoverBorderColor: 'rgba(139, 92, 246, 1)',
                pointRadius: 4,
                pointHoverRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 7, 32, 0.95)',
                    titleColor: '#fff',
                    bodyColor: '#C4B5FD',
                    borderColor: 'rgba(139, 92, 246, 0.5)',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            return `${context.label}: ${context.parsed.r}%`;
                        }
                    }
                }
            },
            scales: {
                r: {
                    beginAtZero: true,
                    max: 100,
                    min: 0,
                    ticks: {
                        stepSize: 20,
                        color: 'rgba(196, 181, 253, 0.6)',
                        backdropColor: 'transparent',
                        font: {
                            size: 11
                        }
                    },
                    grid: {
                        color: 'rgba(139, 92, 246, 0.2)',
                        circular: true
                    },
                    pointLabels: {
                        color: '#C4B5FD',
                        font: {
                            size: 13,
                            weight: '600'
                        }
                    }
                }
            }
        }
    });
    
    // Create legend with details
    legendContainer.innerHTML = `
        <div class="security-legend-items">
            ${scores.labels.map((label, index) => `
                <div class="security-legend-item">
                    <div class="security-legend-indicator" style="background: ${scores.values[index] >= 70 ? '#00FF88' : scores.values[index] >= 40 ? '#FFB800' : '#FF4757'}"></div>
                    <div class="security-legend-label">${label}</div>
                    <div class="security-legend-value">${scores.values[index]}%</div>
                </div>
            `).join('')}
        </div>
        <div class="security-overall-score">
            <span class="security-overall-label">Overall Score:</span>
            <span class="security-overall-value" style="color: ${scores.overall >= 70 ? '#00FF88' : scores.overall >= 40 ? '#FFB800' : '#FF4757'}">${scores.overall}%</span>
        </div>
    `;
}
// Calculate security scores based on token data
function calculateSecurityScores(token, details) {
    const scores = {
        labels: [],
        values: [],
        overall: 0
    };
    
    // 1. Ownership Distribution Score (based on top holder percentage)
    scores.labels.push('Low Concentration');
    const topHolderPercentage = details.metadata?.topHolderPercentage || 0;
    let concentrationScore = 100;
    if (topHolderPercentage > 50) concentrationScore = 20;
    else if (topHolderPercentage > 30) concentrationScore = 50;
    else if (topHolderPercentage > 20) concentrationScore = 70;
    else if (topHolderPercentage > 10) concentrationScore = 85;
    scores.values.push(concentrationScore);
    
    // 2. Liquidity Score (based on liquidity amount)
    scores.labels.push('Liquidity');
    const liquidity = token.liquidity || 0;
    let liquidityScore = 0;
    if (liquidity > 1000000) liquidityScore = 100;
    else if (liquidity > 500000) liquidityScore = 85;
    else if (liquidity > 100000) liquidityScore = 70;
    else if (liquidity > 50000) liquidityScore = 50;
    else if (liquidity > 10000) liquidityScore = 30;
    else liquidityScore = 10;
    scores.values.push(liquidityScore);
    
    // 3. Holder Count Score
    scores.labels.push('Holder Count');
    const holders = token.holders || 0;
    let holderScore = 0;
    if (holders > 10000) holderScore = 100;
    else if (holders > 5000) holderScore = 85;
    else if (holders > 1000) holderScore = 70;
    else if (holders > 500) holderScore = 50;
    else if (holders > 100) holderScore = 30;
    else holderScore = 10;
    scores.values.push(holderScore);
    
    // 4. Market Cap Score
    scores.labels.push('Market Cap');
    const marketCap = token.marketCap || 0;
    let marketCapScore = 0;
    if (marketCap > 10000000) marketCapScore = 100;
    else if (marketCap > 5000000) marketCapScore = 85;
    else if (marketCap > 1000000) marketCapScore = 70;
    else if (marketCap > 500000) marketCapScore = 50;
    else if (marketCap > 100000) marketCapScore = 30;
    else marketCapScore = 10;
    scores.values.push(marketCapScore);
    
    // 5. Price Stability Score (based on 24h change)
    scores.labels.push('Price Stability');
    const priceChange = Math.abs(token.priceChange24h || 0);
    let stabilityScore = 100;
    if (priceChange > 100) stabilityScore = 10;
    else if (priceChange > 50) stabilityScore = 30;
    else if (priceChange > 30) stabilityScore = 50;
    else if (priceChange > 15) stabilityScore = 70;
    else if (priceChange > 5) stabilityScore = 85;
    scores.values.push(stabilityScore);
    
    // 6. DEX Promotion Score (if paid for DEXScreener)
    scores.labels.push('Verified/Promoted');
    const isVerified = token.verified || false;
    scores.values.push(isVerified ? 80 : 40);
    
    // Calculate overall score
    scores.overall = Math.round(scores.values.reduce((a, b) => a + b, 0) / scores.values.length);
    
    return scores;
}

// Create trading indicators for the analysis modal
async function createTradingIndicatorsForAnalysisModal(token, details, container) {
    if (!container) {
        console.log('Trading indicators container not found for analysis modal');
        return;
    }
    
    // Use the same logic as createTradingIndicators but with a specific container
    await createTradingIndicators(token, details, container);
}
// Create trading indicators analysis (enhanced with DEXScreener data)
async function createTradingIndicators(token, details, specificContainer = null) {
    const container = specificContainer || document.getElementById('trading-indicators-container');
    
    if (!container) {
        console.log('Trading indicators container not found');
        return;
    }
    
    // Show loading state
    container.innerHTML = `
        <div class="indicators-loading">
            <div class="spinner"></div>
            <p>Fetching real-time trading data...</p>
        </div>
    `;
    
    // Fetch RugCheck data if it's a Solana token
    let rugCheckScore = null;
    if (token.chain === 'solana') {
        try {
            const rugResponse = await fetch(`${API_BASE_URL}/api/rugcheck/${token.address}`);
            const rugData = await rugResponse.json();
            if (rugData.report && !rugData.error) {
                rugCheckScore = rugData.report.score_normalised || rugData.report.score || null;
                console.log(`📊 RugCheck score fetched: ${rugCheckScore}/100`);
            }
        } catch (error) {
            console.log('Could not fetch RugCheck for indicators:', error.message);
        }
    }
    
    // Fetch real volume and liquidity data for EVM tokens (BSC, Base, Ethereum)
    let realVolumeData = null;
    if (['bnb', 'base', 'eth'].includes(token.chain)) {
        try {
            const pairsResponse = await fetch(`${API_BASE_URL}/api/token-pairs/${token.chain}/${token.address}`);
            const pairsData = await pairsResponse.json();
            if (pairsData && !pairsData.error) {
                realVolumeData = {
                    liquidity: pairsData.totalLiquidity || 0,
                    volume24h: pairsData.total24hVolume || 0,
                    pairCount: pairsData.pairCount || 0
                };
                console.log(`📊 Token pairs data fetched: $${realVolumeData.liquidity.toFixed(2)} liquidity, $${realVolumeData.volume24h.toFixed(2)} volume`);
            }
        } catch (error) {
            console.log('Could not fetch token pairs for indicators:', error.message);
        }
    }
    
    // Fetch DEX paid status
    let dexPaidStatus = null;
    try {
        const dexStatus = await checkDexScreenerPaidStatus(token.chain, token.address);
        if (dexStatus && dexStatus !== null) {
            dexPaidStatus = dexStatus.isPaid || false;
            console.log(`📊 DEX paid status: ${dexPaidStatus ? 'Paid' : 'Not Paid'}`);
        }
    } catch (error) {
        console.log('Could not fetch DEX paid status:', error.message);
    }
    
    try {
        // Try to get enhanced indicators from DEXScreener with timeout
        const enhancedPromise = getEnhancedTradingIndicators(token, details);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Enhanced indicators timeout')), 15000)
        );
        
        const enhancedIndicators = await Promise.race([enhancedPromise, timeoutPromise]);
        
        if (enhancedIndicators && enhancedIndicators.indicators.length > 0) {
            renderEnhancedIndicators(container, enhancedIndicators, rugCheckScore);
            return; // Successfully rendered, exit early
        }
        
        // If no indicators, fall through to basic
        throw new Error('No enhanced indicators returned');
    } catch (error) {
        console.error('Error loading enhanced indicators, using fallback:', error.message);
        // Always fallback to basic indicators if enhanced fails
        try {
            const indicators = calculateTradingIndicators(token, details, rugCheckScore, realVolumeData, dexPaidStatus);
            renderBasicIndicators(container, indicators);
        } catch (fallbackError) {
            console.error('Error rendering basic indicators:', fallbackError);
            if (container) {
                container.innerHTML = `
                    <div class="indicators-loading">
                        <p>⚠️ Unable to load trading indicators</p>
                        <p style="font-size: 12px; color: var(--text-secondary);">${fallbackError.message}</p>
                    </div>
                `;
            }
        }
    }
}
// Render enhanced indicators from DEXScreener
function renderEnhancedIndicators(container, data, rugCheckScore = null) {
    const { indicators, additionalMetrics } = data;
    
    // Adjust overall signal based on RugCheck
    let adjustedIndicators = [...indicators];
    let rugCheckOverride = '';
    
    if (rugCheckScore !== null) {
        // RugCheck: lower score = safer/more bullish
        // 0-20: Mega bullish, 21-40: Bullish, 41-70: Caution, 71+: High risk
        
        // Find the "Overall" indicator
        const overallIndex = adjustedIndicators.findIndex(ind => ind.includes('Overall:'));
        
        if (rugCheckScore > 70) {
            // HIGH RISK - Override to bearish
            rugCheckOverride = `⚠️ RugCheck shows HIGH RISK (${rugCheckScore}/100) - Token may be unsafe despite technical indicators`;
            if (overallIndex >= 0) {
                adjustedIndicators[overallIndex] = adjustedIndicators[overallIndex].replace('🟢 Strong Buy', '🔴 Avoid/High Risk').replace('🟢', '🔴').replace('Strong Buy', 'Avoid - Security Risk');
            }
        } else if (rugCheckScore > 40) {
            // MEDIUM RISK - Add caution
            rugCheckOverride = `⚠️ RugCheck shows MEDIUM RISK (${rugCheckScore}/100) - Exercise caution`;
            if (overallIndex >= 0 && adjustedIndicators[overallIndex].includes('Strong Buy')) {
                adjustedIndicators[overallIndex] = adjustedIndicators[overallIndex].replace('Strong Buy', 'Cautious Hold').replace('🟢', '🟡');
            }
        } else if (rugCheckScore <= 20) {
            // MEGA BULLISH - Boost signal
            rugCheckOverride = `✅ RugCheck shows VERY SAFE (${rugCheckScore}/100) - Excellent security profile`;
            if (overallIndex >= 0 && !adjustedIndicators[overallIndex].includes('Strong Buy')) {
                adjustedIndicators[overallIndex] = adjustedIndicators[overallIndex].replace('Neutral/Cautious', 'Strong Buy').replace('Avoid/Sell', 'Hold/Monitor').replace('🟡', '🟢');
            }
        } else {
            // LOW RISK (21-40) - Positive signal
            rugCheckOverride = `✅ RugCheck shows LOW RISK (${rugCheckScore}/100) - Safe to trade`;
        }
    }
    
    container.innerHTML = `
        ${rugCheckOverride ? `
            <div class="rugcheck-indicator-alert" style="background: ${rugCheckScore > 70 ? 'rgba(255, 71, 87, 0.1)' : rugCheckScore > 40 ? 'rgba(255, 184, 0, 0.1)' : 'rgba(0, 255, 136, 0.1)'}; border: 1px solid ${rugCheckScore > 70 ? '#FF4757' : rugCheckScore > 40 ? '#FFB800' : '#00FF88'}; border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; color: ${rugCheckScore > 70 ? '#FF4757' : rugCheckScore > 40 ? '#FFB800' : '#00FF88'};">
                ${rugCheckOverride}
            </div>
        ` : ''}
        
        <div class="trading-indicators-list">
            ${adjustedIndicators.map(indicator => {
                // Parse emoji and status from indicator string
                const emoji = indicator.match(/[🟢🔴🟡]/)?.[0] || '🟡';
                const isBullish = emoji === '🟢';
                const isBearish = emoji === '🔴';
                const status = isBullish ? 'bullish' : isBearish ? 'bearish' : 'neutral';
                const cleanText = indicator.replace(/[🟢🔴🟡]/g, '').trim();
                const [label, ...descParts] = cleanText.split(': ');
                const description = descParts.join(': ') || '';
                
                return `
                    <div class="trading-indicator-item">
                        <div class="indicator-status ${status}">
                            <div class="indicator-dot"></div>
                        </div>
                        <div class="indicator-info">
                            <div class="indicator-label">${label || cleanText}</div>
                            <div class="indicator-value">${description || cleanText}</div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
        
        ${additionalMetrics && additionalMetrics.length > 0 ? `
            <div class="trading-additional-metrics">
                <h4 style="margin: 20px 0 10px; font-size: 14px; color: var(--text-secondary);">Additional Metrics</h4>
                <div class="metrics-grid">
                    ${additionalMetrics.map(metric => `
                        <div class="metric-item">${metric}</div>
                    `).join('')}
                </div>
            </div>
        ` : ''}
    `;
}

// Render basic indicators (fallback)
function renderBasicIndicators(container, indicators) {
    container.innerHTML = `
        <div class="trading-indicators-list">
            ${indicators.map(indicator => `
                <div class="trading-indicator-item">
                    <div class="indicator-status ${indicator.status}">
                        <div class="indicator-dot"></div>
                    </div>
                    <div class="indicator-info">
                        <div class="indicator-label">${indicator.label}</div>
                        <div class="indicator-value">${indicator.description}</div>
                    </div>
                </div>
            `).join('')}
        </div>
        
        <div class="trading-overall-signal ${indicators[indicators.length - 1].status}">
            <span class="signal-label">Overall Signal:</span>
            <span class="signal-value">${indicators[indicators.length - 1].description}</span>
        </div>
    `;
}

// ===== Enhanced Trading Indicators (DEXScreener-based) =====

// Technical analysis helper functions
function movingAvg(values, windowSize) {
    const output = new Array(values.length);
    let rollingSum = 0;
    for (let i = 0; i < values.length; i += 1) {
        rollingSum += values[i];
        if (i >= windowSize) rollingSum -= values[i - windowSize];
        output[i] = i >= windowSize - 1 ? rollingSum / windowSize : null;
    }
    return output;
}

function rsi14(closes) {
    const n = 14;
    const rsi = new Array(closes.length).fill(null);
    let gains = 0;
    let losses = 0;
    
    for (let i = 1; i <= n && i < closes.length; i += 1) {
        const delta = closes[i] - closes[i - 1];
        if (delta >= 0) gains += delta; else losses -= delta;
    }
    
    let avgG = gains / n;
    let avgL = losses / n;
    
    if (closes.length > n) {
        rsi[n] = 100 - 100 / (1 + (avgG / (avgL || 1e-9)));
    }
    
    for (let i = n + 1; i < closes.length; i += 1) {
        const delta = closes[i] - closes[i - 1];
        const g = Math.max(delta, 0);
        const l = Math.max(-delta, 0);
        avgG = (avgG * (n - 1) + g) / n;
        avgL = (avgL * (n - 1) + l) / n;
        rsi[i] = 100 - 100 / (1 + (avgG / (avgL || 1e-9)));
    }
    
    return rsi;
}

function fmtUsd(n) {
    if (n == null || n === undefined) return '—';
    const v = +n;
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'k';
    return '$' + v.toFixed(2);
}

// Resolve best pair from DEXScreener
async function resolveBestPair(address) {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
    const response = await fetchWithTimeout(url, 8000);
    
    if (!response.ok) throw new Error('Pair lookup failed');
    
    const data = await response.json();
    const pairs = data && data.pairs ? data.pairs : [];
    
    if (!pairs.length) throw new Error('No pairs found');
    
    // Sort by liquidity (highest first)
    pairs.sort((a, b) => ((b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)));
    
    const best = pairs[0];
    return {
        chainId: best.chainId || '',
        pairAddress: String(best.pairAddress || ''),
        meta: best
    };
}

// Fetch candles from DEXScreener
async function fetchCandles(chainId, pairAddress, timeframe = '4h', limit = 300) {
    const url = `https://api.dexscreener.com/latest/dex/candles/${chainId}/${pairAddress}?timeframe=${timeframe}&limit=${limit}`;
    const response = await fetchWithTimeout(url, 8000);
    
    if (!response.ok) throw new Error('Candles fetch failed');
    
    const data = await response.json();
    const candles = data.candles || data.data || data;
    
    if (!candles || !candles.length) throw new Error('No candles data');
    
    const dates = [];
    const closes = [];
    
    for (let i = 0; i < candles.length; i += 1) {
        const c = candles[i];
        const t = c.t || c.time || c.timestamp;
        const close = c.c || c.close;
        if (t != null && close != null) {
            dates.push(+t);
            closes.push(+close);
        }
    }
    
    return { dates, closes };
}

// Generate trading indicators from data
function generateTradingIndicators(data) {
    const out = [];
    
    // 1) RSI
    let rsiSignal;
    if (data.rsiNow > 70) rsiSignal = '🔴 Overbought - Sell Signal';
    else if (data.rsiNow < 30) rsiSignal = '🟢 Oversold - Buy Signal';
    else if (data.rsiNow > 50) rsiSignal = '🟡 Bullish Momentum';
    else rsiSignal = '🟡 Bearish Momentum';
    out.push('RSI(14): ' + data.rsiNow.toFixed(1) + ' - ' + rsiSignal);
    
    // 2) MA signal
    out.push('MA Signal: ' + (data.maBull ? '🟢 Bullish - MA20 > MA50' : '🔴 Bearish - MA20 < MA50'));
    
    // 3) Momentum
    out.push('Momentum: ' + (data.momentumUp ? '🟢 Rising Price Action' : '🔴 Declining Price Action'));
    
    // 4) Fibonacci
    const last = data.closes.length ? data.closes[data.closes.length - 1] : null;
    if (last != null) {
        const fibSignal = last > data.fib618 ? '🟢 Above Key Resistance' : last < data.fib382 ? '🔴 Below Strong Support' : '🟡 Trading Range';
        out.push('Fibonacci: ' + fibSignal);
    } else {
        out.push('Fibonacci: —');
    }
    
    // 5) Volume
    if (typeof data.vol === 'number') {
        const v = data.vol;
        const volSignal = v > 1000000 ? '🟢 High Volume - Strong Interest' : v > 100000 ? '🟡 Moderate Volume' : '🔴 Low Volume - Weak Interest';
        out.push('Volume: ' + volSignal);
    } else {
        out.push('Volume: —');
    }
    
    // 6) Liquidity
    if (typeof data.liq === 'number') {
        const l = data.liq;
        const liqSignal = l > 500000 ? '🟢 Excellent Liquidity' : l > 100000 ? '🟡 Good Liquidity' : '🔴 Low Liquidity Risk';
        out.push('Liquidity: ' + liqSignal);
    } else {
        out.push('Liquidity: —');
    }
    
    // 7) Distribution
    if (typeof data.top10 === 'number') {
        const t = data.top10;
        const holderSignal = t < 40 ? '🟢 Well Distributed' : t < 60 ? '🟡 Moderate Concentration' : '🔴 High Concentration Risk';
        out.push('Distribution: ' + holderSignal);
    } else {
        out.push('Distribution: —');
    }
    
    // 8) Security
    if (typeof data.lpLocked === 'boolean' || typeof data.renounced === 'boolean') {
        const score = (data.lpLocked ? 1 : 0) + (data.renounced ? 1 : 0);
        const sec = score === 2 ? '🟢 High Security' : score === 1 ? '🟡 Moderate Security' : '🔴 Security Concerns';
        out.push('Security: ' + sec);
    } else {
        out.push('Security: —');
    }
    
    // 9) Trend Strength
    let trendStrength = 0;
    if (data.momentumUp) trendStrength += 1;
    if (data.maBull) trendStrength += 1;
    if (data.rsiNow > 50) trendStrength += 1;
    const trend = trendStrength >= 2 ? '🟢 Strong Trend' : trendStrength === 1 ? '🟡 Weak Trend' : '🔴 Bearish Trend';
    out.push('Trend: ' + trend);
    
    // 10) Overall Score
    let total = 0;
    if (data.momentumUp) total += 1;
    if (data.maBull) total += 1;
    if (data.rsiNow > 50 && data.rsiNow < 70) total += 1;
    if (typeof data.liq === 'number' && data.liq > 100000) total += 1;
    if (typeof data.vol === 'number' && data.vol > 100000) total += 1;
    if (typeof data.top10 === 'number' && data.top10 < 60) total += 1;
    if (data.lpLocked) total += 1;
    if (data.renounced) total += 1;
    const overall = total >= 6 ? '🟢 Strong Buy Signal' : total >= 4 ? '🟡 Neutral/Cautious' : '🔴 Avoid/Sell Signal';
    out.push('Overall: ' + overall + ' (' + total + '/8)');
    
    return out;
}

// Generate additional metrics
function generateAdditionalMetrics(data) {
    const out = [];
    
    if (data.closes && data.closes.length > 0) {
        const currentPrice = data.closes[data.closes.length - 1];
        out.push('Current Price: $' + currentPrice.toFixed(6));
    }
    
    if (data.closes && data.closes.length > 5) {
        const current = data.closes[data.closes.length - 1];
        const prev = data.closes[data.closes.length - 5];
        const change = ((current - prev) / prev) * 100;
        const icon = change > 0 ? '🟢' : '🔴';
        out.push('5-Candle Change: ' + icon + ' ' + change.toFixed(2) + '%');
    }
    
    const marketCap = (data.liq ?? 0) * 4;
    out.push('Est. Market Cap: ' + fmtUsd(marketCap));
    
    if (typeof data.liq === 'number' && typeof data.vol === 'number' && data.liq > 0) {
        const ratio = (data.vol / data.liq).toFixed(2);
        out.push('Volume/Liquidity: ' + ratio + 'x');
    }
    
    if (typeof data.top10 === 'number') {
        const risk = data.top10 > 60 ? '🔴 High' : data.top10 > 40 ? '🟡 Medium' : '🟢 Low';
        out.push('Concentration Risk: ' + risk);
    }
    
    if (typeof data.lpLocked === 'boolean' || typeof data.renounced === 'boolean') {
        const secScore = (data.lpLocked ? 1 : 0) + (data.renounced ? 1 : 0);
        const sec = secScore === 2 ? '🟢 Excellent' : secScore === 1 ? '🟡 Good' : '🔴 Poor';
        out.push('Security Rating: ' + sec);
    }
    
    let trendScore = 0;
    if (data.momentumUp) trendScore += 1;
    if (data.maBull) trendScore += 1;
    if (data.rsiNow > 50) trendScore += 1;
    const trend = trendScore >= 2 ? '🟢 Strong' : trendScore === 1 ? '🟡 Weak' : '🔴 Bearish';
    out.push('Trend Strength: ' + trend);
    
    let total = 0;
    if (data.momentumUp) total += 1;
    if (data.maBull) total += 1;
    if (data.rsiNow > 50 && data.rsiNow < 70) total += 1;
    if (typeof data.liq === 'number' && data.liq > 100000) total += 1;
    if (typeof data.vol === 'number' && data.vol > 100000) total += 1;
    if (typeof data.top10 === 'number' && data.top10 < 60) total += 1;
    if (data.lpLocked) total += 1;
    if (data.renounced) total += 1;
    const overall = total >= 6 ? '🟢 Strong Buy' : total >= 4 ? '🟡 Hold' : '🔴 Avoid';
    out.push('Overall Rating: ' + overall);
    
    return out;
}

// Fetch with timeout helper
async function fetchWithTimeout(url, timeout = 8000) {
    const controller = createAbortController();
    const timeoutId = controller ? setTimeout(() => controller.abort(), timeout) : null;
    
    try {
        const response = await fetch(url, controller?.signal ? { signal: controller.signal } : {});
        if (timeoutId) clearTimeout(timeoutId);
        return response;
    } catch (error) {
        if (timeoutId) clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Request timeout - API took too long to respond');
        }
        throw error;
    }
}

// Get enhanced trading indicators from DEXScreener
async function getEnhancedTradingIndicators(token, details) {
    try {
        const address = token.address;
        
        // Add timeout to resolveBestPair call
        const resolvePromise = resolveBestPair(address);
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Pair resolution timeout')), 8000)
        );
        const info = await Promise.race([resolvePromise, timeoutPromise]);
        
        const pair = info.meta;
        
        // Get liquidity and volume from pair or overrides
        const liq = pair.liquidity?.usd;
        const vol = pair.volume?.h24 || pair.volume?.['24h'];
        
        // Fetch candle data with timeout
        const cdlsPromise = fetchCandles(info.chainId, info.pairAddress, '4h', 300);
        const cdlsTimeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Candles fetch timeout')), 8000)
        );
        const cdls = await Promise.race([cdlsPromise, cdlsTimeoutPromise]);
        const closes = cdls.closes;
        
        if (!closes || closes.length < 50) {
            throw new Error('Insufficient candle data');
        }
        
        const last = closes[closes.length - 1];
        const prev = closes[Math.max(0, closes.length - 5)];
        const momentumUp = last > prev;
        
        // Calculate Moving Averages
        const ma20 = movingAvg(closes, 20);
        const ma50 = movingAvg(closes, 50);
        const ma20Last = ma20[ma20.length - 1];
        const ma50Last = ma50[ma50.length - 1];
        const maBull = (ma20Last != null && ma50Last != null) ? (ma20Last > ma50Last) : false;
        
        // Calculate Fibonacci levels
        const windowStart = Math.max(0, closes.length - 120);
        const win = closes.slice(windowStart);
        const lo = Math.min(...win);
        const hi = Math.max(...win);
        const fib618 = lo + (hi - lo) * 0.618;
        const fib382 = lo + (hi - lo) * 0.382;
        
        // Calculate RSI
        const rsiVals = rsi14(closes);
        const rsiNowRaw = rsiVals[rsiVals.length - 1];
        const rsiNow = typeof rsiNowRaw === 'number' ? +rsiNowRaw.toFixed(1) : 50;
        
        // Get optional data from token details
        const top10 = undefined; // Could be calculated from holders data
        const lpLocked = undefined; // Could be fetched from contract
        const renounced = undefined; // Could be fetched from contract
        
        const data = {
            momentumUp,
            maBull,
            rsiNow,
            fib618,
            fib382,
            top10,
            lpLocked,
            renounced,
            liq: typeof liq === 'number' ? liq : undefined,
            vol: typeof vol === 'number' ? vol : undefined,
            closes
        };
        
        const indicators = generateTradingIndicators(data);
        const additionalMetrics = generateAdditionalMetrics(data);
        
        return { indicators, additionalMetrics };
        
    } catch (error) {
        console.error('Error fetching enhanced indicators:', error.message);
        throw error;
    }
}
// Calculate trading indicators based on token data
function calculateTradingIndicators(token, details, rugCheckScore = null, realVolumeData = null, dexPaidStatus = null) {
    const indicators = [];
    
    // Use real volume/liquidity data if available, otherwise fall back to token data
    const volume24h = realVolumeData ? realVolumeData.volume24h : 0;
    const liquidityUSD = realVolumeData ? realVolumeData.liquidity : (token.liquidity || 0);
    
    // 1. Price Momentum (based on 24h change)
    const priceChange = token.priceChange24h || 0;
    let momentumStatus = 'neutral';
    let momentumDesc = 'Neutral Momentum';
    
    if (priceChange > 20) {
        momentumStatus = 'bullish';
        momentumDesc = 'Strong Bullish Momentum';
    } else if (priceChange > 5) {
        momentumStatus = 'bullish';
        momentumDesc = 'Bullish Momentum';
    } else if (priceChange < -20) {
        momentumStatus = 'bearish';
        momentumDesc = 'Strong Bearish Momentum';
    } else if (priceChange < -5) {
        momentumStatus = 'bearish';
        momentumDesc = 'Bearish Momentum';
    }
    
    indicators.push({
        label: `Momentum: ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%`,
        description: momentumDesc,
        status: momentumStatus
    });
    
    // 2. Volume Analysis (real 24h volume)
    let volumeStatus = 'neutral';
    let volumeDesc = 'Moderate Volume';
    
    if (volume24h > 0) {
        // Use real volume data with micro/mini cap thresholds
        if (volume24h > 500000) {
            volumeStatus = 'bullish';
            volumeDesc = 'High Volume - Strong Interest';
        } else if (volume24h > 100000) {
            volumeStatus = 'bullish';
            volumeDesc = 'Good Volume';
        } else if (volume24h > 25000) {
            volumeStatus = 'neutral';
            volumeDesc = 'Moderate Volume';
        } else if (volume24h > 50000) {
            volumeStatus = 'neutral';
            volumeDesc = 'Low Volume';
        } else {
            volumeStatus = 'bearish';
            volumeDesc = 'Very Low Volume - Weak Interest';
        }
    } else {
        // Fallback to liquidity-based estimate if no volume data
        if (liquidityUSD > 250000) {
            volumeStatus = 'bullish';
            volumeDesc = 'Good Volume (estimated)';
        } else if (liquidityUSD > 50000) {
            volumeStatus = 'neutral';
            volumeDesc = 'Moderate Volume (estimated)';
        } else {
            volumeStatus = 'bearish';
            volumeDesc = 'Low Volume - Weak Interest';
        }
    }
    
    indicators.push({
        label: 'Volume:',
        description: volumeDesc,
        status: volumeStatus
    });
    
    // 3. Liquidity Health (adjusted for micro/mini caps)
    let liquidityStatus = 'neutral';
    let liquidityDesc = 'Moderate Liquidity';
    
    if (liquidityUSD > 500000) {
        liquidityStatus = 'bullish';
        liquidityDesc = 'Excellent Liquidity';
    } else if (liquidityUSD > 250000) {
        liquidityStatus = 'bullish';
        liquidityDesc = 'Good Liquidity';
    } else if (liquidityUSD > 100000) {
        liquidityStatus = 'bullish';
        liquidityDesc = 'Fair Liquidity';
    } else if (liquidityUSD > 50000) {
        liquidityStatus = 'neutral';
        liquidityDesc = 'Moderate Liquidity';
    } else if (liquidityUSD > 25000) {
        liquidityStatus = 'neutral';
        liquidityDesc = 'Low Liquidity';
    } else if (liquidityUSD > 10000) {
        liquidityStatus = 'bearish';
        liquidityDesc = 'Very Low Liquidity';
    } else {
        liquidityStatus = 'bearish';
        liquidityDesc = 'Extremely Low Liquidity';
    }
    
    indicators.push({
        label: 'Liquidity:',
        description: liquidityDesc,
        status: liquidityStatus
    });
    
    // 4. Market Cap Health (adjusted for micro/mini caps)
    const marketCap = token.marketCap || 0;
    let mcapStatus = 'neutral';
    let mcapDesc = 'Moderate Market Cap';
    
    if (marketCap > 10000000) {
        mcapStatus = 'bullish';
        mcapDesc = 'Large Cap - Established';
    } else if (marketCap > 1000000) {
        mcapStatus = 'bullish';
        mcapDesc = 'Mid Cap - Growing';
    } else if (marketCap > 250000) {
        mcapStatus = 'neutral';
        mcapDesc = 'Mini Cap - Early Stage';
    } else if (marketCap > 50000) {
        mcapStatus = 'neutral';
        mcapDesc = 'Micro Cap - Speculative';
    } else if (marketCap > 10000) {
        mcapStatus = 'bearish';
        mcapDesc = 'Nano Cap - Very High Risk';
    } else {
        mcapStatus = 'bearish';
        mcapDesc = 'Extremely Small Cap - Extreme Risk';
    }
    
    indicators.push({
        label: 'Market Cap:',
        description: mcapDesc,
        status: mcapStatus
    });
    
    // 5. Holder Distribution
    const holders = token.holders || 0;
    let holderStatus = 'neutral';
    let holderDesc = 'Moderate Distribution';
    
    if (holders > 5000) {
        holderStatus = 'bullish';
        holderDesc = 'Wide Distribution - Low Risk';
    } else if (holders > 1000) {
        holderStatus = 'bullish';
        holderDesc = 'Good Distribution';
    } else if (holders > 500) {
        holderStatus = 'neutral';
        holderDesc = 'Fair Distribution';
    } else if (holders > 100) {
        holderStatus = 'bearish';
        holderDesc = 'Concentrated Holdings';
    } else {
        holderStatus = 'bearish';
        holderDesc = 'High Concentration Risk';
    }
    
    indicators.push({
        label: 'Distribution:',
        description: holderDesc,
        status: holderStatus
    });
    
    // 6. Price Volatility
    const absChange = Math.abs(priceChange);
    let volatilityStatus = 'neutral';
    let volatilityDesc = 'Normal Volatility';
    
    if (absChange > 50) {
        volatilityStatus = 'bearish';
        volatilityDesc = 'Extreme Volatility';
    } else if (absChange > 20) {
        volatilityStatus = 'bearish';
        volatilityDesc = 'High Volatility';
    } else if (absChange < 5) {
        volatilityStatus = 'bullish';
        volatilityDesc = 'Low Volatility - Stable';
    }
    
    indicators.push({
        label: 'Volatility:',
        description: volatilityDesc,
        status: volatilityStatus
    });
    
    // 7. DEX Paid Status
    let dexStatus = 'neutral';
    let dexDesc = 'Not Promoted';
    
    if (dexPaidStatus === true) {
        dexStatus = 'bullish';
        dexDesc = 'DEX Paid - Promoted Listing';
    } else if (dexPaidStatus === false) {
        dexStatus = 'neutral';
        dexDesc = 'Not Promoted';
    } else {
        dexStatus = 'neutral';
        dexDesc = 'Status Unknown';
    }
    
    indicators.push({
        label: 'DEX Status:',
        description: dexDesc,
        status: dexStatus
    });
    
    // 8. Age/Maturity (based on creation date)
    const createdDate = new Date(token.createdAt);
    const ageInDays = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24);
    let ageStatus = 'neutral';
    let ageDesc = 'Kinda Ok';
    
    if (ageInDays >= 30) {
        ageStatus = 'bullish';
        ageDesc = 'Super Ok';
    } else if (ageInDays >= 7) {
        ageStatus = 'neutral';
        ageDesc = 'Kinda Ok';
    } else {
        ageStatus = 'bearish';
        ageDesc = 'Very New';
    }
    
    indicators.push({
        label: 'Age:',
        description: ageDesc,
        status: ageStatus
    });
    
    // 9. Trend Analysis (based on momentum and volume)
    let trendStatus = 'neutral';
    let trendDesc = 'Sideways Trend';
    
    if (priceChange > 10 && liquidityUSD > 100000) {
        trendStatus = 'bullish';
        trendDesc = 'Strong Uptrend';
    } else if (priceChange > 5) {
        trendStatus = 'bullish';
        trendDesc = 'Bullish Trend';
    } else if (priceChange < -10 && liquidityUSD > 100000) {
        trendStatus = 'bearish';
        trendDesc = 'Strong Downtrend';
    } else if (priceChange < -5) {
        trendStatus = 'bearish';
        trendDesc = 'Bearish Trend';
    }
    
    indicators.push({
        label: 'Trend:',
        description: trendDesc,
        status: trendStatus
    });
    
    // 10. Overall Signal (weighted with RugCheck priority)
    const bullishCount = indicators.filter(i => i.status === 'bullish').length;
    const bearishCount = indicators.filter(i => i.status === 'bearish').length;
    const neutralCount = indicators.filter(i => i.status === 'neutral').length;
    
    let overallStatus = 'neutral';
    let overallDesc = 'Hold/Neutral Signal';
    
    // RugCheck has HEAVY WEIGHT in overall calculation
    if (rugCheckScore !== null) {
        if (rugCheckScore > 70) {
            // HIGH RISK - Override to bearish regardless of other indicators
            overallStatus = 'bearish';
            overallDesc = `Strong Sell Signal (${bearishCount}/${indicators.length}) - High Risk Token`;
        } else if (rugCheckScore > 40) {
            // MEDIUM RISK - Can only be neutral or bearish
            if (bearishCount >= 4) {
                overallStatus = 'bearish';
                overallDesc = `Avoid/Sell Signal (${bearishCount}/${indicators.length})`;
            } else {
                overallStatus = 'neutral';
                overallDesc = `Cautious Hold (${bullishCount}B/${bearishCount}S) - Medium Risk`;
            }
        } else if (rugCheckScore <= 20) {
            // MEGA BULLISH - Boost signal
            if (bullishCount >= 4) {
                overallStatus = 'bullish';
                overallDesc = `Strong Buy Signal (${bullishCount}/${indicators.length}) - Very Safe Token`;
            } else if (bullishCount >= 2) {
                overallStatus = 'bullish';
                overallDesc = `Buy Signal (${bullishCount}/${indicators.length})`;
            } else if (bearishCount >= 6) {
                overallStatus = 'bearish';
                overallDesc = `Sell Signal (${bearishCount}/${indicators.length})`;
            } else {
                overallStatus = 'neutral';
                overallDesc = `Hold Signal (${bullishCount}B/${bearishCount}S)`;
            }
        } else {
            // LOW RISK (21-40) - Normal calculation with slight bullish bias
            if (bullishCount >= 5) {
                overallStatus = 'bullish';
                overallDesc = `Strong Buy Signal (${bullishCount}/${indicators.length})`;
            } else if (bullishCount >= 3) {
                overallStatus = 'bullish';
                overallDesc = `Buy Signal (${bullishCount}/${indicators.length})`;
            } else if (bearishCount >= 5) {
                overallStatus = 'bearish';
                overallDesc = `Sell Signal (${bearishCount}/${indicators.length})`;
            } else {
                overallDesc = `Neutral Signal (${bullishCount}B/${bearishCount}S)`;
            }
        }
    } else {
        // No RugCheck - use standard calculation
        if (bullishCount >= 6) {
            overallStatus = 'bullish';
            overallDesc = `Strong Buy Signal (${bullishCount}/${indicators.length})`;
        } else if (bullishCount >= 4) {
            overallStatus = 'bullish';
            overallDesc = `Buy Signal (${bullishCount}/${indicators.length})`;
        } else if (bearishCount >= 6) {
            overallStatus = 'bearish';
            overallDesc = `Strong Sell Signal (${bearishCount}/${indicators.length})`;
        } else if (bearishCount >= 4) {
            overallStatus = 'bearish';
            overallDesc = `Avoid/Sell Signal (${bearishCount}/${indicators.length})`;
        } else {
            overallDesc = `Neutral Signal (${bullishCount}B/${neutralCount}N/${bearishCount}S)`;
        }
    }
    
    indicators.push({
        label: 'Overall:',
        description: overallDesc,
        status: overallStatus
    });
    
    return indicators;
}
// Load and display RugCheck report (Solana only)
async function loadRugCheck(token) {
    const container = document.getElementById('rugcheck-container');
    
    if (!container) {
        console.log('RugCheck container not found');
        return;
    }
    
    try {
        console.log(`🛡️ Fetching RugCheck report for ${token.address}...`);
        
        const response = await fetch(`${API_BASE_URL}/api/rugcheck/${token.address}`);
        const data = await response.json();
        
        if (data.error || !data.report) {
            throw new Error(data.message || 'No report available');
        }
        
        // Render the report
        renderRugCheckReport(data.report, container);
        
    } catch (error) {
        console.error('Error loading RugCheck:', error);
        container.innerHTML = `
            <div class="rugcheck-unavailable">
                <div class="rugcheck-unavailable-icon">🚫</div>
                <p>RugCheck analysis unavailable</p>
                <p class="rugcheck-hint">${error.message}</p>
            </div>
        `;
    }
}

// Render RugCheck report
function renderRugCheckReport(report, container) {
    // Extract key metrics from the report
    const risks = report.risks || [];
    // Use score_normalised which is the correct score out of 100
    const score = report.score_normalised || report.score || 0;
    const tokenSecurity = report.tokenSecurity || {};
    const liquidityInfo = report.liquidity || {};
    const marketInfo = report.market || {};
    
    // Determine overall risk level (INVERTED: lower score = safer/more bullish)
    let riskLevel = 'low';
    let riskColor = '#00FF88';
    let riskIcon = '✅';
    
    if (score > 70) {
        riskLevel = 'high';
        riskColor = '#FF4757';
        riskIcon = '🚨';
    } else if (score > 40) {
        riskLevel = 'medium';
        riskColor = '#FFB800';
        riskIcon = '⚠️';
    }
    
    // Determine sentiment text
    let sentimentText = 'MEGA BULLISH';
    if (score > 70) {
        sentimentText = 'HIGH RISK - AVOID';
    } else if (score > 40) {
        sentimentText = 'MEDIUM RISK - CAUTION';
    } else if (score <= 20) {
        sentimentText = 'MEGA BULLISH - VERY SAFE';
    } else {
        sentimentText = 'BULLISH - LOW RISK';
    }
    
    container.innerHTML = `
        <div class="rugcheck-report">
            <!-- Overall Score -->
            <div class="rugcheck-score-card" style="border-color: ${riskColor};">
                <div class="rugcheck-score-icon">${riskIcon}</div>
                <div class="rugcheck-score-info">
                    <div class="rugcheck-score-label">Overall Safety Score</div>
                    <div class="rugcheck-score-value" style="color: ${riskColor};">${score}/100</div>
                    <div class="rugcheck-risk-level ${riskLevel}">
                        ${sentimentText}
                    </div>
                    <div class="rugcheck-score-hint">(Lower score = Safer token)</div>
                </div>
            </div>
            
            <!-- Risk Warnings -->
            ${risks && risks.length > 0 ? `
                <div class="rugcheck-risks">
                    <h4>⚠️ Risk Factors</h4>
                    <div class="rugcheck-risk-list">
                        ${risks.map(risk => `
                            <div class="rugcheck-risk-item ${risk.level || 'medium'}">
                                <div class="risk-indicator"></div>
                                <div class="risk-content">
                                    <div class="risk-title">${risk.name || 'Security Warning'}</div>
                                    <div class="risk-description">${risk.description || ''}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : `
                <div class="rugcheck-no-risks">
                    <div class="no-risks-icon">✅</div>
                    <p>No major risks detected</p>
                </div>
            `}
            
            <!-- Token Security Info -->
            ${Object.keys(tokenSecurity).length > 0 ? `
                <div class="rugcheck-security-info">
                    <h4>🔒 Token Security</h4>
                    <div class="rugcheck-info-grid">
                        ${tokenSecurity.mintable !== undefined ? `
                            <div class="rugcheck-info-item">
                                <span class="info-label">Mintable:</span>
                                <span class="info-value ${tokenSecurity.mintable ? 'negative' : 'positive'}">
                                    ${tokenSecurity.mintable ? '❌ Yes' : '✅ No'}
                                </span>
                            </div>
                        ` : ''}
                        ${tokenSecurity.freezable !== undefined ? `
                            <div class="rugcheck-info-item">
                                <span class="info-label">Freezable:</span>
                                <span class="info-value ${tokenSecurity.freezable ? 'negative' : 'positive'}">
                                    ${tokenSecurity.freezable ? '❌ Yes' : '✅ No'}
                                </span>
                            </div>
                        ` : ''}
                        ${tokenSecurity.burned !== undefined ? `
                            <div class="rugcheck-info-item">
                                <span class="info-label">LP Burned:</span>
                                <span class="info-value ${tokenSecurity.burned ? 'positive' : 'negative'}">
                                    ${tokenSecurity.burned ? '✅ Yes' : '❌ No'}
                                </span>
                            </div>
                        ` : ''}
                    </div>
                </div>
            ` : ''}
            
            <!-- Powered by RugCheck -->
            <div class="rugcheck-footer">
                <span>Powered by</span>
                <a href="https://rugcheck.xyz" target="_blank" rel="noopener noreferrer">
                    <strong>RugCheck.xyz</strong> 🛡️
                </a>
            </div>
        </div>
    `;
}

// Check DEXScreener paid status
async function checkDexScreenerPaidStatus(chain, address) {
    try {
        // Map internal chain names to DEXScreener chain IDs
        const chainMap = {
            'bnb': 'bsc',
            'base': 'base',
            'ethereum': 'ethereum',
            'solana': 'solana'
        };
        
        const dexChain = chainMap[chain] || chain;
        
        console.log(`🔍 Checking DEXScreener paid status for ${address} on ${dexChain}...`);
        
        const response = await fetch(`https://api.dexscreener.com/orders/v1/${dexChain}/${address}`);
        
        if (!response.ok) {
            console.log('⚠️ DEXScreener API returned non-OK status:', response.status);
            return null;
        }
        
        const data = await response.json();
        console.log('✅ DEXScreener response:', data);
        
        // Check if there are any paid orders
        if (data && Array.isArray(data) && data.length > 0) {
            // Check if any order is processing or has a payment timestamp
            const hasPaidOrder = data.some(order => 
                order.type === 'tokenProfile' && 
                (order.status === 'processing' || order.paymentTimestamp)
            );
            
            return {
                isPaid: hasPaidOrder,
                orders: data
            };
        }
        
        return {
            isPaid: false,
            orders: []
        };
    } catch (error) {
        console.error('❌ Error checking DEXScreener status:', error);
        return null;
    }
}

// Update DEXScreener badge in modal
function updateDexScreenerBadge(status) {
    const badge = document.getElementById('dexscreener-badge');
    
    if (!badge) return;
    
    if (status === null) {
        // API error or unavailable
        badge.style.display = 'none';
        return;
    }
    
    badge.style.display = 'inline-flex';
    
    if (status.isPaid) {
        badge.innerHTML = `
            <span style="display: flex; align-items: center; gap: 6px;">
                ✅ <strong>DEX Paid</strong>
            </span>
        `;
        badge.style.background = 'rgba(0, 255, 136, 0.15)';
        badge.style.border = '1px solid rgba(0, 255, 136, 0.4)';
        badge.style.color = '#00FF88';
    } else {
        badge.innerHTML = `
            <span style="display: flex; align-items: center; gap: 6px;">
                ℹ️ Not Promoted
            </span>
        `;
        badge.style.background = 'rgba(160, 174, 192, 0.1)';
        badge.style.border = '1px solid rgba(160, 174, 192, 0.3)';
        badge.style.color = '#A0AEC0';
    }
}

// ===== AI Analysis Payment Tracking =====

/**
 * Mark analysis as paid for a specific token
 */
function markAnalysisAsPaid(chain, address) {
    try {
        const key = `paid_analysis_${chain}_${address}`;
        localStorage.setItem(key, 'true');
        console.log(`✅ Marked analysis as paid: ${chain}/${address}`);
    } catch (error) {
        console.error('Error marking analysis as paid:', error);
    }
}

/**
 * Check if analysis has been paid for a specific token
 */
function isAnalysisPaid(chain, address) {
    try {
        const key = `paid_analysis_${chain}_${address}`;
        return localStorage.getItem(key) === 'true';
    } catch (error) {
        console.error('Error checking analysis payment status:', error);
        return false;
    }
}

/**
 * Check payment status and show trading indicators or locked state
 * Only shows indicators if analysis has been paid for
 */
async function checkAndShowTradingIndicators(token, details) {
    const container = document.getElementById('trading-indicators-container');
    const loadingDiv = container?.querySelector('.indicators-loading');
    
    if (!container) return;
    
    // Check if analysis has been paid for this token
    const isPaid = isAnalysisPaid(token.chain, token.address);
    
    if (!isPaid) {
        // Show locked state
        container.innerHTML = `
            <div class="indicators-locked">
                <div class="indicators-locked-icon">
                    <i class='bx bx-lock-alt'></i>
                </div>
                <div class="indicators-locked-content">
                    <h4>Trading Indicators Locked</h4>
                    <p>Purchase AI Analysis to unlock comprehensive trading indicators and insights.</p>
                    <button class="btn-unlock-indicators" onclick="event.stopPropagation(); analyzeToken(${JSON.stringify(token).replace(/"/g, '&quot;')})">
                        <i class='bx bx-brain'></i> Unlock with AI Analysis (1 CU)
                    </button>
                </div>
            </div>
        `;
        return;
    }
    
    // Hide loading and show indicators
    if (loadingDiv) loadingDiv.style.display = 'none';
    
    // Create and show trading indicators
    await createTradingIndicators(token, details);
}

/**
 * Show a preview of what the AI analysis contains (free)
 * This calls the actual analysis endpoint but skips payment
 */
async function showAnalysisPreview(token) {
    // Handle token passed as string from HTML onclick
    if (typeof token === 'string') {
        try {
            token = JSON.parse(token.replace(/&quot;/g, '"'));
        } catch (e) {
            console.error('Error parsing token:', e);
            showToast('Invalid token data', 'error');
            return;
        }
    }
    
    // Show modal with loading state
    const modal = document.getElementById('analysis-modal');
    const modalBody = document.getElementById('modal-body');
    modal.classList.add('active');
    modalBody.innerHTML = `
        <div class="analysis-loading">
            <div class="spinner"></div>
            <p>Generating comprehensive analysis preview...</p>
            <p class="loading-subtitle">Fetching market data, holder stats, and Twitter insights...</p>
        </div>
    `;
    
    try {
        
        // Call the analyze endpoint with preview flag to skip payment
        console.log('👁️ Requesting preview analysis for:', token);
        const response = await fetch(`${API_BASE_URL}/api/analyze`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-PREVIEW': 'true' // Flag to skip payment
            },
            credentials: 'include',
            body: JSON.stringify({ 
                tokenData: token,
                chain: token.chain,
                address: token.address,
                preview: true // Also send in body
            })
        });

        console.log('📊 Preview response status:', response.status, response.statusText);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('❌ Preview error:', errorData);
            modal.classList.remove('active');
            throw new Error(errorData.message || errorData.error || 'Failed to generate preview');
        }
        
        // Get the analysis data
        const analysisData = await response.json();
        console.log('✅ Preview analysis received:', analysisData);
        console.log('🔍 Checking for twitterInsights:', {
            hasAnalysis: !!analysisData.analysis,
            hasTwitterInsights: !!analysisData.analysis?.twitterInsights,
            twitterInsightsLength: analysisData.analysis?.twitterInsights?.length || 0,
            twitterInsightsPreview: analysisData.analysis?.twitterInsights?.substring(0, 100) || 'NONE'
        });
        
        // Show the full analysis modal (same as paid, but marked as preview)
        showAnalysisModal(token, analysisData.analysis, analysisData.llmUsed, true);
        showToast('Preview analysis complete!', 'success');
        
    } catch (error) {
        console.error('Error showing analysis preview:', error);
        showToast(error.message || 'Failed to load preview', 'error');
    }
}

function closeAnalysisPreview() {
    const modal = document.getElementById('analysis-preview-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

// Helper function to copy text to clipboard
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Address copied to clipboard!', 'success');
    }).catch(err => {
        console.error('Failed to copy:', err);
        showToast('Failed to copy address', 'error');
    });
}

// ===== Buffer Polyfill for Browser =====
const Buffer = {
    from: (str) => {
        return {
            toString: (encoding) => {
                if (encoding === 'base64') {
                    return btoa(str);
                }
                return str;
            }
        };
    }
};

// ===== AI Chat Functions =====

let chatHistory = [];

// Check subscription status and update PRO badge
async function checkChatProStatus() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/subscriptions/status`, {
            method: 'GET',
            credentials: 'include'
        });
        
        if (response.ok) {
            const data = await response.json();
            const isPro = data.status === 'active';
            updateChatProBadge(isPro, data);
        }
    } catch (error) {
        console.warn('Could not check subscription status for chat:', error);
    }
}

// Update PRO badge visibility and status text
function updateChatProBadge(isPro, subscription) {
    const proBadge = document.getElementById('chat-pro-badge');
    const chatStatus = document.getElementById('chat-status');
    
    if (proBadge) {
        proBadge.style.display = isPro ? 'inline-block' : 'none';
    }
    
    if (chatStatus) {
        if (isPro && subscription) {
            chatStatus.textContent = `PRO Mode | ${subscription.planName || 'Active Subscription'} | Moralis AI + Grok + Gemini`;
        } else {
            chatStatus.textContent = 'AI Trading Assistant | Powered by Moralis AI';
        }
    }
}

function toggleChat() {
    const chatWidget = document.getElementById('chat-widget');
    const chatFab = document.getElementById('chat-fab');
    
    if (chatWidget) {
        const isActive = chatWidget.classList.contains('active');
        if (!isActive) {
            // Chat is opening - check PRO status
            checkChatProStatus();
        }
        chatWidget.classList.toggle('active');
    }
    
    if (chatFab) {
        chatFab.classList.toggle('hidden');
    }
}

function handleChatKeypress(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendChatMessage();
    }
}
async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    
    if (!message) return;
    
    // Clear input and disable
    input.value = '';
    input.disabled = true;
    document.querySelector('.chat-send-btn').disabled = true;
    
    // Add user message
    addChatMessage('user', message);
    
    // Add typing indicator
    addTypingIndicator();
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/ai-chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include', // Include cookies for authentication
            body: JSON.stringify({
                message,
                history: chatHistory,
                mode: 'auto' // Let backend decide based on subscription
            })
        });
        
        let data;
        try {
            data = await response.json();
        } catch (parseError) {
            console.error('Failed to parse AI chat response:', parseError);
            data = null;
        }
        
        if (!response.ok) {
            const serverMessage = (data && (data.message || data.error)) || `HTTP ${response.status}: ${response.statusText}`;
            throw new Error(serverMessage);
        }
        
        // Remove typing indicator
        removeTypingIndicator();
        
        if (data.error) {
            addChatMessage('bot', '⚠️ Sorry, I encountered an error: ' + (data.message || data.error));
            console.error('AI Chat error:', data);
        } else if (data.response) {
            // Add PRO mode indicator to message if applicable
            let messageContent = data.response;
            if (data.mode === 'pro') {
                let proIndicator = '<div class="chat-pro-indicator"><i class=\'bx bx-star\'></i> PRO Analysis</div>';
                if (data.hasGrokInsights) {
                    proIndicator += '<div class="chat-grok-indicator"><i class=\'bx bxl-twitter\'></i> + Grok Insights</div>';
                }
                messageContent = proIndicator + messageContent;
            }
            
            addChatMessage('bot', messageContent);
            
            // Update PRO badge in header if PRO mode
            updateChatProBadge(data.mode === 'pro', data.subscription);
            
            if (data.provider) {
                console.log(`AI response provided by ${data.provider} (${data.mode || 'free'} mode)`);
            }
            chatHistory = data.history || chatHistory;
        } else {
            addChatMessage('bot', '⚠️ Received an unexpected response format. Please try again.');
            console.error('Unexpected AI Chat response:', data);
        }
        
    } catch (error) {
        console.error('Error sending chat message:', error);
        removeTypingIndicator();
        addChatMessage('bot', `⚠️ ${error.message || 'Sorry, I had trouble connecting. Please try again.'}`);
    } finally {
        // Re-enable input
        input.disabled = false;
        document.querySelector('.chat-send-btn').disabled = false;
        input.focus();
    }
}

function addChatMessage(type, content) {
    const messagesContainer = document.getElementById('chat-messages');
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${type}`;
    
    const avatar = document.createElement('div');
    avatar.className = 'chat-message-avatar';
    
    if (type === 'user') {
        avatar.innerHTML = '<i class=\'bx bx-user\'></i>';
        avatar.className = 'chat-message-avatar user-avatar';
    } else {
        // AI message - use icon
        avatar.innerHTML = '<i class=\'bx bx-bot\'></i>';
    }
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'chat-message-content';
    
    // Convert markdown-style formatting to HTML
    const formattedContent = formatChatMessage(content);
    contentDiv.innerHTML = formattedContent;
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    
    messagesContainer.appendChild(messageDiv);
    
    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Format Twitter insights from Grok for better readability
function formatTwitterInsights(text) {
    if (!text) return '';
    
    // Escape HTML to prevent XSS
    const escapeHtml = (str) => {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    };
    
    let formatted = escapeHtml(text);
    
    // Convert markdown-style headers to HTML
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    
    // Convert bullet points to HTML list items
    formatted = formatted.replace(/^•\s+(.+)$/gm, '<li>$1</li>');
    
    // Convert numbered lists
    formatted = formatted.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
    
    // Wrap consecutive list items in <ul> tags
    formatted = formatted.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
        return '<ul>' + match + '</ul>';
    });
    
    // Convert line breaks to <br> for paragraphs
    formatted = formatted.split('\n\n').map(para => {
        if (para.trim().startsWith('<ul>') || para.trim().startsWith('<strong>')) {
            return para;
        }
        return '<p>' + para.replace(/\n/g, '<br>') + '</p>';
    }).join('');
    
    return formatted;
}

function formatChatMessage(text) {
    // Convert **bold** to <strong>
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Convert *italic* to <em>
    text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
    
    // Convert links
    text = text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color: var(--primary-cyan);">$1</a>');
    
    // Convert line breaks to <br>
    text = text.replace(/\n/g, '<br>');
    
    // Convert contract addresses (EVM: 0x + 40 hex chars, Solana: base58 encoded, typically 32-44 chars)
    // EVM addresses
    text = text.replace(/(0x[a-fA-F0-9]{40})/gi, '<code style="background: rgba(0,212,255,0.1); padding: 2px 6px; border-radius: 4px; word-break: break-all; display: inline-block; max-width: 100%; overflow-wrap: break-word;">$1</code>');
    // Solana addresses (base58, typically 32-44 characters, alphanumeric excluding 0, O, I, l)
    text = text.replace(/([1-9A-HJ-NP-Za-km-z]{32,44})/g, (match, addr) => {
        // Only match if it looks like a crypto address (starts with common prefixes or is just a long alphanumeric string)
        if (addr.length >= 32 && addr.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr) && !addr.includes(' ') && !addr.includes('\n')) {
            return `<code style="background: rgba(0,212,255,0.1); padding: 2px 6px; border-radius: 4px; word-break: break-all; display: inline-block; max-width: 100%; overflow-wrap: break-word;">${addr}</code>`;
        }
        return match;
    });
    
    return '<p>' + text + '</p>';
}

function addTypingIndicator() {
    const messagesContainer = document.getElementById('chat-messages');
    
    const typingDiv = document.createElement('div');
    typingDiv.className = 'chat-message bot typing';
    typingDiv.id = 'typing-indicator';
    
    const avatar = document.createElement('div');
    avatar.className = 'chat-message-avatar';
    avatar.textContent = '🤖';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'chat-message-content';
    contentDiv.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    
    typingDiv.appendChild(avatar);
    typingDiv.appendChild(contentDiv);
    
    messagesContainer.appendChild(typingDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function removeTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) {
        indicator.remove();
    }
}

// ===== Twitter Sidebar Functions =====

function toggleTwitterSidebar() {
    const sidebar = document.getElementById('twitter-sidebar');
    sidebar.classList.toggle('active');
}

// FAQ Accordion Toggle
function toggleFAQ(element) {
    const faqItem = element.closest('.faq-item');
    const isActive = faqItem.classList.contains('active');
    
    // Close all FAQ items
    document.querySelectorAll('.faq-item').forEach(item => {
        item.classList.remove('active');
    });
    
    // Open clicked item if it wasn't active
    if (!isActive) {
        faqItem.classList.add('active');
    }
}

function changeTwitterFeed() {
    const feedType = document.getElementById('twitter-feed-type').value;
    const input = document.getElementById('twitter-input');
    
    switch(feedType) {
        case 'community':
            input.placeholder = 'Enter community ID...';
            break;
        case 'user':
            input.placeholder = 'Enter username (without @)...';
            break;
    }
}

// Add a Twitter feed to the active feeds list
async function addTwitterFeed() {
    const feedType = document.getElementById('twitter-feed-type').value;
    const input = document.getElementById('twitter-input').value.trim();
    
    if (!input) {
        showToast('Please enter a value', 'warning');
        return;
    }
    
    // Check if feed already exists
    const existingFeed = activeTwitterFeeds.find(f => f.type === feedType && f.value.toLowerCase() === input.toLowerCase());
    if (existingFeed) {
        showToast('Feed already added', 'warning');
        return;
    }
    
    // Add feed to active list
    const displayName = feedType === 'user' ? `@${input}` : input;
    activeTwitterFeeds.push({
        type: feedType,
        value: input,
        displayName: displayName
    });
    
    // Clear input
    document.getElementById('twitter-input').value = '';
    
    // Update UI and load tweets immediately
    updateActiveFeedsList();
    const sidebar = document.getElementById('twitter-sidebar');
    if (sidebar && !sidebar.classList.contains('active')) {
        sidebar.classList.add('active');
    }
    await loadAllTwitterFeeds();
}

// Quick add feed from suggestion chips
async function addFeedQuick(type, value, displayName) {
    // Check if feed already exists
    const existingFeed = activeTwitterFeeds.find(f => f.type === type && f.value.toLowerCase() === value.toLowerCase());
    if (existingFeed) {
        showToast('Feed already added', 'warning');
        return;
    }
    
    activeTwitterFeeds.push({
        type: type,
        value: value,
        displayName: displayName
    });
    
    updateActiveFeedsList();
    const sidebar = document.getElementById('twitter-sidebar');
    if (sidebar && !sidebar.classList.contains('active')) {
        sidebar.classList.add('active');
    }
    await loadAllTwitterFeeds();
}

// Remove a specific feed
function removeFeed(index) {
    activeTwitterFeeds.splice(index, 1);
    updateActiveFeedsList();
    loadAllTwitterFeeds();
}

// Clear all feeds
function clearAllFeeds() {
    activeTwitterFeeds = [];
    updateActiveFeedsList();
    
    const feed = document.getElementById('twitter-feed');
    feed.innerHTML = `
        <div class="twitter-empty">
            <div class="twitter-empty-icon">
                <img src="crypto-icons/X_icon.svg.png" alt="X" class="twitter-empty-logo">
            </div>
            <p>Add feeds to get started</p>
            <p class="twitter-hint">Add multiple communities or users to track</p>
        </div>
    `;
}

// Update the active feeds list UI
function updateActiveFeedsList() {
    const container = document.getElementById('active-feeds-container');
    const list = document.getElementById('active-feeds-list');
    
    if (activeTwitterFeeds.length === 0) {
        container.style.display = 'none';
        return;
    }
    
    container.style.display = 'block';
    list.innerHTML = activeTwitterFeeds.map((feed, index) => `
        <div class="active-feed-item">
            <span class="active-feed-label">
                ${feed.type === 'community' ? '👥' : '👤'} ${feed.displayName}
            </span>
            <button class="active-feed-remove" onclick="removeFeed(${index})" title="Remove">
                ×
            </button>
        </div>
    `).join('');
}
// Load all active Twitter feeds
async function loadAllTwitterFeeds() {
    if (activeTwitterFeeds.length === 0) {
        return;
    }
    
    const feed = document.getElementById('twitter-feed');
    feed.innerHTML = `
        <div class="tweet-loading">
            <div class="spinner"></div>
            <p>Loading tweets from ${activeTwitterFeeds.length} feed(s)...</p>
        </div>
    `;
    
    try {
        let allTweets = [];
        
        // Fetch all feeds in parallel
        const fetchPromises = activeTwitterFeeds.map(async (feedConfig) => {
            try {
                let response;
                
                switch(feedConfig.type) {
                    case 'community':
                        response = await fetch(`${API_BASE_URL}/api/twitter/community/${feedConfig.value}?limit=20`);
                        break;
                    case 'user':
                        response = await fetch(`${API_BASE_URL}/api/twitter/user/${feedConfig.value}`);
                        break;
                }
                
                const data = await response.json();
                
                if (!data.error && data.tweets && Array.isArray(data.tweets)) {
                    // Add source info to each tweet
                    return data.tweets.map(tweet => ({
                        ...tweet,
                        _source: feedConfig.displayName,
                        _sourceType: feedConfig.type
                    }));
                }
                
                return [];
            } catch (error) {
                console.error(`Error loading feed ${feedConfig.displayName}:`, error);
                return [];
            }
        });
        
        const results = await Promise.all(fetchPromises);
        
        // Combine all tweets
        allTweets = results.flat();
        
        if (allTweets.length === 0) {
            feed.innerHTML = `
                <div class="twitter-empty">
                    <div class="twitter-empty-icon">
                        <img src="crypto-icons/X_icon.svg.png" alt="X" class="twitter-empty-logo">
                    </div>
                    <p>No tweets found</p>
                    <p class="twitter-hint">Try adding different feeds</p>
                </div>
            `;
            return;
        }
        
        // Sort tweets by date (newest first)
        allTweets.sort((a, b) => {
            const dateA = new Date(a.createdAt || a.created_at);
            const dateB = new Date(b.createdAt || b.created_at);
            return dateB - dateA;
        });
        
        renderTweets(allTweets);
        showToast(`Loaded ${allTweets.length} tweets from ${activeTwitterFeeds.length} feed(s)`, 'success');
        
    } catch (error) {
        console.error('Error loading tweets:', error);
        feed.innerHTML = `
            <div class="twitter-empty">
                <div class="twitter-empty-icon">
                    <i class='bx bx-error-circle' style="font-size: 64px; color: var(--text-secondary);"></i>
                </div>
                <p>Error loading tweets</p>
                <p class="twitter-hint">${error.message}</p>
            </div>
        `;
        showToast('Failed to load tweets', 'error');
    }
}

function renderTweets(tweets) {
    const feed = document.getElementById('twitter-feed');
    
    feed.innerHTML = tweets.map(tweet => {
        const author = tweet.author || {};
        const text = tweet.text || tweet.full_text || '';
        const createdAt = new Date(tweet.createdAt || tweet.created_at);
        const timeAgo = getTimeAgo(createdAt);
        
        const retweets = tweet.retweetCount || tweet.retweet_count || 0;
        const likes = tweet.likeCount || tweet.favorite_count || 0;
        const replies = tweet.replyCount || tweet.reply_count || 0;
        
        const userInitial = (author.userName || author.screen_name || '?').charAt(0).toUpperCase();
        
        // Show source badge if multiple feeds are active
        const sourceBadge = tweet._source && activeTwitterFeeds.length > 1 ? `
            <span class="tweet-source-badge ${tweet._sourceType === 'community' ? 'community-badge' : 'user-badge'}">
                ${tweet._sourceType === 'community' ? '👥' : '👤'} ${tweet._source}
            </span>
        ` : '';
        
        return `
            <div class="tweet-card">
                ${sourceBadge}
                <div class="tweet-header">
                    <div class="tweet-avatar">${userInitial}</div>
                    <div class="tweet-user-info">
                        <span class="tweet-user-name">${author.userName || author.name || 'Unknown'}</span>
                        <div class="tweet-username">@${author.userName || author.screen_name || 'unknown'}</div>
                    </div>
                    <div class="tweet-date">${timeAgo}</div>
                </div>
                
                <div class="tweet-text">${linkifyText(text)}</div>
                
                <div class="tweet-stats">
                    <div class="tweet-stat">
                        <span>💬</span>
                        <span>${formatNumber(replies)}</span>
                    </div>
                    <div class="tweet-stat">
                        <span>🔄</span>
                        <span>${formatNumber(retweets)}</span>
                    </div>
                    <div class="tweet-stat">
                        <span>❤️</span>
                        <span>${formatNumber(likes)}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Legacy functions removed - now using addFeedQuick instead

function getTimeAgo(date) {
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);
    
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    
    return date.toLocaleDateString();
}

function linkifyText(text) {
    // Convert URLs to links
    text = text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color: var(--primary-cyan);">$1</a>');
    
    // Convert hashtags to styled spans
    text = text.replace(/#(\w+)/g, '<span style="color: var(--primary-cyan);">#$1</span>');
    
    // Convert mentions to styled spans
    text = text.replace(/@(\w+)/g, '<span style="color: var(--primary-cyan);">@$1</span>');
    
    // Convert $ticker to styled spans
    text = text.replace(/\$([A-Z]+)/g, '<span style="color: var(--success);">$$$1</span>');
    
    return text;
}

// ===== Orbital Animation Functions =====
function initOrbitalAnimation() {
    const starsContainer = document.getElementById('stars-background');
    if (!starsContainer) return;
    
    // Generate stars for orbital section (less dense since we have global stars)
    generateStars(starsContainer, 100);
    
    // Create shooting stars periodically for orbital section
    createShootingStars(starsContainer);
}

function generateStars(container, starCount = 150) {
    const containerRect = container.getBoundingClientRect();
    const isGlobal = container.id === 'global-stars-background';
    
    for (let i = 0; i < starCount; i++) {
        const star = document.createElement('div');
        star.className = 'star';
        star.style.position = isGlobal ? 'fixed' : 'absolute';
        const size = Math.random() * 2 + (isGlobal ? 0.5 : 0.5) + 'px';
        star.style.width = size;
        star.style.height = size;
        star.style.borderRadius = '50%';
        star.style.background = 'white';
        star.style.opacity = Math.random() * 0.8 + 0.2;
        star.style.left = Math.random() * 100 + '%';
        star.style.top = Math.random() * 100 + '%';
        star.style.boxShadow = `0 0 ${Math.random() * 4 + 2}px rgba(255, 255, 255, 0.8)`;
        star.style.animation = `starTwinkle ${Math.random() * 3 + 2}s ease-in-out infinite`;
        star.style.animationDelay = Math.random() * 2 + 's';
        container.appendChild(star);
    }
}

function createShootingStars(container) {
    return; // Shooting star animation disabled
}

// ===== AI Token Calls Functions =====

function hideAITokenCallsHeader() {
    const aiCallsHeader = document.getElementById('ai-token-calls-header');
    if (aiCallsHeader) {
        aiCallsHeader.style.display = 'none';
    }
}
async function openAITokenCalls(forceReload = false) {
    if (aiTokenCallsLoading) {
        console.log('⏳ AI Token Calls already loading, skipping duplicate request');
        return;
    }
    
    if (!forceReload && activeDashboard === 'ai-token-calls') {
        console.log('🔁 AI Token Calls already active, skipping reload');
        return;
    }
    
    aiTokenCallsLoading = true;
    activeDashboard = 'ai-token-calls';
    aiTokenCallsSticky = true;
    currentTokenDisplayMode = 'ai-calls';
    // Hide the agent video when opening AI Token Calls
    hideAgentVideo();
    
    // Hide hero elements except search bar
    const hero = document.querySelector('.hero');
    if (hero) {
        const heroTitle = hero.querySelector('.hero-title');
        const heroSubtitle = hero.querySelector('.hero-subtitle');
        const memescopeBtn = hero.querySelector('.btn-primary');
        
        if (heroTitle) heroTitle.style.display = 'none';
        if (heroSubtitle) heroSubtitle.style.display = 'none';
        if (memescopeBtn) memescopeBtn.style.display = 'none';
    }
    
    // Hide all info sections
    document.querySelectorAll('.info-section').forEach(section => {
        section.style.display = 'none';
    });
    
    const tokenFilterBar = document.getElementById('token-filter-bar');
    if (tokenFilterBar) {
        tokenFilterBar.style.display = 'none';
    }
    
    console.log('🤖 Opening AI Token Calls Dashboard...');
    const dashboard = document.getElementById('memescope-dashboard');
    const grid = document.getElementById('tokens-grid');
    const spinner = document.getElementById('loading-spinner');
    const emptyState = document.getElementById('empty-state');
    
    if (!dashboard) {
        console.error('❌ Dashboard element not found!');
        return;
    }
    
    // Show dashboard
    dashboard.style.display = 'block';
    
    // Show refresh button header
    const aiCallsHeader = document.getElementById('ai-token-calls-header');
    if (aiCallsHeader) {
        aiCallsHeader.style.display = 'flex';
    }
    const tokensContentArea = document.querySelector('.tokens-content-area');
    if (tokensContentArea) {
        tokensContentArea.classList.add('ai-token-calls-active');
        tokensContentArea.classList.add('ai-calls-layout');
    }
    
    // Show call history sidebar
    const callHistorySidebar = document.getElementById('ai-call-history-sidebar');
    if (callHistorySidebar) {
        callHistorySidebar.style.display = 'block';
    }
    
    // Update active state in sidebar
    document.querySelectorAll('.blockchain-item').forEach(item => {
        item.classList.remove('active');
    });
    const aiCallsBtn = document.querySelector('.blockchain-item[data-dashboard="ai-token-calls"]');
    if (aiCallsBtn) {
        aiCallsBtn.classList.add('active');
    }
    
    // Show loading spinner
    if (spinner) spinner.style.display = 'block';
    if (grid) grid.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';
    
    try {
        await ensureSubscriptionStatus();
        if (!hasSubscriptionAccess()) {
            const lockReason = determineSubscriptionLockReason();
            renderAiTokenPaywallPreview(lockReason);
            aiTokenCallsLoading = false;
            return;
        }

        setAiTokenPaywallState(false);

        // Fetch AI token calls (current + history)
        const [currentRes, historyRes] = await Promise.all([
            fetch(`${API_BASE_URL}/api/ai-token-calls/current`, {
                credentials: 'include'
            }),
            fetch(`${API_BASE_URL}/api/ai-token-calls/history?limit=50`, {
                credentials: 'include'
            })
        ]);
        
        if (currentRes.status === 401 || historyRes.status === 401) {
            showToast('Please login to view AI token calls.', 'warning');
            renderAiTokenPaywallPreview('login');
            aiTokenCallsLoading = false;
            return;
        }

        if (currentRes.status === 402 || historyRes.status === 402) {
            const lockResponse = currentRes.status === 402 ? currentRes : historyRes;
            const lockData = await lockResponse.json().catch(() => ({}));
            if (lockData?.subscription) {
                currentSubscription = lockData.subscription;
                subscriptionStatusLoaded = true;
            }
            updateNotificationAccess();
            const lockReason = lockData?.error || determineSubscriptionLockReason();
            renderAiTokenPaywallPreview(lockReason);
            aiTokenCallsLoading = false;
            return;
        }

        // Check if responses are OK
        if (!currentRes.ok) {
            const text = await currentRes.text().catch(() => '');
            throw new Error(`Failed to fetch current call: ${currentRes.status} ${currentRes.statusText} ${text ? '- ' + text.substring(0, 120) : ''}`);
        }
        if (!historyRes.ok) {
            const text = await historyRes.text().catch(() => '');
            throw new Error(`Failed to fetch history: ${historyRes.status} ${historyRes.statusText} ${text ? '- ' + text.substring(0, 120) : ''}`);
        }
        
        // Check content type
        const currentContentType = currentRes.headers.get('content-type');
        const historyContentType = historyRes.headers.get('content-type');
        
        if (!currentContentType || !currentContentType.includes('application/json')) {
            const text = await currentRes.text();
            throw new Error(`Expected JSON but got: ${currentContentType}. Response: ${text.substring(0, 100)}`);
        }
        if (!historyContentType || !historyContentType.includes('application/json')) {
            const text = await historyRes.text();
            throw new Error(`Expected JSON but got: ${historyContentType}. Response: ${text.substring(0, 100)}`);
        }
        
        const currentData = await currentRes.json();
        const historyData = await historyRes.json();

        if (currentData?.subscription) {
            currentSubscription = currentData.subscription;
            subscriptionStatusLoaded = true;
        } else if (historyData?.subscription) {
            currentSubscription = historyData.subscription;
            subscriptionStatusLoaded = true;
        }
        updateNotificationAccess();
        
        // Collect all AI token calls (from history, current is included in history)
        const aiCalls = [];
        if (historyData.history && Array.isArray(historyData.history)) {
            aiCalls.push(...historyData.history);
        }
        // Also include current call if it exists and isn't in history
        if (currentData.currentCall) {
            const currentAddress = currentData.currentCall.token?.tokenAddress?.toLowerCase();
            const inHistory = aiCalls.some(call => 
                call.token?.tokenAddress?.toLowerCase() === currentAddress
            );
            if (!inHistory) {
                aiCalls.unshift(currentData.currentCall);
            }
        }
        
        // Convert AI calls to token format
        const tokens = aiCalls
            .map(call => normalizeAiCall(call))
            .filter(Boolean);

        tokens.forEach(token => {
            if (token.notificationId) {
                registerCallForNotifications(token.notificationId, token, notificationCenter.seedComplete);
            }
        });
        
        // Remove duplicates by address while keeping the entry with highest peak performance
        const tokenMap = new Map();
        tokens.forEach(token => {
            if (!token.address) return;
            const key = token.address.toLowerCase();
            const candidatePeak = token.peakPercentSinceCall ?? token.priceChangePercentSinceCall ?? -Infinity;
            if (!tokenMap.has(key)) {
                tokenMap.set(key, token);
            } else {
                const existing = tokenMap.get(key);
                const existingPeak = existing.peakPercentSinceCall ?? existing.priceChangePercentSinceCall ?? -Infinity;
                if (candidatePeak > existingPeak) {
                    tokenMap.set(key, token);
                } else if (candidatePeak === existingPeak) {
                    const existingDate = existing.calledAt ? new Date(existing.calledAt).getTime() : 0;
                    const candidateDate = token.calledAt ? new Date(token.calledAt).getTime() : 0;
                    if (candidateDate > existingDate) {
                        tokenMap.set(key, token);
                    }
                }
            }
        });
        const uniqueTokens = Array.from(tokenMap.values());
        
        console.log(`✓ Found ${uniqueTokens.length} unique AI token calls`);
        
        // Determine ordering: latest call first, then remaining sorted by peak performance
        let latestToken = null;
        if (currentData.currentCall?.token?.tokenAddress) {
            const currentAddress = currentData.currentCall.token.tokenAddress.toLowerCase();
            latestToken = uniqueTokens.find(token => (token.address || '').toLowerCase() === currentAddress) || null;
        }
        if (!latestToken && uniqueTokens.length > 0) {
            latestToken = uniqueTokens
                .slice()
                .sort((a, b) => {
                    const dateA = a.calledAt ? new Date(a.calledAt).getTime() : 0;
                    const dateB = b.calledAt ? new Date(b.calledAt).getTime() : 0;
                    return dateB - dateA;
                })[0];
        }
        
        const remainingTokens = uniqueTokens.filter(token => {
            if (!latestToken || !latestToken.address) return true;
            return (token.address || '').toLowerCase() !== latestToken.address.toLowerCase();
        });
        
        remainingTokens.sort((a, b) => {
            const peakA = a.peakPercentSinceCall ?? a.priceChangePercentSinceCall ?? -Infinity;
            const peakB = b.peakPercentSinceCall ?? b.priceChangePercentSinceCall ?? -Infinity;
            return peakB - peakA;
        });
        
        const orderedTokens = latestToken ? [latestToken, ...remainingTokens] : remainingTokens;
        const tradingSummary = computeAiTradingPerformance(uniqueTokens);
        
        // Store in allTokens for consistency
        allTokens = orderedTokens;
        if (!notificationCenter.seedComplete) {
            notificationCenter.seedComplete = true;
        }
        
        // Display tokens - use call history cards for AI calls
        if (orderedTokens.length > 0) {
            displayAICallHistory(orderedTokens, tradingSummary);
            if (spinner) spinner.style.display = 'none';
            if (grid) grid.style.display = 'grid';
            
        // Load and display call history sidebar
        loadAICallHistorySidebar();
        } else {
            // Hide call history sidebar if no tokens
            const callHistorySidebar = document.getElementById('ai-call-history-sidebar');
            if (callHistorySidebar) {
                callHistorySidebar.style.display = 'none';
            }
            if (spinner) spinner.style.display = 'none';
            if (grid) grid.style.display = 'none';
            if (emptyState) emptyState.style.display = 'block';
        }
    } catch (error) {
        console.error('Error loading AI token calls:', error);
        showToast('Failed to load AI token calls', 'error');
        if (spinner) spinner.style.display = 'none';
        if (emptyState) {
            emptyState.style.display = 'block';
            emptyState.innerHTML = `
                <div class="empty-icon"><i class='bx bx-error-circle'></i></div>
                <h3>Error loading AI token calls</h3>
                <p>Please try refreshing</p>
            `;
        }
    } finally {
        aiTokenCallsLoading = false;
    }
}

// Refresh AI Token Calls
async function refreshAITokenCalls() {
    console.log('🔄 Refreshing AI Token Calls (data only)...');
    const refreshBtn = document.querySelector('.btn-refresh-ai-calls');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.innerHTML = '<i class=\'bx bx-loader-alt bx-spin\'></i> Refreshing...';
    }

    try {
        showToast('Refreshing AI token data...', 'info');
        await openAITokenCalls(true);
        showToast('AI token data refreshed', 'success');
    } catch (error) {
        console.error('Error refreshing AI token calls:', error);
        showToast('Failed to refresh AI token calls', 'error');
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = '<i class=\'bx bx-refresh\'></i> Refresh';
        }
    }
}

// ===== Display AI Call History =====
function displayAICallHistory(tokens, summary) {
    const grid = document.getElementById('tokens-grid');
    if (!grid) {
        console.error('❌ Tokens grid not found!');
        return;
    }
    
    // Clear existing cards
    grid.innerHTML = '';
    
    console.log(`📊 Displaying ${tokens.length} AI call history cards`);
    
    // Show all active calls, take-profit calls (>=2x peak), and the two most recent stop-loss calls (<2x peak)
    const activeTokens = tokens.filter(token => ((token.status || '').toLowerCase() !== 'stop_loss_triggered') && !token.takeProfitAchieved);
    const takeProfitTokens = tokens.filter(token => token.takeProfitAchieved);
    const stopLossTokens = tokens
        .filter(token => (token.status || '').toLowerCase() === 'stop_loss_triggered' && !token.takeProfitAchieved)
        .sort((a, b) => {
            const dateA = a.stopLossTriggeredAt ? new Date(a.stopLossTriggeredAt).getTime() : (a.calledAt ? new Date(a.calledAt).getTime() : 0);
            const dateB = b.stopLossTriggeredAt ? new Date(b.stopLossTriggeredAt).getTime() : (b.calledAt ? new Date(b.calledAt).getTime() : 0);
            return dateB - dateA;
        })
        .slice(0, 2);
    
    const tokensToRender = [...activeTokens, ...takeProfitTokens, ...stopLossTokens];
    
    if (summary) {
        const summaryCard = createAiCallPerformanceSummaryCard(summary, tokens.slice(0, 3));
        if (summaryCard) {
            grid.appendChild(summaryCard);
        }
    }
    
    // Create call history cards
    tokensToRender.forEach((token) => {
        const card = createAICallHistoryCard(token);
        grid.appendChild(card);
    });
    
    console.log(`✓ All ${tokensToRender.length} call history cards added to grid`);
}

// ===== Create AI Call History Card =====
function createAICallHistoryCard(token) {
    const card = document.createElement('div');
    card.className = 'ai-call-history-card';
    if (token.address) {
        card.dataset.tokenAddress = (token.address || '').toLowerCase();
    }
    if (token.takeProfitAchieved) {
        card.classList.add('ai-call-history-card-profit');
    } else if ((token.status || '').toLowerCase() === 'stop_loss_triggered') {
        card.classList.add('ai-call-history-card-stopped');
    }
    
    // Get crypto icon URL
    const cryptoIconUrl = getCryptoIconUrl(token.symbol, token.logo);
    const symbolInitial = token.symbol ? token.symbol.charAt(0) : '?';
    const logo = cryptoIconUrl 
        ? `<img src="${cryptoIconUrl}" alt="${token.name}" class="call-history-logo-img" onerror="this.onerror=null; this.parentElement.innerHTML='${symbolInitial}'">`
        : token.logo 
            ? `<img src="${token.logo}" alt="${token.name}" class="call-history-logo-img" onerror="this.onerror=null; this.parentElement.innerHTML='${symbolInitial}'">`
            : `<span class="call-history-logo-fallback">${symbolInitial}</span>`;
    
    // Format dates
    const calledDate = token.calledAt ? new Date(token.calledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A';
    const calledTime = token.calledAt ? new Date(token.calledAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    const stopLossTime = token.stopLossTriggeredAt ? new Date(token.stopLossTriggeredAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    const peakTime = token.peakTimestamp ? new Date(token.peakTimestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    
    // Performance metrics
    let performanceBadge = '';
    const peakMultiplier = token.peakMultiplierSinceCall ?? token.multiplierSinceCall ?? null;
    const peakPercent = token.peakPercentSinceCall ?? token.priceChangePercentSinceCall ?? null;
    const currentMultiplier = token.multiplierSinceCall ?? null;
    const currentPercent = token.priceChangePercentSinceCall ?? null;
    const hasPeak = peakMultiplier !== null && peakPercent !== null;
    const hasCurrent = currentMultiplier !== null && currentPercent !== null;
    let displayMultiplier = hasPeak ? peakMultiplier : currentMultiplier;
    let displayPercent = hasPeak ? peakPercent : currentPercent;
    
    if (displayMultiplier !== null && displayPercent !== null) {
        let performanceClass = displayPercent >= 0 ? 'call-performance-positive' : 'call-performance-negative';
        let badgeLabel = 'Peak Performance';
        let peakSubtitle = 'Best Recorded';
        
        let secondaryPerformance = '';
        if (token.takeProfitAchieved) {
            performanceClass = 'call-performance-positive';
            badgeLabel = 'Take Profit Hit';
            peakSubtitle = 'Target Achieved';
            if (hasCurrent && (currentPercent !== displayPercent || currentMultiplier !== displayMultiplier)) {
                secondaryPerformance = `
                <div class="call-performance-secondary">
                    <span class="call-performance-secondary-label">Current</span>
                    <span class="call-performance-secondary-values">${currentMultiplier.toFixed(2)}x · ${currentPercent >= 0 ? '+' : ''}${currentPercent.toFixed(2)}%</span>
                </div>
            `;
            }
        } else if ((token.status || '').toLowerCase() === 'stop_loss_triggered') {
            if (hasCurrent) {
                displayMultiplier = currentMultiplier;
                displayPercent = currentPercent;
                performanceClass = displayPercent >= 0 ? 'call-performance-positive' : 'call-performance-negative';
            }
            badgeLabel = 'Trade Result';
            peakSubtitle = 'Closed at Stop Loss';
            if (hasPeak && (peakPercent !== displayPercent || peakMultiplier !== displayMultiplier)) {
                secondaryPerformance = `
                <div class="call-performance-secondary">
                    <span class="call-performance-secondary-label">Peak</span>
                    <span class="call-performance-secondary-values">${peakMultiplier.toFixed(2)}x · ${peakPercent >= 0 ? '+' : ''}${peakPercent.toFixed(2)}%</span>
                </div>
            `;
            }
        } else if (hasCurrent && (currentPercent !== displayPercent || currentMultiplier !== displayMultiplier)) {
            secondaryPerformance = `
                <div class="call-performance-secondary">
                    <span class="call-performance-secondary-label">Current</span>
                    <span class="call-performance-secondary-values">${currentMultiplier.toFixed(2)}x · ${currentPercent >= 0 ? '+' : ''}${currentPercent.toFixed(2)}%</span>
                </div>
            `;
        }
        
        performanceBadge = `
            <div class="call-performance-badge ${performanceClass}">
                <div class="call-performance-header">
                    <span class="call-performance-label">${badgeLabel}</span>
                </div>
                <div class="call-performance-content">
                    <div class="call-performance-multiplier">${displayMultiplier.toFixed(2)}x</div>
                    <div class="call-performance-percent">${displayPercent >= 0 ? '+' : ''}${displayPercent.toFixed(2)}%</div>
                </div>
                <div class="call-performance-subtitle">${peakSubtitle}</div>
                ${secondaryPerformance}
            </div>
        `;
    }
    
    let statusBadge = '';
    if (token.takeProfitAchieved) {
        const takeProfitDetails = peakTime ? ` · ${peakTime}` : '';
        statusBadge = `
            <div class="call-status-badge take-profit">
                <i class='bx bx-trophy'></i>
                <div class="call-status-text">
                    <span class="call-status-title">Take Profit Achieved</span>
                    <span class="call-status-subtitle">${peakMultiplier ? peakMultiplier.toFixed(2) + 'x' : '2.00x+'}${takeProfitDetails}</span>
                </div>
            </div>
        `;
    } else if ((token.status || '').toLowerCase() === 'stop_loss_triggered') {
        const stopPercent = token.stopLossPercent !== null ? token.stopLossPercent.toFixed(2) : AI_STOP_LOSS_THRESHOLD_PERCENT.toFixed(0);
        const stopDetails = stopLossTime ? ` · ${stopLossTime}` : '';
        statusBadge = `
            <div class="call-status-badge stop-loss">
                <i class='bx bx-shield-x'></i>
                <div class="call-status-text">
                    <span class="call-status-title">Stop Loss Triggered</span>
                    <span class="call-status-subtitle">${stopPercent}%${stopDetails}</span>
                </div>
            </div>
        `;
    } else {
        statusBadge = `
            <div class="call-status-badge active">
                <i class='bx bx-pulse'></i>
                <span class="call-status-title">Active AI Call</span>
            </div>
        `;
    }
    
    // Contract address with copy button
    const contractAddress = token.address || 'N/A';
    const shortAddress = contractAddress !== 'N/A' ? `${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}` : 'N/A';
    
    const callHistoryActions = (token.status || '').toLowerCase() === 'stop_loss_triggered' && !token.takeProfitAchieved
        ? `
            <div class="call-history-note stop-loss-note">
                <i class='bx bx-shield-x'></i>
                <span>Trade closed at stop loss. Monitoring for new opportunities.</span>
            </div>
        `
        : token.takeProfitAchieved
        ? `
            <div class="call-history-note take-profit-note">
                <i class='bx bx-rocket'></i>
                <span>Take profit target reached. Watching for re-entry conditions.</span>
            </div>
        `
        : `
            <div class="call-history-actions">
                <button class="btn-analyze" onclick='event.stopPropagation(); analyzeToken(${JSON.stringify(token).replace(/'/g, "&#39;")})'>
                    <span class="btn-analyze-text">AI Analysis (1 CU)</span>
                </button>
                <button class="btn-add-watchlist" onclick='event.stopPropagation(); quickAddToWatchlist("${token.chain}", "${token.address}", ${JSON.stringify(token).replace(/'/g, "&#39;")})' title="Add to Watchlist">
                    <i class='bx bxs-star'></i> Watchlist
                </button>
            </div>
        `;
    
    card.innerHTML = `
        <div class="call-history-header">
            <div class="call-history-logo">${logo}</div>
            <div class="call-history-info">
                <div class="call-history-name">${token.name || 'Unknown Token'}</div>
                <div class="call-history-symbol">${token.symbol || 'N/A'}</div>
            </div>
            <div class="call-history-chain-badge">
                <i class='bx bx-equal'></i> Solana
            </div>
        </div>
        
        ${statusBadge}
        ${performanceBadge}
        
        <div class="call-history-stats">
            <div class="call-history-stat">
                <div class="call-history-stat-label">PRICE</div>
                <div class="call-history-stat-value">$${formatNumber(token.price)}</div>
            </div>
            <div class="call-history-stat">
                <div class="call-history-stat-label">24H CHANGE</div>
                <div class="call-history-stat-value ${token.priceChange24h >= 0 ? 'positive' : 'negative'}">
                    ${token.priceChange24h !== null ? (token.priceChange24h >= 0 ? '+' : '') + token.priceChange24h.toFixed(2) + '%' : '+0.00%'}
                </div>
            </div>
        </div>
        
        <div class="call-history-details">
            <div class="call-history-detail-row">
                <span class="call-history-detail-label">Market Cap</span>
                <span class="call-history-detail-value">$${formatNumber(token.marketCap)}</span>
            </div>
            <div class="call-history-detail-row">
                <span class="call-history-detail-label">Holders</span>
                <span class="call-history-detail-value">${formatWholeNumber(token.holders || 0)}</span>
            </div>
            <div class="call-history-detail-row">
                <span class="call-history-detail-label">Launchpad</span>
                <span class="call-history-detail-value">
                    <img src="pumpfun-logo.png" alt="Pump.fun" class="launchpad-logo-small"> Pump.fun
                </span>
            </div>
            <div class="call-history-detail-row">
                <span class="call-history-detail-label">Called</span>
                <span class="call-history-detail-value">${calledDate} ${calledTime}</span>
            </div>
            <div class="call-history-detail-row call-history-contract-row">
                <span class="call-history-detail-label">Contract</span>
                <div class="call-history-contract-value">
                    <span class="contract-address">${shortAddress}</span>
                    <button class="copy-contract-btn" onclick="event.stopPropagation(); copyContractAddress('${contractAddress}')" title="Copy full address">
                        <i class='bx bx-copy'></i>
                    </button>
                </div>
            </div>
        </div>
        
        ${callHistoryActions}
    `;
    
    return card;
}
function computeAiTradingPerformance(tokens = []) {
    const validTokens = (tokens || []).filter(Boolean);
    const total = validTokens.length;
    if (total === 0) {
        return null;
    }
    
    let wins = 0;
    let losses = 0;
    let stopLosses = 0;
    let peakSum = 0;
    let bestPeak = -Infinity;
    let bestToken = null;
    
    validTokens.forEach(token => {
        const rawPeak = token.peakPercentSinceCall ?? token.priceChangePercentSinceCall ?? 0;
        const peakPercent = Number.isFinite(Number(rawPeak)) ? Number(rawPeak) : 0;
        const rawStatus = token.status || (token.stopLossTriggered ? 'stop_loss_triggered' : null);
        const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
        const isStopLoss = status === 'stop_loss_triggered' || status === 'stop-loss' || status === 'stop_loss';
        
        if (isStopLoss) {
            stopLosses += 1;
            losses += 1;
        } else if (peakPercent > 0) {
            wins += 1;
        } else if (peakPercent < 0) {
            losses += 1;
        }
        
        peakSum += peakPercent;
        
        if (peakPercent > bestPeak) {
            bestPeak = peakPercent;
            bestToken = token;
        }
    });
    
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    const avgPeak = total > 0 ? peakSum / total : 0;
    
    return {
        total,
        wins,
        losses,
        stopLosses,
        winRate,
        avgPeak,
        bestPeak,
        bestTokenName: bestToken?.name || null,
        bestTokenSymbol: bestToken?.symbol || null
    };
}

function createAiCallPerformanceSummaryCard(summary, previewTokens = []) {
    if (!summary || !summary.total) {
        return null;
    }
    
    const card = document.createElement('div');
    card.className = 'ai-call-performance-card';
    
    const winRateDisplay = summary.winRate.toFixed(0);
    const avgPeakDisplay = `${summary.avgPeak >= 0 ? '+' : ''}${summary.avgPeak.toFixed(1)}%`;
    const bestPeakDisplay = summary.bestPeak !== undefined && summary.bestPeak !== null
        ? `${summary.bestPeak >= 0 ? '+' : ''}${summary.bestPeak.toFixed(2)}%`
        : null;
    
    const previewItems = (previewTokens || []).filter(Boolean).slice(0, 3);
    const previewHtml = previewItems.length ? `
        <div class="performance-call-preview">
            <div class="performance-call-preview-header">Recent AI Calls</div>
            ${previewItems.map((token, index) => {
                const peakRaw = token.peakPercentSinceCall ?? token.priceChangePercentSinceCall ?? 0;
                const peakPercent = Number.isFinite(Number(peakRaw)) ? Number(peakRaw) : 0;
                const multiplierRaw = token.peakMultiplierSinceCall ?? token.multiplierSinceCall ?? null;
                const multiplier = Number.isFinite(Number(multiplierRaw)) ? Number(multiplierRaw) : null;
                const rawStatus = token.status || (token.stopLossTriggered ? 'stop_loss_triggered' : null);
                const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : 'active';
                const takeProfitAchieved = Boolean(token.takeProfitAchieved) ||
                    (Number.isFinite(multiplier) && multiplier >= 2) ||
                    (Number.isFinite(peakPercent) && peakPercent >= 100);
                const isStopLoss = !takeProfitAchieved && (status === 'stop_loss_triggered' || status === 'stop-loss' || status === 'stop_loss');
                const statusLabel = takeProfitAchieved
                    ? 'Take Profit'
                    : isStopLoss
                        ? 'Stop Loss'
                        : status === 'active'
                            ? 'Active'
                            : status.replace(/_/g, ' ');
                const statusClass = takeProfitAchieved ? 'take-profit' : isStopLoss ? 'stop-loss' : 'active';
                const changeClass = peakPercent >= 0 ? 'positive' : 'negative';
                const dateText = token.calledAt ? new Date(token.calledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                return `
                    <div class="performance-call-item">
                        <div class="performance-call-meta">
                            <span class="performance-call-rank">#${index + 1}</span>
                            <div class="performance-call-name-group">
                                <span class="performance-call-name">${token.name || 'Unknown'}</span>
                                <span class="performance-call-symbol">${token.symbol || ''}${dateText ? ' · ' + dateText : ''}</span>
                            </div>
                        </div>
                        <div class="performance-call-metrics">
                            ${multiplier ? `<span class="performance-call-multiplier">${multiplier.toFixed(2)}x</span>` : ''}
                            <span class="performance-call-change ${changeClass}">${peakPercent >= 0 ? '+' : ''}${peakPercent.toFixed(2)}%</span>
                            <span class="performance-call-status ${statusClass}">${statusLabel}</span>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    ` : '';
    
    card.innerHTML = `
        <div class="performance-card-header">
            <div class="performance-card-title">Trading Performance</div>
            <div class="performance-card-winrate">${winRateDisplay}% win rate</div>
        </div>
        <div class="performance-card-metrics">
            <div class="performance-card-metric">
                <span class="metric-label">Total Calls</span>
                <span class="metric-value">${summary.total}</span>
            </div>
            <div class="performance-card-metric">
                <span class="metric-label">Wins</span>
                <span class="metric-value positive">${summary.wins}</span>
            </div>
            <div class="performance-card-metric">
                <span class="metric-label">Stop Loss</span>
                <span class="metric-value negative">${summary.stopLosses}</span>
            </div>
            <div class="performance-card-metric">
                <span class="metric-label">Avg Peak</span>
                <span class="metric-value">${avgPeakDisplay}</span>
            </div>
        </div>
        ${bestPeakDisplay ? `
            <div class="performance-card-footer">
                Top call: <strong>${summary.bestTokenName || summary.bestTokenSymbol || 'Unknown'}</strong>
                <span class="performance-card-footer-value">${bestPeakDisplay}</span>
            </div>
        ` : ''}
        ${previewHtml}
    `;
    
    return card;
}

function createAiCallPerformanceSidebar(summary) {
    if (!summary || !summary.total) {
        return '';
    }
    
    const winRateDisplay = summary.winRate.toFixed(0);
    const avgPeakDisplay = `${summary.avgPeak >= 0 ? '+' : ''}${summary.avgPeak.toFixed(1)}%`;
    const bestPeakDisplay = summary.bestPeak !== undefined && summary.bestPeak !== null
        ? `${summary.bestPeak >= 0 ? '+' : ''}${summary.bestPeak.toFixed(2)}%`
        : null;
    
    return `
        <div class="call-history-performance">
            <div class="call-history-performance-header">
                <span>Trading Performance</span>
                <span class="call-history-performance-winrate">${winRateDisplay}% win rate</span>
            </div>
            <div class="call-history-performance-metrics">
                <div class="performance-pill">
                    <span>Total</span>
                    <strong>${summary.total}</strong>
                </div>
                <div class="performance-pill positive">
                    <span>Wins</span>
                    <strong>${summary.wins}</strong>
                </div>
                <div class="performance-pill negative">
                    <span>Stop Loss</span>
                    <strong>${summary.stopLosses}</strong>
                </div>
                <div class="performance-pill">
                    <span>Avg Peak</span>
                    <strong>${avgPeakDisplay}</strong>
                </div>
            </div>
            ${bestPeakDisplay ? `
                <div class="call-history-performance-footer">
                    Top call: <strong>${summary.bestTokenName || summary.bestTokenSymbol || 'Unknown'}</strong>
                    <span class="call-history-performance-best">${bestPeakDisplay}</span>
                </div>
            ` : ''}
        </div>
    `;
}

// ===== Copy Contract Address =====
function copyContractAddress(address) {
    if (!address || address === 'N/A') {
        showToast('No contract address available', 'error');
        return;
    }
    
    navigator.clipboard.writeText(address).then(() => {
        showToast('Contract address copied to clipboard!', 'success');
    }).catch(err => {
        console.error('Failed to copy:', err);
        // Fallback: select text
        const textArea = document.createElement('textarea');
        textArea.value = address;
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            showToast('Contract address copied!', 'success');
        } catch (e) {
            showToast('Failed to copy address', 'error');
        }
        document.body.removeChild(textArea);
    });
}
// ===== Load AI Call History Sidebar =====
async function loadAICallHistorySidebar() {
    const callHistoryList = document.getElementById('call-history-list');
    if (!callHistoryList) return;
    if (!hasSubscriptionAccess()) {
        callHistoryList.innerHTML = `
            <div class="call-history-locked">
                <i class='bx bx-lock-alt'></i>
                <p>Subscribe to unlock live AI call history.</p>
            </div>
        `;
        return;
    }
    
    callHistoryList.innerHTML = `
        <div class="call-history-loading">
            <div class="spinner-small"></div>
            <span>Loading call history...</span>
        </div>
    `;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/ai-token-calls/history?limit=10`); // Get top 10 by performance
        if (response.status === 401) {
            callHistoryList.innerHTML = `
                <div class="call-history-locked">
                    <i class='bx bx-lock-alt'></i>
                    <p>Login to unlock AI call history.</p>
                </div>
            `;
            return;
        }
        if (response.status === 402) {
            const lockData = await response.json().catch(() => ({}));
            if (lockData?.subscription) {
                currentSubscription = lockData.subscription;
                subscriptionStatusLoaded = true;
                updateNotificationAccess();
            }
            renderAiTokenPaywallPreview(lockData?.error || 'subscription_required');
            return;
        }
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            throw new Error('Expected JSON but got: ' + contentType);
        }
        
        const data = await response.json();
        let calls = data.history || [];
        
        // Additional deduplication on frontend (safety measure)
        const tokenMap = new Map();
        calls.forEach(call => {
            const token = call.token || {};
            const tokenAddress = token.tokenAddress?.toLowerCase();
            if (!tokenAddress) return;
            
            const peakPercent = token.peakPercentSinceCall || token.priceChangePercentSinceCall || -Infinity;
            
            if (!tokenMap.has(tokenAddress)) {
                tokenMap.set(tokenAddress, call);
            } else {
                const existingCall = tokenMap.get(tokenAddress);
                const existingPeakPercent = existingCall.token.peakPercentSinceCall || existingCall.token.priceChangePercentSinceCall || -Infinity;
                if (peakPercent > existingPeakPercent) {
                    tokenMap.set(tokenAddress, call);
                }
            }
        });
        
        // Convert to array and sort by peak performance (highest first)
        calls = Array.from(tokenMap.values()).sort((a, b) => {
            const peakA = a.token.peakPercentSinceCall || a.token.priceChangePercentSinceCall || -Infinity;
            const peakB = b.token.peakPercentSinceCall || b.token.priceChangePercentSinceCall || -Infinity;
            return peakB - peakA; // Sort descending
        }).slice(0, 10); // Limit to 10
        
        if (calls.length === 0) {
            callHistoryList.innerHTML = `
                <div class="call-history-empty">
                    <i class='bx bx-info-circle'></i>
                    <p>No call history yet</p>
                </div>
            `;
            return;
        }

        const sidebarSummary = computeAiTradingPerformance(calls.map(call => {
            const token = call.token || {};
            return {
                name: token.name,
                symbol: token.symbol,
                peakPercentSinceCall: token.peakPercentSinceCall ?? token.priceChangePercentSinceCall ?? 0,
                priceChangePercentSinceCall: token.priceChangePercentSinceCall ?? 0,
                status: call.status || (token.stopLossTriggered ? 'stop_loss_triggered' : 'active'),
                stopLossTriggered: token.stopLossTriggered
            };
        }));
        
        // Display deduplicated calls
        const summaryHtml = createAiCallPerformanceSidebar(sidebarSummary);
        const historyHtml = calls.map((call, index) => {
            const token = call.token || {};
            const tokenAddress = token.tokenAddress || 'N/A';
            const shortAddress = tokenAddress !== 'N/A' ? `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}` : 'N/A';
            const calledDate = call.calledAt || call.timestamp ? new Date(call.calledAt || call.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'N/A';
            
            // Use peak performance (highest achieved) instead of current
            const multiplier = token.peakMultiplierSinceCall || token.multiplierSinceCall || null;
            const percentChange = token.peakPercentSinceCall || token.priceChangePercentSinceCall || null;
            const performanceClass = percentChange !== null && percentChange >= 0 ? 'history-performance-positive' : 'history-performance-negative';
            const status = call.status || (token.stopLossTriggered ? 'stop_loss_triggered' : 'active');
            const multiplierNum = Number.isFinite(Number(multiplier)) ? Number(multiplier) : null;
            const percentNum = Number.isFinite(Number(percentChange)) ? Number(percentChange) : null;
            const takeProfitAchieved = Boolean(token.takeProfitAchieved) ||
                (multiplierNum !== null && multiplierNum >= 2) ||
                (percentNum !== null && percentNum >= 100);
            let statusBadge = '';
            if (takeProfitAchieved) {
                statusBadge = `<span class="call-history-item-status take-profit">TAKE PROFIT</span>`;
            } else if ((status || '').toLowerCase() === 'stop_loss_triggered' || (token.stopLossTriggered && !takeProfitAchieved)) {
                statusBadge = `<span class="call-history-item-status stop-loss">STOP LOSS</span>`;
            }
            
            // Get token logo
            const cryptoIconUrl = getCryptoIconUrl(token.symbol, token.logo);
            const sidebarSymbolInitial = token.symbol ? token.symbol.charAt(0) : '?';
            const logo = cryptoIconUrl 
                ? `<img src="${cryptoIconUrl}" alt="${token.name}" class="call-history-item-logo" onerror="this.onerror=null; this.parentElement.innerHTML='${sidebarSymbolInitial}'">`
                : token.logo 
                    ? `<img src="${token.logo}" alt="${token.name}" class="call-history-item-logo" onerror="this.onerror=null; this.parentElement.innerHTML='${sidebarSymbolInitial}'">`
                    : `<span class="call-history-item-logo-fallback">${sidebarSymbolInitial}</span>`;
            
            return `
                <div class="call-history-item" onclick="event.stopPropagation(); copyContractAddress('${tokenAddress}')">
                    <div class="call-history-item-header">
                        <div class="call-history-item-logo-container">
                            ${logo}
                        </div>
                        <div class="call-history-item-name">
                            <strong>${token.name || 'Unknown'}</strong>
                            <span class="call-history-item-symbol">${token.symbol || 'N/A'}</span>
                        </div>
                        <div class="call-history-item-date">
                            ${calledDate}
                        </div>
                    </div>
                    <div class="call-history-item-details">
                        <div class="call-history-item-contract">
                            <i class='bx bx-copy'></i>
                            <span>${shortAddress}</span>
                        </div>
                        ${multiplier !== null && percentChange !== null ? `
                            <div class="call-history-item-performance ${performanceClass}">
                                <span class="history-multiplier">${multiplier.toFixed(2)}x</span>
                                <span class="history-percent">${percentChange >= 0 ? '+' : ''}${percentChange.toFixed(2)}%</span>
                            </div>
                        ` : '<div class="call-history-item-performance"><span>Loading...</span></div>'}
                        ${statusBadge}
                    </div>
                </div>
            `;
        }).join('');

        callHistoryList.innerHTML = `${summaryHtml}${historyHtml}`;
        
    } catch (error) {
        console.error('Error loading call history:', error);
        callHistoryList.innerHTML = `
            <div class="call-history-error">
                <i class='bx bx-error-circle'></i>
                <p>Error loading history</p>
            </div>
        `;
    }
}

async function triggerAITokenScan() {
    try {
        showToast('Triggering AI scan...', 'info');
        
        const response = await fetch(`${API_BASE_URL}/api/ai-token-calls/scan`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('New AI token call found!', 'success');
            await openAITokenCalls(); // Reload to show new call
        } else {
            showToast(data.message || 'No suitable token found', 'warning');
        }
    } catch (error) {
        console.error('Error triggering scan:', error);
        showToast('Error triggering scan: ' + error.message, 'error');
    }
}

function closeAITokenCalls() {
    // This is now handled by the dashboard, but keeping for compatibility
    const modal = document.getElementById('ai-token-calls-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

// Old modal functions removed - now using dashboard view
