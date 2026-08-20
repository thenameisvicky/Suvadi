// background.js

chrome.action.onClicked.addListener(async (tab) => {
  const url = tab && tab.url;

  if (url && url.includes("chatgpt.com")) {
    // Try sending message first
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "toggle_widget" });
    } catch (err) {
      console.log("Content script not active, injecting programmatically...", err);
      // Inject content script and styles programmatically
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["content.css"]
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"]
        });
        
        // Wait a short moment and send message
        setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { action: "toggle_widget" })
            .catch(e => console.error("Retry failed:", e));
        }, 150);
      } catch (injectErr) {
        console.error("Failed to inject content script:", injectErr);
      }
    }
  } else {
    // If we're not on ChatGPT or can't access tab URL (e.g. system page), 
    // set visibility flag and open a new ChatGPT tab.
    chrome.storage.local.set({ chatgpt_saver_visible: true }, () => {
      chrome.tabs.create({ url: "https://chatgpt.com" });
    });
  }
});

// Listener for writing files via the downloads API
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "write_local_file") {
    try {
      const base64Content = btoa(unescape(encodeURIComponent(request.content)));
      const dataUrl = `data:text/plain;charset=utf-8;base64,${base64Content}`;
      
      chrome.downloads.download({
        url: dataUrl,
        filename: `helm_vault/${request.fileName}`,
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
