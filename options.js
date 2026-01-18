const input = document.getElementById('new-source');
const addBtn = document.getElementById('add-btn');
const list = document.getElementById('sources-list');
const apiKeyInput = document.getElementById('apiKey');
const modelSelect = document.getElementById('modelSelect');
const maxBulletsInput = document.getElementById('maxBullets');
const maxWordsInput = document.getElementById('maxWords');

function renderList(sources) {
    list.innerHTML = '';
    sources.forEach((source, index) => {
        const li = document.createElement('li');
        li.textContent = source;

        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Remove';
        removeBtn.className = 'remove';
        removeBtn.onclick = () => removeSource(index);

        li.appendChild(removeBtn);
        list.appendChild(li);
    });
}

function loadSettings() {
    chrome.storage.sync.get(['sources', 'geminiApiKey', 'preferredModel', 'maxBullets', 'maxWords'], (data) => {
        const sources = data.sources || [];
        renderList(sources);
        if (data.geminiApiKey) {
            apiKeyInput.value = data.geminiApiKey;
        }
        if (data.preferredModel) {
            modelSelect.value = data.preferredModel;
        } else {
            modelSelect.value = "gemini-3-flash-preview"; // Default
        }

        if (data.maxBullets) maxBulletsInput.value = data.maxBullets;
        if (data.maxWords) maxWordsInput.value = data.maxWords;
    });
}

// Auto-save handlers
apiKeyInput.addEventListener('input', () => {
    const key = apiKeyInput.value.trim();
    chrome.storage.sync.set({ geminiApiKey: key });
});

modelSelect.addEventListener('change', () => {
    const model = modelSelect.value;
    chrome.storage.sync.set({ preferredModel: model });
});

maxBulletsInput.addEventListener('change', () => {
    const val = parseInt(maxBulletsInput.value, 10);
    if (val > 0) chrome.storage.sync.set({ maxBullets: val });
});

maxWordsInput.addEventListener('change', () => {
    const val = parseInt(maxWordsInput.value, 10);
    if (val > 0) chrome.storage.sync.set({ maxWords: val });
});

function addSource() {
    const newSource = input.value.trim();
    if (!newSource) return;

    chrome.storage.sync.get('sources', (data) => {
        const sources = data.sources || [];
        if (!sources.includes(newSource)) {
            sources.push(newSource);
            chrome.storage.sync.set({ sources }, () => {
                input.value = '';
                renderList(sources);
            });
        }
    });
}

function removeSource(index) {
    chrome.storage.sync.get('sources', (data) => {
        const sources = data.sources || [];
        sources.splice(index, 1);
        chrome.storage.sync.set({ sources }, () => {
            renderList(sources);
        });
    });
}

document.addEventListener('DOMContentLoaded', loadSettings);
addBtn.addEventListener('click', addSource);
input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addSource();
});
