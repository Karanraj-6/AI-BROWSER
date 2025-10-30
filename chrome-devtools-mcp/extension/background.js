// background.js - service worker for MCP Attach Helper extension
// Listens for clicks or runtime messages to attach to the active tab and run a small CDP snippet.

function attachAndRun() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    const tabId = tabs[0].id;
    const version = '1.3';
    chrome.debugger.attach({ tabId }, version, () => {
      if (chrome.runtime.lastError) {
        console.error('attach error', chrome.runtime.lastError);
        return;
      }
      // Enable Runtime domain so we can evaluate JS in the page context.
      chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {}, () => {
        const code = `(() => {
          // Try to play the video if present, otherwise report current URL.
          const playBtn = document.querySelector('button.ytp-large-play-button') || document.querySelector('button[aria-label="Play"]');
          if (playBtn) { playBtn.click(); return { played: true }; }
          return { played: false, url: location.href };
        })()`;

        chrome.debugger.sendCommand(
          { tabId },
          'Runtime.evaluate',
          { expression: code, returnByValue: true },
          (res) => {
            console.log('Runtime.evaluate result', res);
            // Detach when done so the tab is usable by devtools again.
            chrome.debugger.detach({ tabId }, () => {});
          }
        );
      });
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'attachAndRun') {
    attachAndRun();
    sendResponse({ status: 'started' });
  }
});

chrome.action.onClicked.addListener((tab) => {
  attachAndRun();
});
