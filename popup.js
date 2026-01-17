document.addEventListener('DOMContentLoaded', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const urlDiv = document.getElementById('site-url');

    if (tab && tab.url) {
        urlDiv.textContent = tab.url;
    } else {
        urlDiv.textContent = "No URL found";
    }
});
