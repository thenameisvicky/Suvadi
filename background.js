chrome.action.onClicked.addListener(async (tab) => {
  const url = tab && tab.url;

  if (url && url.includes("chatgpt.com")) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "toggle_widget" });
    } catch (err) {
      console.log("Content script not active, injecting programmatically...", err);
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["content.css"]
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"]
        });
        
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { action: "toggle_widget" }, () => {
            if (chrome.runtime.lastError) {
              console.log("Retry failed safely (content script not ready):", chrome.runtime.lastError.message);
            }
          });
        }, 150);
      } catch (injectErr) {
        console.error("Failed to inject content script:", injectErr);
      }
    }
  } else {
    chrome.storage.local.set({ chatgpt_saver_visible: true }, () => {
      chrome.tabs.create({ url: "https://chatgpt.com" });
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "get_tab_id") {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
    return false; 
  }

  if (request.action === "write_local_file") {
    try {
      const base64Content = btoa(unescape(encodeURIComponent(request.content)));
      const dataUrl = `data:text/plain;charset=utf-8;base64,${base64Content}`;
      
      chrome.downloads.download({
        url: dataUrl,
        filename: `suvadi_vault/${request.fileName}`,
        conflictAction: 'overwrite',
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("Download failed:", chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      });
    } catch (err) {
      console.error("Error initiating download:", err);
      sendResponse({ success: false, error: err.message });
    }
    return true; // Keep channel open for async response
  }
});

// Clean up tab-specific storage when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(null, (data) => {
    const keysToRemove = [];
    const suffix = `_${tabId}`;
    for (const key of Object.keys(data)) {
      if (key.endsWith(suffix)) {
        keysToRemove.push(key);
      }
    }
    if (keysToRemove.length > 0) {
      chrome.storage.local.remove(keysToRemove);
    }
  });
});
