/**
 * Grok Agent — Service Worker (Manifest V3)
 *
 * Bridges the content script running on grok.com with the native messaging
 * host that executes shell commands on the local machine.
 */

const NATIVE_HOST = "com.grok.agent";

const DEFAULT_SETTINGS = {
  workingDir: "~/grok-workspace",
  shell: "auto",
  autoExecute: false,
  timeout: 30_000,
  maxOutputSize: 50_000,
};

/* ------------------------------------------------------------------ */
/*  Message router                                                     */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "exec":
      nativeSend(msg.payload).then(sendResponse);
      return true;

    case "ping":
      nativeSend({ action: "ping" }).then(sendResponse);
      return true;

    case "getSettings":
      chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS), (stored) => {
        sendResponse({ ...DEFAULT_SETTINGS, ...stored });
      });
      return true;

    case "saveSettings":
      chrome.storage.local.set(msg.payload, () => sendResponse({ ok: true }));
      return true;

    default:
      sendResponse({ error: `Unknown message type: ${msg.type}` });
      return false;
  }
});

/* ------------------------------------------------------------------ */
/*  Native messaging helper                                            */
/* ------------------------------------------------------------------ */

function nativeSend(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            exitCode: -1,
            stdout: "",
            stderr: chrome.runtime.lastError.message,
            error: true,
          });
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: err.message,
        error: true,
      });
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Ensure default settings exist on install                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener((details) => {
  // Seed default settings
  chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS), (stored) => {
    const toWrite = {};
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (stored[k] === undefined) toWrite[k] = v;
    }
    if (Object.keys(toWrite).length) chrome.storage.local.set(toWrite);
  });

  // Open the welcome / onboarding page on first install
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});
