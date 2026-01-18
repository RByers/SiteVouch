// background.js

const CACHE_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory queue
let queryQueue = [];
let currentTask = null; // The task currently being processed

function calculateRating(reviews) {
    if (!reviews || reviews.length === 0) return null;
    const sum = reviews.reduce((acc, r) => acc + (r.rating || 0), 0);
    return sum / reviews.length;
}

// Helper: Determine badge from avg rating
async function updateBadgeForRating(tabId, reviews) {
    if (!reviews || reviews.length === 0) {
        // Clear badge if no data
        await chrome.action.setBadgeText({ text: "", tabId }).catch(() => { });
        return;
    }

    const rating = calculateRating(reviews);
    let text = "👉";
    let color = "#FFEE58"; // Yellow-ish

    if (rating >= 4) {
        text = "👍";
        color = "#66BB6A"; // Green
    } else if (rating <= 2.5) {
        text = "👎";
        color = "#EF5350"; // Red
    }

    try {
        await chrome.action.setBadgeText({ text: text, tabId });
        await chrome.action.setBadgeBackgroundColor({ color: color, tabId });
    } catch (e) {
        // Tab likely closed
    }
}

// ---------------------------------------------------------
// Cache Logic
// ---------------------------------------------------------

async function getFromCache(hostname) {
    const key = `cache_${hostname}`;
    const data = await chrome.storage.local.get(key);
    const entry = data[key];

    if (!entry) return null;

    // Check model version match
    const { preferredModel } = await chrome.storage.sync.get(['preferredModel']);
    const currentModel = preferredModel || 'gemini-3-flash-preview';

    if (entry.model !== currentModel) {
        // Model mismatch - treat as stale/invalid (or just return null to force re-fetch)
        // User said: "consider a cache to be stale whenever the model name doesn't match"
        // Returning null basically forces a re-queue.
        return null;
    }

    const age = Date.now() - entry.timestamp;
    if (age > CACHE_EXPIRE_MS) {
        chrome.storage.local.remove(key); // Expired
        return null;
    }

    // Return entry even if stale (callers can decide to refresh)
    entry.isStale = age > CACHE_STALE_MS;
    return entry;
}

async function saveToCache(hostname, reviews, model) {
    const key = `cache_${hostname}`;
    const entry = {
        hostname: hostname,
        timestamp: Date.now(),
        reviews: reviews,
        model: model
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
        if (forceRefresh && !currentTask.forceRefresh) {
            // It's already running but wasn't forced... we can't easily "upgrade" the running task
            // but we could queue a new forced one if we really wanted. 
            // For simplicity, we just let the current one finish.
        }
        if (tabId) currentTask.tabId = tabId; // Update tabId so icon updates correctly
        return;
    }

    queryQueue.push({ hostname, forceRefresh, tabId });
    processQueue();
    broadcastStatus(); // Notify popup
}

async function processQueue() {
    if (currentTask || queryQueue.length === 0) return;

    currentTask = queryQueue.shift();
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
        }

    } catch (error) {
        console.error("Queue Processing Error:", error);
    } finally {
        currentTask = null;
        processQueue();
        broadcastStatus();
    }
}

// ---------------------------------------------------------
// Gemini API Logic
// ---------------------------------------------------------

async function performGeminiQuery(hostname) {
    const { geminiApiKey, sources, preferredModel } = await chrome.storage.sync.get(['geminiApiKey', 'sources', 'preferredModel']);

    if (!geminiApiKey || !sources || sources.length === 0) {
        return;
    }

    const prompt = `Analyze the reputation of "${hostname}" using the following sources: ${sources.join(', ')}.
    Rules:
    - Only include entries for relevant sources where valid reputation signals are found.
    - Do NOT invent URLs, provide only exactly URLs from search results. If a search result does not explicitly contain a review link, omit the entry.
    - Return at most 3 points in the summary, max 6 words each.`;

    const model = preferredModel || 'gemini-3-flash-preview';

    const responseSchema = {
        "type": "OBJECT",
        "properties": {
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
                            "description": "Key points summarizing the reputation, max 3 points",
                            "items": { "type": "STRING", "description": "Bullet point summary (max 6 words)" }
                        }
                    },
                    "required": ["source", "url", "rating", "summary"]
                }
            }
        },
        "required": ["reviews"]
    };

    try {
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

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const result = await response.json();
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        const jsonResult = JSON.parse(text);

        await saveToCache(hostname, jsonResult.reviews || [], model);

    } catch (e) {
        console.error("Gemini API Failed", e);
    }
}

// ---------------------------------------------------------
// UI / Badge Logic
// ---------------------------------------------------------

function calculateRating(reviews) {
    if (!reviews || reviews.length === 0) return null;
    const sum = reviews.reduce((acc, r) => acc + (r.rating || 0), 0);
    return sum / reviews.length;
}

// ---------------------------------------------------------
// Navigation & Listeners
// ---------------------------------------------------------

async function handleNavigation(tabId, url) {
    if (!url || !url.startsWith('http')) {
        // Clear badge for non-http pages
        await chrome.action.setBadgeText({ text: "", tabId }).catch(() => { });
        return;
    }

    try {
        const hostname = new URL(url).hostname;

        const cached = await getFromCache(hostname);

        if (cached) {
            await updateBadgeForRating(tabId, cached.reviews);
            if (!cached.isStale) return;
        } else {
            // Clear/reset badge while loading? Or keep empty? 
            // "Unknown" state effectively means no badge or maybe "?" 
            // User requested "clear the badge" if no results.
            await chrome.action.setBadgeText({ text: "", tabId }).catch(() => { });
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
        currentTask: currentTask
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
                currentTask: currentTask
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
        addToQueue(hostname, true);
        sendResponse({ joined: true });
    }
});
