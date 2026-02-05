// background.js

const CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// In-memory queue
let queryQueue = [];

let currentTask = null; // The task currently being processed
let lastError = null; // Store the last error that occurred during processing

function calculateRating(reviews) {
    if (!reviews || reviews.length === 0) return null;
    const sum = reviews.reduce((acc, r) => acc + (r.rating || 0), 0);
    return sum / reviews.length;
}

// Helper: Determine badge from avg rating
async function updateBadgeForRating(tabId, reviews) {
    if (!tabId) {
        console.error("updateBadgeForRating called without tabId");
        return;
    }
    if (!reviews || reviews.length === 0) {
        // Clear badge if no data
        await chrome.action.setBadgeText({ text: "", tabId }).catch(() => { });
        return;
    }

    const rating = calculateRating(reviews);
    let text = "∓";
    let color = "#FFEE58"; // Yellow-ish

    if (rating >= 4) {
        text = "👍";
        color = "#66BB6A"; // Green
    } else if (rating <= 2.5) {
        text = "👎";
        color = "#EF5350"; // Red
    }

    try {
        await chrome.action.setBadgeTextColor({ color: "#000000", tabId });
        await chrome.action.setBadgeText({ text: text, tabId });
        await chrome.action.setBadgeBackgroundColor({ color: color, tabId });
    } catch (e) {
        // Tab likely closed
    }
}

// ---------------------------------------------------------
// Helper: Source Logic
// ---------------------------------------------------------

function migrateSources(sources) {
    if (!sources || sources.length === 0) return [];
    if (typeof sources[0] === 'string') {
        return sources.map(s => ({
            domain: s,
            state: 'on',
            visits: 0
        }));
    }
    return sources;
}

function getActiveSources(sourcesRaw, maxProviders) {
    const sources = migrateSources(sourcesRaw);

    // Sort logic: On, Auto, Off. Within group: Visits desc.
    const stateOrder = { 'on': 0, 'auto': 1, 'off': 2 };
    const sorted = [...sources].sort((a, b) => {
        if (stateOrder[a.state] !== stateOrder[b.state]) {
            return stateOrder[a.state] - stateOrder[b.state];
        }
        return (b.visits || 0) - (a.visits || 0);
    });

    const activeDomains = [];
    const onSources = sorted.filter(s => s.state === 'on');
    const autoSources = sorted.filter(s => s.state === 'auto');

    // Add all 'on' sources
    onSources.forEach(s => activeDomains.push(s.domain));

    // Add 'auto' sources up to limit
    const remainingSlots = Math.max(0, maxProviders - onSources.length);
    const activeAuto = autoSources.slice(0, remainingSlots);
    activeAuto.forEach(s => activeDomains.push(s.domain));

    return activeDomains;
}

// ---------------------------------------------------------
// Cache Logic
// ---------------------------------------------------------

async function getFromCache(hostname) {
    const key = `cache_${hostname}`;
    const data = await chrome.storage.local.get(key);
    const entry = data[key];

    if (!entry) return null;

    // Check settings version match
    const { lastSettingsChange } = await chrome.storage.sync.get(['lastSettingsChange']);
    const globalSettingsTs = lastSettingsChange || 0;

    const age = Date.now() - entry.timestamp;
    if (age > CACHE_EXPIRE_MS) {
        chrome.storage.local.remove(key); // Expired
        return null;
    }

    // Mark stale if settings have changed since this entry was created
    // (Entry timestamp is creation time. If creation < lastSettingsChange, it's stale)
    const settingsStale = entry.timestamp < globalSettingsTs;

    // Return entry even if stale (callers can decide to refresh)
    entry.isStale = (age > CACHE_STALE_MS) || settingsStale;
    return entry;
}

async function saveToCache(hostname, reviews, isSource, groundingMetadata) {
    const key = `cache_${hostname}`;
    const entry = {
        hostname: hostname,
        timestamp: Date.now(),
        reviews: reviews,
        isSource: isSource,
        groundingMetadata: groundingMetadata
    };
    await chrome.storage.local.set({ [key]: entry });
    return entry;
}

async function pruneCache() {
    const allData = await chrome.storage.local.get(null);
    const now = Date.now();
    const keysToRemove = [];

    for (const [key, value] of Object.entries(allData)) {
        if (key.startsWith('cache_') && value.timestamp) {
            if (now - value.timestamp > CACHE_EXPIRE_MS) {
                keysToRemove.push(key);
            }
        }
    }

    if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
    }
}

// ---------------------------------------------------------
// Queue & Processing Logic
// ---------------------------------------------------------

function addToQueue(hostname, forceRefresh = false, tabId = null) {
    const existingIndex = queryQueue.findIndex(item => item.hostname === hostname);

    // Check if it's already in the queue
    if (existingIndex !== -1) {
        if (forceRefresh) queryQueue[existingIndex].forceRefresh = true;
        if (tabId) queryQueue[existingIndex].tabId = tabId;
        return;
    }

    // Check if it's currently being processed
    if (currentTask && currentTask.hostname === hostname) {
        if (tabId) currentTask.tabId = tabId;
        return;
    }

    queryQueue.push({ hostname, forceRefresh, tabId });
    if (!currentTask) processQueue();
    broadcastStatus(); // Notify popup
}

async function processQueue() {
    if (!currentTask && queryQueue.length === 0) return;

    if (!currentTask) {
        currentTask = queryQueue.shift();
    }
    broadcastStatus();

    try {
        if (!currentTask.forceRefresh) {
            const cached = await getFromCache(currentTask.hostname);
            if (cached && !cached.isStale) {
                await updateBadgeForRating(currentTask.tabId, cached.reviews);
                currentTask = null;
                processQueue();
                return;
            }
        }

        await performGeminiQuery(currentTask.hostname);

        const freshData = await getFromCache(currentTask.hostname);
        if (freshData) {
            await updateBadgeForRating(currentTask.tabId, freshData.reviews);
            lastError = null;
            currentTask = null;
            processQueue();
            broadcastStatus();
        }

    } catch (error) {
        console.error("Queue Processing Error:", error);

        if (error.status === 503) {
            currentTask.retryAttempts = (currentTask.retryAttempts || 0);

            // Exponential backoff: 0s, 5s, 10s, 20s... max 5m
            const delay = currentTask.retryAttempts === 0 ? 0 : Math.min(5000 * Math.pow(2, currentTask.retryAttempts - 1), 300000);

            console.log(`Gemini 503. Retrying in ${delay}ms (Attempt ${currentTask.retryAttempts + 1})`);

            currentTask.nextRetryTime = Date.now() + delay;
            currentTask.retryAttempts++;

            broadcastStatus();
            setTimeout(processQueue, delay);
            return;
        }

        lastError = error.message;
        currentTask = null;
        processQueue();
        broadcastStatus();
    }
}

// ---------------------------------------------------------
// Gemini API Logic
// ---------------------------------------------------------

function sanitizeSource(source) {
    if (!source) return null;
    let s = source.toLowerCase();
    s = s.replace(/^https?:\/\//, '');
    s = s.replace(/^www\./, '');
    s = s.replace(/\/$/, '');
    return s;
}

async function performGeminiQuery(hostname) {
    const { geminiApiKey, sources, preferredModel, maxBullets, maxWords, maxProviders, autoAddSources, lastSettingsChange } =
        await chrome.storage.sync.get(['geminiApiKey', 'sources', 'preferredModel', 'maxBullets', 'maxWords', 'maxProviders', 'autoAddSources', 'lastSettingsChange']);

    const limitBullets = maxBullets || 3;
    const limitWords = maxWords || 6;
    const limitProviders = maxProviders || 20;
    const shouldAutoAdd = (autoAddSources !== false); // Default true

    if (!geminiApiKey) {
        return;
    }

    const cleanSourceDomains = sources ? getActiveSources(sources, limitProviders)
        .map(sanitizeSource)
        .filter(s => s && s.length > 0) : [];

    let prompt;
    if (cleanSourceDomains.length > 0) {
        prompt = `
        You are a site reputation analyzer.
        Target Hostname: "${hostname}"
        Trusted Sources: ${cleanSourceDomains.join(', ')}

        Goal: Find valid reputation signals strictly from the trusted sources.

        Step 1: execute Google Search queries to find reviews on each of the following websites: ${cleanSourceDomains.join(', ')}
        **CRITICAL: You must construct your search queries using the "site:" operator.** 
         - Example: "site:${cleanSourceDomains[0]} ${hostname} reviews"    
        Step 2: For each result, verify it is a review page for the SPECIFIC target hostname.
        Step 3: Extract the rating (or estimate sentiment 0-5) and summary.
        Step 4: Determine if "${hostname}" itself is a "Reputation Source" (a platform hosting reviews or discussions of a wide variety of websites).

        Rules:
        - Do NOT search the broad web. Only use the sources listed.
        - Do NOT invent URLs. Use the exact "source_title" anchor to locate the link.
        - Return at most ${limitBullets} bullet points per summary (${limitWords} words max).
        - Set "isSource" to true if "${hostname}" is a generalized review site, forum or other source of information about a variety of websites and businesses.
        `;
    } else {
        prompt = `
        You are a site reputation analyzer.
        Target Hostname: "${hostname}"

        Goal: Determine if "${hostname}" itself is a "Reputation Source" (a platform hosting reviews or discussions of a wide variety of websites).

        Rules:
        - Return an empty list for "reviews".
        - Set "isSource" to true if "${hostname}" is a generalized review site, forum or other source of information about a variety of websites and businesses.
        `;
    }
    const model = preferredModel || 'gemini-3-flash-preview';

    const responseSchema = {
        "type": "OBJECT",
        "properties": {
            "isSource": { "type": "BOOLEAN", "description": "True if the target website itself is a source of reputation (reviews/discussions) for others." },
            "reviews": {
                "type": "ARRAY",
                "description": "List of reputation reviews from trusted sources",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "source": { "type": "STRING", "description": "Name of the review source (e.g. Trustpilot)" },
                        "url": { "type": "STRING", "description": "Direct URL to the review page" },
                        "rating": { "type": "NUMBER", "description": "Star rating from 0 to 5" },
                        "summary": {
                            "type": "ARRAY",
                            "description": `Key points summarizing the reputation, max ${limitBullets} points`,
                            "items": { "type": "STRING", "description": `Bullet point summary (max ${limitWords} words)` }
                        }
                    },
                    "required": ["source", "url", "rating", "summary"]
                }
            }
        },
        "required": ["reviews"]
    };

    console.log("Prompting Gemini:", prompt);
    const startTime = Date.now();
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: responseSchema
            },
            tools: [{ google_search: {} }]
        })
    });

    const duration = (Date.now() - startTime) / 1000;
    const result = await response.json();
    console.log(`Gemini API Response in ${duration}s:`, result);

    if (!response.ok) {
        console.error(`API Error (${response.status} ${response.statusText})`);
        const err = new Error(`API Error: ${response.status} ${response.statusText}`);
        err.status = response.status;
        throw err;
    }

    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const jsonResult = JSON.parse(text);

    // Auto-add logic
    if (jsonResult.isSource && shouldAutoAdd) {
        const migrated = migrateSources(sources);
        // Check if exists
        const exists = migrated.some(s => s.domain === hostname || hostname.endsWith('.' + s.domain));
        if (!exists) {
            console.log(`Auto-adding new reputation source: ${hostname}`);
            migrated.push({
                domain: hostname,
                state: 'auto',
                visits: 0
            });
            // Update storage - strict mode, async
            await chrome.storage.sync.set({ sources: migrated, lastSettingsChange: Date.now() });

            // Note: We don't need to re-query immediately, 
        }
    }
    const metadata = result.candidates?.[0]?.groundingMetadata;
    await saveToCache(hostname, jsonResult.reviews || [], !!jsonResult.isSource, metadata);
}

// ---------------------------------------------------------
// Navigation & Listeners
// ---------------------------------------------------------

async function checkAndIncrementVisits(url) {
    if (!url) return;
    try {
        const hostname = new URL(url).hostname;
        const { sources } = await chrome.storage.sync.get(['sources']);
        const migrated = migrateSources(sources); // Ensure object format

        let changed = false;
        // Check if hostname matches any source domain
        // (Loose match? or strict? Assumed strict domain match or strict hostname)
        // User said "domain". If source is "trustpilot.com", visiting "www.trustpilot.com" should count.
        // let's do includes check or endswith

        const matchIndex = migrated.findIndex(s =>
            hostname === s.domain || hostname.endsWith('.' + s.domain) || s.domain.endsWith('.' + hostname)
        );

        if (matchIndex !== -1) {
            migrated[matchIndex].visits = (migrated[matchIndex].visits || 0) + 1;
            await chrome.storage.sync.set({ sources: migrated });
        }
    } catch (e) {
        console.error("Visit Check Error", e);
    }
}

async function handleNavigation(tabId, url) {
    if (!url || !url.startsWith('http')) return;

    // Check if this is a visit to a provider
    await checkAndIncrementVisits(url);

    // Always clear badge first
    await chrome.action.setBadgeText({ text: "", tabId }).catch(() => { });

    try {
        const hostname = new URL(url).hostname;
        const cached = await getFromCache(hostname);

        if (cached) {
            await updateBadgeForRating(tabId, cached.reviews);
            if (!cached.isStale) return;
        }

        addToQueue(hostname, false, tabId);

    } catch (e) {
        console.error("Nav Error", e);
    }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        handleNavigation(tabId, tab.url);
    }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab.url) {
            handleNavigation(activeInfo.tabId, tab.url);
        }
    } catch (e) { }
});

chrome.runtime.onStartup.addListener(pruneCache);

// ---------------------------------------------------------
// Message Handling (Popup Communication)
// ---------------------------------------------------------

function broadcastStatus() {
    chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        queue: queryQueue,
        currentTask: currentTask,
        lastError: lastError
    }, () => {
        if (chrome.runtime.lastError) {
            // Safe to ignore
        }
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_STATUS') {
        (async () => {
            const qStatus = {
                queue: queryQueue,
                currentTask: currentTask,
                lastError: lastError
            };

            if (request.hostname) {
                const cached = await getFromCache(request.hostname);
                qStatus.currentResult = cached;
            }
            sendResponse(qStatus);
        })();
        return true;
    }

    if (request.type === 'REFRESH') {
        const hostname = request.hostname;
        addToQueue(hostname, true, request.tabId);
        sendResponse({ joined: true });
    }
});
