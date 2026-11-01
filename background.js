// content.js is injected only when the icon is clicked, so no site access is needed up front.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await toggle(tab.id);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  } catch (err) {
    // chrome:// pages, the Chrome Web Store, the PDF viewer and so on
    console.warn("Web Magnifier cannot run on this page:", err);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
  }
});

async function toggle(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "toggle" }, { frameId: 0 });
  } catch {
    // Not injected in this page yet
    const target = { tabId };
    await chrome.scripting.insertCSS({ target, files: ["styles.css"] });
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
    await chrome.tabs.sendMessage(tabId, { action: "toggle" }, { frameId: 0 });
  }
}

// Used for everything that is not a <video>
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "capture" || !sender.tab) return;
  chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }).then(
    (dataUrl) => sendResponse({ dataUrl }),
    (err) => sendResponse({ error: err.message })
  );
  return true;
});
