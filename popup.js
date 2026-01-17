document.addEventListener('DOMContentLoaded', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hostSpan = document.getElementById('site-hostname');
    const refreshBtn = document.getElementById('refresh-btn');
    const resultDiv = document.getElementById('gemini-result');
    const queueDiv = document.getElementById('queue-status');

    let currentHostname = "";

    if (tab && tab.url) {
        try {
            currentHostname = new URL(tab.url).hostname;
            hostSpan.textContent = currentHostname;
        } catch (e) {
            currentHostname = "";
            hostSpan.textContent = "Invalid URL";
        }
    } else {
        hostSpan.textContent = "No URL";
        refreshBtn.disabled = true;
        refreshBtn.classList.add('disabled'); // Ensure style updates if needed
    }

    // -------------------------------------------------------------
    // Rendering logic
    // -------------------------------------------------------------
    function renderResult(reviews) {
        if (!reviews || reviews.length === 0) {
            resultDiv.textContent = "No relevant reputation data found.";
            return;
        }

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

        document.querySelectorAll('.source-link').forEach(link => {
            link.addEventListener('click', (e) => {
                const url = e.target.getAttribute('data-url');
                if (url) {
                    chrome.tabs.create({ url: url });
                }
            });
        });
    }

    function renderStatus(status) {
        let allTasks = [];
        if (status.currentTask) {
            allTasks.push(status.currentTask);
        }
        if (status.queue) {
            allTasks = allTasks.concat(status.queue);
        }

        if (allTasks.length > 0) {
            const hostnames = allTasks.map(t => t.hostname).join(', ');
            queueDiv.textContent = `Processing: ${hostnames}`;
        } else {
            queueDiv.textContent = "";
        }

        if (status.currentResult) {
            renderResult(status.currentResult.reviews);
        }
    }

    // -------------------------------------------------------------
    // Communication logic
    // -------------------------------------------------------------

    // Initial fetch
    if (currentHostname) {
        chrome.runtime.sendMessage({ type: 'GET_STATUS', hostname: currentHostname }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn("Background service probably not ready:", chrome.runtime.lastError.message);
                return;
            }
            if (response) {
                renderStatus(response);
            }
        });
    }

    // Listen for updates from background
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'STATUS_UPDATE') {
            if (currentHostname) {
                chrome.runtime.sendMessage({ type: 'GET_STATUS', hostname: currentHostname }, (response) => {
                    if (chrome.runtime.lastError) return;
                    if (response) renderStatus(response);
                });
            }
        }
    });

    // Refresh handler
    refreshBtn.addEventListener('click', () => {
        if (!currentHostname) return;

        resultDiv.textContent = "Refreshing...";

        chrome.runtime.sendMessage({ type: 'REFRESH', hostname: currentHostname }, (response) => {
            if (chrome.runtime.lastError) {
                resultDiv.textContent = "Error: " + chrome.runtime.lastError.message;
                return;
            }
        });
    });
});
