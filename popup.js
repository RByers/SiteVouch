document.addEventListener('DOMContentLoaded', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const urlDiv = document.getElementById('site-url');
    const refreshBtn = document.getElementById('refresh-btn');
    const resultDiv = document.getElementById('gemini-result');

    let currentUrl = "";

    if (tab && tab.url) {
        currentUrl = tab.url;
        urlDiv.textContent = currentUrl;
    } else {
        urlDiv.textContent = "No URL found";
        refreshBtn.disabled = true;
    }

    refreshBtn.addEventListener('click', async () => {
        resultDiv.textContent = "Loading...";
        refreshBtn.disabled = true;

        try {
            const data = await chrome.storage.sync.get(['geminiApiKey', 'sources']);
            const apiKey = data.geminiApiKey;
            const sources = data.sources || [];

            if (!apiKey) {
                resultDiv.textContent = "Error: Please set Gemini API Key in options.";
                refreshBtn.disabled = false;
                return;
            }

            if (sources.length === 0) {
                resultDiv.textContent = "Warning: No reputation sources listed in options.";
            }

            const urlObj = new URL(currentUrl);
            const hostname = urlObj.hostname;

            const prompt = `According to each of the following websites, what reputation does the site ${hostname} have? Sources: ${sources.join(', ')}`;
            const model = 'gemini-3-flash-preview';

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: prompt }]
                    }],
                    tools: [{
                        google_search: {}
                    }]
                })
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`API Error: ${response.status} Details: ${errorBody}`);
            }

            const result = await response.json();
            const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "No response text found.";
            resultDiv.textContent = text;

        } catch (error) {
            console.error(error);
            resultDiv.textContent = "Error: " + error.message;
        } finally {
            refreshBtn.disabled = false;
        }
    });
});
