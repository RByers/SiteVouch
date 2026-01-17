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

            const prompt = `Analyze the reputation of "${hostname}" using the following sources: ${sources.join(', ')}.
        Return a JSON object with a key "reviews" containing an array of entries.
        Only include entries for relevant sources where valid reputation signals are found.
        Each entry must have:
        - "source": Name of the source.
        - "url": Direct URL to the reputation page on that source.
        - "rating": A number (0-5) representing the star rating.
        - "summary": A very brief summary (max 3 bullet points of 6 words each).`;

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
                    generationConfig: {
                        responseMimeType: "application/json"
                    },
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
            const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
            const jsonResult = JSON.parse(text);
            const reviews = jsonResult.reviews || [];

            if (reviews.length === 0) {
                resultDiv.textContent = "No relevant reputation data found.";
            } else {
                let tableHtml = `
            <table>
                <thead>
                    <tr>
                        <th>Source</th>
                        <th>Rating</th>
                        <th>Summary</th>
                    </tr>
                </thead>
                <tbody>
            `;

                reviews.forEach(review => {
                    const summaryList = Array.isArray(review.summary) ? review.summary.map(s => `<li>${s}</li>`).join('') : review.summary;
                    tableHtml += `
                    <tr>
                        <td><a class="source-link" data-url="${review.url}">${review.source}</a></td>
                        <td>${review.rating}/5</td>
                        <td><ul>${summaryList}</ul></td>
                    </tr>
                `;
                });

                tableHtml += `</tbody></table>`;
                resultDiv.innerHTML = tableHtml;

                // Add click handlers for links
                document.querySelectorAll('.source-link').forEach(link => {
                    link.addEventListener('click', (e) => {
                        const url = e.target.getAttribute('data-url');
                        if (url) {
                            chrome.tabs.create({ url: url });
                        }
                    });
                });
            }

        } catch (error) {
            console.error(error);
            resultDiv.textContent = "Error: " + error.message;
        } finally {
            refreshBtn.disabled = false;
        }
    });
});
