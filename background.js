// background.js

// Default state is neutral or unknown.
// For now, we'll keep it simple.

const STATE_ICONS = {
    positive: "icons/positive.png",
    neutral: "icons/neutral.png",
    negative: "icons/negative.png",
    unknown: "icons/unknown.png"
};

// Placeholder for reputation logic
async function getReputationState(url) {
    if (!url) return "neutral";

    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;

        // TODO: Fetch sources from storage and check against them.
        // For now, let's hardcode a demonstration logic or just check storage if possible.

        const { sources } = await chrome.storage.sync.get("sources");
        if (!sources || !Array.isArray(sources)) return "unknown";

        // Simple check: if hostname is in sources, we might consider it "positive" or check its value?
        // The requirement says "reputation sources the user lists". 
        // It implies the user lists sources that PROVIDE reputation, OR lists sites?
        // "reputation score for a site based on a set of reputation sources the user lists"
        // This sounds like the user provides a URL to a list (like a blocklist/allowlist) or an API?
        // Or maybe the user just lists domains they vouch for?
        // "show a reputation score for a site based on a set of reputation sources"
        // This is ambiguous. "Reputation Sources". 
        // Let's assume for this "Basic" version: The user adds domains to a "Trusted" list (Positive) or "Untrusted" list (Negative)?
        // OR: The user adds a URL that provides a list of reputation data.
        // Given "add and remove URLs to a list of reputation sources", it implies the user adds URLs OF SOURCES.
        // But since we need a "Basic" extension without external fetch complexity if possible, 
        // maybe for this v1 allow the user to just add "Trusted Domains" directly? 
        // Wait, "reputation sources" usually means a server.
        // But "Basic chrome extension... auto show reputation score... sources the user lists".
        // "For now the settings page should just allow the user to add and remove URLs to a list of reputation sources."

        // Let's interpret "Reputation Sources" as: A list of domains that are "Vouched" for.
        // If the current site is in the list -> Positive.
        // If not -> Unknown/Neutral.

        // Let's stick to: User lists "Safe Sites".
        // If we find the site in the list, it's Positive.
        // If not, Unknown.

        // We'll check if hostname includes any of the user-listed strings.
        if (sources.some(source => hostname.includes(source))) {
            return "positive";
        }

        return "unknown";

    } catch (e) {
        console.error("Invalid URL", url);
        return "neutral";
    }
}

async function updateTabIcon(tabId, url) {
    const state = await getReputationState(url);
    const iconPath = STATE_ICONS[state];

    await chrome.action.setIcon({
        tabId: tabId,
        path: {
            "16": iconPath,
            "48": iconPath,
            "128": iconPath
        }
    });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        updateTabIcon(tabId, tab.url);
    }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
        updateTabIcon(activeInfo.tabId, tab.url);
    }
});

// Initialize sources if empty
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.get("sources", (data) => {
        if (!data.sources) {
            chrome.storage.sync.set({ sources: [] });
        }
    });
});
