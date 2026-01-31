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

async function saveToCache(hostname, reviews, model, groundingMetadata) {
    const key = `cache_${hostname}`;
    const entry = {
        hostname: hostname,
        timestamp: Date.now(),
        reviews: reviews,
        model: model,
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
            // Success - ensure error is clear
            lastError = null;
        }

    } catch (error) {
        console.error("Queue Processing Error:", error);
        lastError = error.message;
    } finally {
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
    const { geminiApiKey, sources, preferredModel, maxBullets, maxWords } = await chrome.storage.sync.get(['geminiApiKey', 'sources', 'preferredModel', 'maxBullets', 'maxWords']);

    const limitBullets = maxBullets || 3;
    const limitWords = maxWords || 6;

    if (!geminiApiKey || !sources || sources.length === 0) {
        return;
    }

    const cleanSources = sources.map(sanitizeSource).filter(s => s && s.length > 0);
    if (cleanSources.length === 0) {
        console.warn("No valid sources after sanitization");
        return;
    }

    const model = preferredModel || 'gemini-3-flash-preview';

    // Initialize cache entry with empty reviews if it doesn't exist
    // We want to clear any *old* complete result when we start a fresh "force refresh" or new query
    // But since `performGeminiQuery` is called when data is missing or stale, we can just start fresh.
    let currentReviews = [];

    // Check if we already have partial results to preserve (unlikely for a full refresh, but good practice?)
    // Actually, for a fresh run, we should reset.
    await saveToCache(hostname, [], model, null); // Clear previous data to start fresh

    for (const source of cleanSources) {
        console.log(`Querying source: ${source}`);

        const prompt = `
        You are a site reputation analyzer.
        Target Hostname: "${hostname}"
        Target Source: "${source}"

        Goal: Find valid reputation signals strictly from the specific Target Source.

        Step 1: Execute this exact Google Search query: "site:${source} ${hostname} reviews"
        Step 2: From the search results, verify if there is a review page for the SPECIFIC target hostname on ${source}.
        Step 3: If found, extract the rating (or estimate sentiment 0-5) and summary. If NOT found, return null.

        Rules:
        - Do NOT search the broad web. Only use the search result from "site:${source}".
        - Return at most ${limitBullets} bullet points per summary (${limitWords} words max).
        `;

        const responseSchema = {
            "type": "OBJECT",
            "properties": {
                "found": { "type": "BOOLEAN", "description": "True if a relevant review page was found on the source" },
                "review": {
                    "type": "OBJECT",
                    "description": "The review data if found",
                    "properties": {
                        "source": { "type": "STRING", "description": `Must be exactly "${source}"` },
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
            },
            "required": ["found"]
        };

        console.log("Prompt:", prompt);

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
                console.error(`API Error for ${source}:`, response.statusText);
                continue; // Skip this source on error
            }

            const result = await response.json();
            const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
            const jsonResult = JSON.parse(text);
            const metadata = result.candidates?.[0]?.groundingMetadata;

            if (jsonResult.found && jsonResult.review) {
                // Attach metadata to the review object itself for per-row display
                const reviewWithMeta = {
                    ...jsonResult.review,
                    groundingMetadata: metadata,
                    source: source // Ensure source name is consistent
                };

                // Add to our running list
                currentReviews.push(reviewWithMeta);

                // Update Cache immediately
                // Note: We are passing 'null' for global metadata because we store it per-review now.
                await saveToCache(hostname, currentReviews, model, null);

                // Notify Popup
                broadcastStatus();
            }

        } catch (e) {
            console.error(`Failed to query source ${source}`, e);
            // Continue to next source
        }
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
    // Always clear badge first to avoid stale state
    await chrome.action.setBadgeText({ text: "", tabId }).catch(() => { });

    if (!url || !url.startsWith('http')) {
        return;
    }

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
