const input = document.getElementById('new-source');
const addBtn = document.getElementById('add-btn');
const list = document.getElementById('sources-list');
const apiKeyInput = document.getElementById('apiKey');
const modelSelect = document.getElementById('modelSelect');
const maxBulletsInput = document.getElementById('maxBullets');
const maxWordsInput = document.getElementById('maxWords');
const positiveThresholdInput = document.getElementById('positiveThreshold');
const negativeThresholdInput = document.getElementById('negativeThreshold');
const maxProvidersInput = document.getElementById('maxProviders');

// Global state to maintain order between updates
let displayedSources = [];
let currentMaxProviders = 20;

// Helper to migrate legacy string[] to object[]
function migrateSources(sources) {
    if (!sources || sources.length === 0) return [];
    if (typeof sources[0] === 'string') {
        return sources.map(s => ({
            domain: s,
            state: 'on', // Default existing to 'on' to preserve behavior
            visits: 0
        }));
    }
    return sources;
}

function sortSources(sources) {
    // Sort order: On, Auto, Off. Within group: Visits desc.
    const stateOrder = { 'on': 0, 'auto': 1, 'off': 2 };

    return sources.sort((a, b) => {
        if (stateOrder[a.state] !== stateOrder[b.state]) {
            return stateOrder[a.state] - stateOrder[b.state];
        }
        return (b.visits || 0) - (a.visits || 0);
    });
}

function renderList() {
    list.innerHTML = '';

    // Logic to determine which 'auto' sources are active (not greyed out)
    // regardless of display order.
    const onCount = displayedSources.filter(s => s.state === 'on').length;
    const allowedAuto = Math.max(0, currentMaxProviders - onCount);

    // Find top 'auto' domains by visits
    const autoSources = displayedSources.filter(s => s.state === 'auto');
    // Sort just for calculation
    autoSources.sort((a, b) => (b.visits || 0) - (a.visits || 0));

    const activeAutoDomains = new Set(
        autoSources.slice(0, allowedAuto).map(s => s.domain)
    );

    displayedSources.forEach((source, index) => {
        const li = document.createElement('li');
        li.className = 'source-item';

        let isGreyedOut = false;
        if (source.state === 'off') {
            isGreyedOut = true;
        } else if (source.state === 'auto') {
            if (!activeAutoDomains.has(source.domain)) {
                isGreyedOut = true;
            }
        }

        if (isGreyedOut) li.classList.add('greyed-out');

        // Toggle Switch
        const toggleContainer = document.createElement('div');
        toggleContainer.className = 'toggle-container';

        const states = ['off', 'auto', 'on'];
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = 0;
        slider.max = 2;
        slider.value = states.indexOf(source.state);
        slider.className = `toggle-slider state-${source.state}`;

        slider.onchange = (e) => {
            const newState = states[parseInt(e.target.value)];
            updateSourceState(source.domain, newState);
        };

        // Label for current state
        const stateLabel = document.createElement('span');
        stateLabel.className = 'state-label';
        stateLabel.textContent = source.state.toUpperCase();

        toggleContainer.appendChild(slider);
        toggleContainer.appendChild(stateLabel);

        // Domain Name
        const domainSpan = document.createElement('span');
        domainSpan.className = 'domain-name';
        domainSpan.textContent = source.domain;

        // Visit Counter
        const visitsSpan = document.createElement('span');
        visitsSpan.className = 'visit-count';
        visitsSpan.textContent = `${source.visits || 0} visits`;

        // Remove Button
        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.className = 'remove';
        removeBtn.onclick = () => removeSource(source.domain);

        li.appendChild(toggleContainer);
        li.appendChild(domainSpan);
        li.appendChild(visitsSpan);
        li.appendChild(removeBtn);
        list.appendChild(li);
    });
}

function initializeSettings() {
    chrome.storage.sync.get(['sources', 'geminiApiKey', 'preferredModel', 'maxBullets', 'maxWords', 'positiveThreshold', 'negativeThreshold', 'maxProviders'], (data) => {
        let sources = migrateSources(data.sources);

        if (data.geminiApiKey) apiKeyInput.value = data.geminiApiKey;
        modelSelect.value = data.preferredModel || "gemini-3-flash-preview";
        if (data.maxBullets) maxBulletsInput.value = data.maxBullets;
        if (data.maxWords) maxWordsInput.value = data.maxWords;
        positiveThresholdInput.value = data.positiveThreshold !== undefined ? data.positiveThreshold : 4.0;
        negativeThresholdInput.value = data.negativeThreshold !== undefined ? data.negativeThreshold : 2.5;

        currentMaxProviders = data.maxProviders || 20;
        maxProvidersInput.value = currentMaxProviders;

        // Default to true if undefined
        autoAddSourcesCheck.checked = (data.autoAddSources !== false);

        // Initial Sort
        displayedSources = sortSources([...sources]);
        renderList();
    });
}

// Auto-save handlers
apiKeyInput.addEventListener('input', () => chrome.storage.sync.set({ geminiApiKey: apiKeyInput.value.trim() }));
modelSelect.addEventListener('change', () => chrome.storage.sync.set({ preferredModel: modelSelect.value, lastSettingsChange: Date.now() }));
maxBulletsInput.addEventListener('change', () => {
    const val = parseInt(maxBulletsInput.value, 10);
    if (val > 0) chrome.storage.sync.set({ maxBullets: val, lastSettingsChange: Date.now() });
});
maxWordsInput.addEventListener('change', () => {
    const val = parseInt(maxWordsInput.value, 10);
    if (val > 0) chrome.storage.sync.set({ maxWords: val, lastSettingsChange: Date.now() });
});
positiveThresholdInput.addEventListener('change', () => {
    const val = parseFloat(positiveThresholdInput.value);
    if (!isNaN(val)) chrome.storage.sync.set({ positiveThreshold: val });
});
negativeThresholdInput.addEventListener('change', () => {
    const val = parseFloat(negativeThresholdInput.value);
    if (!isNaN(val)) chrome.storage.sync.set({ negativeThreshold: val });
});
maxProvidersInput.addEventListener('change', () => {
    const val = parseInt(maxProvidersInput.value, 10);
    if (val > 0) {
        currentMaxProviders = val;
        chrome.storage.sync.set({ maxProviders: val, lastSettingsChange: Date.now() });
        renderList(); // Re-render to update greyed out status, but preserve order
    }
});

const autoAddSourcesCheck = document.getElementById('autoAddSources');
autoAddSourcesCheck.addEventListener('change', () => {
    chrome.storage.sync.set({ autoAddSources: autoAddSourcesCheck.checked });
});


function addSource() {
    const newDomain = input.value.trim();
    if (!newDomain) return;

    chrome.storage.sync.get(['sources'], (data) => {
        let sources = migrateSources(data.sources);

        if (!sources.find(s => s.domain === newDomain)) {
            const newSource = {
                domain: newDomain,
                state: 'auto', // Default to auto
                visits: 0
            };
            sources.push(newSource);

            // Update storage
            chrome.storage.sync.set({ sources, lastSettingsChange: Date.now() }, () => {
                input.value = '';
                // Add to display list (unshift to top so user sees it)
                displayedSources.unshift(newSource);
                renderList();
            });
        }
    });
}

function updateSourceState(domain, newState) {
    // 1. Update in-memory display list
    const item = displayedSources.find(s => s.domain === domain);
    if (item) {
        item.state = newState;
        renderList(); // Re-render immediately to reflect greyed-out changes if any
    }

    // 2. Sync to storage
    chrome.storage.sync.get(['sources'], (data) => {
        let sources = migrateSources(data.sources);
        const storeItem = sources.find(s => s.domain === domain);
        if (storeItem) {
            storeItem.state = newState;
            chrome.storage.sync.set({ sources, lastSettingsChange: Date.now() });
        }
    });
}

function removeSource(domain) {
    // 1. Update in-memory
    displayedSources = displayedSources.filter(s => s.domain !== domain);
    renderList();

    // 2. Sync
    chrome.storage.sync.get(['sources'], (data) => {
        let sources = migrateSources(data.sources);
        sources = sources.filter(s => s.domain !== domain);
        chrome.storage.sync.set({ sources, lastSettingsChange: Date.now() });
    });
}

document.addEventListener('DOMContentLoaded', initializeSettings);
addBtn.addEventListener('click', addSource);
input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addSource();
});
