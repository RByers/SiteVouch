// background.js

const CACHE_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory queue
let queryQueue = [];
let isProcessing = false;

// State icons
const STATE_ICONS = {
    positive: "icons/positive.png",
    neutral: "icons/neutral.png",
    negative: "icons/negative.png",
    unknown: "icons/unknown.png"
};

// Helper: Determine icon from avg rating
function getIconForRating(rating) {
    if (rating === undefined || rating === null) return "icons/unknown.png";
    if (rating >= 4) return "icons/positive.png";
    if (rating <= 2.5) return "icons/negative.png";
    return "icons/neutral.png";
}

// ---------------------------------------------------------
// Cache Logic
// ---------------------------------------------------------

async function getFromCache(hostname) {
    const key = `cache_${hostname}`;
    const data = await chrome.storage.local.get(key);
    const entry = data[key];

    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > CACHE_EXPIRE_MS) {
        chrome.storage.local.remove(key); // Expired
        return null;
    }

    // Return entry even if stale (callers can decide to refresh)
    entry.isStale = age > CACHE_STALE_MS;
    return entry;
}

async function saveToCache(hostname, reviews) {
    const key = `cache_${hostname}`;
    const entry = {
        hostname: hostname,
        timestamp: Date.now(),
        reviews: reviews
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

    if (existingIndex !== -1) {
        if (forceRefresh) queryQueue[existingIndex].forceRefresh = true;
        if (tabId) queryQueue[existingIndex].tabId = tabId;
        return;
    }

    queryQueue.push({ hostname, forceRefresh, tabId });
    processQueue();
    broadcastStatus(); // Notify popup
}

async function processQueue() {
    if (isProcessing || queryQueue.length === 0) return;

    isProcessing = true;
    const task = queryQueue.shift();
    broadcastStatus();

    try {
        if (!task.forceRefresh) {
            const cached = await getFromCache(task.hostname);
            if (cached && !cached.isStale) {
                await updateIconForHost(task.hostname, cached.reviews, task.tabId);
                isProcessing = false;
                processQueue();
                return;
            }
        }

        await performGeminiQuery(task.hostname);

        const freshData = await getFromCache(task.hostname);
        if (freshData) {
            await updateIconForHost(task.hostname, freshData.reviews, task.tabId);
        }

    } catch (error) {
        console.error("Queue Processing Error:", error);
    } finally {
        isProcessing = false;
        processQueue();
        broadcastStatus();
    }
}

// ---------------------------------------------------------
// Gemini API Logic
// ---------------------------------------------------------

async function performGeminiQuery(hostname) {
    const { geminiApiKey, sources } = await chrome.storage.sync.get(['geminiApiKey', 'sources']);

    if (!geminiApiKey || !sources || sources.length === 0) {
        return;
    }

    const prompt = `Analyze the reputation of "${hostname}" using the following sources: ${sources.join(', ')}.
    Return a JSON object with a key "reviews" containing an array of entries.
    Only include entries for relevant sources where valid reputation signals are found.
    Each entry must have:
    - "source": Name of the source.
    - "url": Direct URL to the reputation page on that source.
    - "rating": A number (0-5) representing the star rating.
    - "summary": A very brief summary (max 3 bullet points of 6 words each).`;

    const model = 'gemini-3-flash-preview';

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json" },
                tools: [{ google_search: {} }]
            })
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const result = await response.json();
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        const jsonResult = JSON.parse(text);

        await saveToCache(hostname, jsonResult.reviews || []);

    } catch (e) {
        console.error("Gemini API Failed", e);
    }
}

// ---------------------------------------------------------
// UI / Icon Logic
// ---------------------------------------------------------

function calculateRating(reviews) {
    if (!reviews || reviews.length === 0) return null;
    const sum = reviews.reduce((acc, r) => acc + (r.rating || 0), 0);
    return sum / reviews.length;
}

async function updateIconForHost(hostname, reviews, specificTabId = null) {
    const rating = calculateRating(reviews);
    const iconPath = getIconForRating(rating);

    try {
        if (specificTabId) {
            // Catch invalid icon errors
            await chrome.action.setIcon({ tabId: specificTabId, path: iconPath }).catch(() => { });
        } else {
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
                // Ensure we only try to set icons on valid web pages
                if (tab.url && tab.url.startsWith('http')) {
                    try {
                        const urlObj = new URL(tab.url);
                        if (urlObj.hostname === hostname) {
                            await chrome.action.setIcon({ tabId: tab.id, path: iconPath }).catch(() => { });
                        }
                    } catch (e) {
                        // Invalid URL or specific tab issue
                    }
                }
            }
        }
    } catch (e) {
        // Broad catch for any unexpected icon errors
        console.error("Icon Update Error:", e);
    }
}

// ---------------------------------------------------------
// Navigation & Listeners
// ---------------------------------------------------------

async function handleNavigation(tabId, url) {
    if (!url || !url.startsWith('http')) return;

    try {
        const hostname = new URL(url).hostname;

        const cached = await getFromCache(hostname);

        if (cached) {
            await updateIconForHost(hostname, cached.reviews, tabId);
            if (!cached.isStale) return;
        } else {
            await chrome.action.setIcon({ tabId: tabId, path: "icons/unknown.png" }).catch(() => { });
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
    } catch (e) {
        // Tab invalid or closed
    }
});

chrome.runtime.onStartup.addListener(pruneCache);

// ---------------------------------------------------------
// Message Handling (Popup Communication)
// ---------------------------------------------------------

function broadcastStatus() {
    chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        queueLength: queryQueue.length,
        isProcessing: isProcessing
    }, () => {
        // Suppress "Receiving end does not exist"
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
                isProcessing: isProcessing
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
