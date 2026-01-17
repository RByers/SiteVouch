const input = document.getElementById('new-source');
const addBtn = document.getElementById('add-btn');
const list = document.getElementById('sources-list');

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

function loadSources() {
    chrome.storage.sync.get('sources', (data) => {
        const sources = data.sources || [];
        renderList(sources);
    });
}

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

document.addEventListener('DOMContentLoaded', loadSources);
addBtn.addEventListener('click', addSource);
input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addSource();
});
