document.addEventListener('DOMContentLoaded', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hostSpan = document.getElementById('site-hostname');
    const refreshBtn = document.getElementById('refresh-btn');
    const resultDiv = document.getElementById('gemini-result');
    const queueDiv = document.getElementById('queue-status');
    const sourcesDiv = document.getElementById('sources-container');

    const settingsBtn = document.getElementById('settings-btn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            if (chrome.runtime.openOptionsPage) {
                chrome.runtime.openOptionsPage();
            } else {
                window.open(chrome.runtime.getURL('options.html'));
            }
        });
    }

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

    // Check configuration
    const { geminiApiKey, sources } = await chrome.storage.sync.get(['geminiApiKey', 'sources']);

    if (!geminiApiKey) {
        resultDiv.innerHTML = "API key required.<br>Please configure it in the extension settings.";
        resultDiv.style.color = "#d32f2f"; // Error color
        refreshBtn.disabled = true;
        refreshBtn.classList.add('disabled');
        return; // Stop further initialization
    }

    if (!sources || sources.length === 0) {
        resultDiv.innerHTML = "No reputation sources configured.<br>Please add sources in the extension settings.";
        resultDiv.style.color = "#d32f2f"; // Error color
        refreshBtn.disabled = true;
        refreshBtn.classList.add('disabled');
        return; // Stop further initialization
    }

    // -------------------------------------------------------------
    // Rendering logic
    // -------------------------------------------------------------
    function getStarRatingHtml(rating) {
        let starsHtml = '<div class="star-rating" style="display: flex; align-items: center;">';
        for (let i = 1; i <= 5; i++) {
            let fillPercentage = 0;
            if (rating >= i) {
                fillPercentage = 100;
            } else if (rating > i - 1) {
                fillPercentage = (rating - (i - 1)) * 100;
            }

            const gradientId = `star-grad-${i}-${Math.round(Math.random() * 10000)}`;

            starsHtml += `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                        <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="${fillPercentage}%" stop-color="#FFC107" />
                            <stop offset="${fillPercentage}%" stop-color="#E0E0E0" />
                        </linearGradient>
                    </defs>
                    <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" fill="url(#${gradientId})" stroke="#E0E0E0" stroke-width="1"/>
                </svg>
            `;
        }
        starsHtml += '</div>';
        return starsHtml;
    }



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

        reviews.forEach((review, index) => {
            const summaryList = Array.isArray(review.summary) ? review.summary.map(s => `<li>${s}</li>`).join('') : review.summary;
            const ratingHtml = getStarRatingHtml(review.rating || 0);
            const rowId = `review-row-${index}`;
            const detailsId = `review-details-${index}`;

            tableHtml += `
                <tr id="${rowId}">
                    <td>
                        <div class="source-cell">
                            <a class="source-link" data-url="${review.url}">${review.source}</a>
                            <div class="source-icon-wrapper" data-target="${detailsId}" title="Show Sources">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="source-icon">
                                    <circle cx="11" cy="11" r="8"></circle>
                                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                </svg>
                            </div>
                        </div>
                    </td>
                    <td>${ratingHtml}</td>
                    <td><ul>${summaryList}</ul></td>
                </tr>
                <tr id="${detailsId}" class="source-details-row" style="display: none;">
                    <td colspan="3">
                        <div class="source-details-content">
                           ${generateSourcesHtml(review.groundingMetadata)}
                        </div>
                    </td>
                </tr>
            `;
        });

        tableHtml += `</tbody></table>`;
        resultDiv.innerHTML = tableHtml;

        // Event listeners for links
        document.querySelectorAll('.source-link').forEach(link => {
            link.addEventListener('click', (e) => {
                const url = e.target.getAttribute('data-url');
                if (url) {
                    chrome.tabs.create({ url: url });
                }
            });
        });

        // Event listeners for source toggles
        document.querySelectorAll('.source-icon-wrapper').forEach(icon => {
            icon.addEventListener('click', (e) => {
                const targetId = e.currentTarget.getAttribute('data-target');
                const detailsRow = document.getElementById(targetId);
                if (detailsRow) {
                    const isHidden = detailsRow.style.display === 'none';
                    detailsRow.style.display = isHidden ? 'table-row' : 'none';
                }
            });
        });
    }

    function generateSourcesHtml(groundingMetadata) {
        if (!groundingMetadata) return '<div class="no-sources">No source metadata available</div>';

        const queries = groundingMetadata.webSearchQueries || [];
        const chunks = groundingMetadata.groundingChunks || [];
        const seenUrls = new Set();
        let listItems = '';

        queries.forEach(query => {
            const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
            listItems += `<li><a href="${url}" target="_blank">🔍 Search: ${query}</a></li>`;
        });

        chunks.forEach(chunk => {
            if (chunk.web && chunk.web.uri && chunk.web.title) {
                if (!seenUrls.has(chunk.web.uri)) {
                    seenUrls.add(chunk.web.uri);
                    listItems += `<li><a href="${chunk.web.uri}" target="_blank">🔗 ${chunk.web.title}</a></li>`;
                }
            }
        });

        if (!listItems) return '<div class="no-sources">No sources found</div>';
        return `<ul class="source-details-list">${listItems}</ul>`;
    }

    function renderStatus(status) {
        let allTasks = [];
        if (status.currentTask) {
            allTasks.push(status.currentTask);
        }
        if (status.queue) {
            allTasks = allTasks.concat(status.queue);
        }

        if (status.lastError) {
            queueDiv.innerHTML = `<span style="color: #d32f2f;">Error: ${status.lastError}</span>`;
            // If we have tasks, append them
            if (allTasks.length > 0) {
                const hostnames = allTasks.map(t => t.hostname).join(', ');
                queueDiv.innerHTML += `<br>Processing: ${hostnames}`;
            }
        } else if (allTasks.length > 0) {
            const hostnames = allTasks.map(t => t.hostname).join(', ');
            queueDiv.textContent = `Processing: ${hostnames}`;
        } else {
            queueDiv.textContent = "";
        }

        if (status.currentResult) {
            renderResult(status.currentResult.reviews);
        }

        // Check if current hostname is being processed
        const isProcessingCurrent = allTasks.some(t => t.hostname === currentHostname);
        if (isProcessingCurrent) {
            refreshBtn.classList.add('spinning');
            refreshBtn.disabled = true;
        } else {
            refreshBtn.classList.remove('spinning');
            refreshBtn.disabled = false;
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

        // No UI clearing, just send request (animation handled by status update)
        chrome.runtime.sendMessage({ type: 'REFRESH', hostname: currentHostname, tabId: tab.id }, (response) => {
            if (chrome.runtime.lastError) {
                resultDiv.textContent = "Error: " + chrome.runtime.lastError.message;
                return;
            }
        });
    });


});
