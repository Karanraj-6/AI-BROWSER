// Use the global `chrome` provided by the extension environment and @types/chrome
declare const chrome: any;

export class MCPClient {
  private sendContentAction(tabId: number, action: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (typeof tabId !== 'number') {
        reject(new Error('tab-id-required'));
        return;
      }

      chrome.tabs.sendMessage(tabId, { type: 'CONTENT_ACTION', payload: action }, (response: any) => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  // Handle a named action and return a result object.
  async handleAction(action: any): Promise<any> {
    try {
      switch (action.type) {
        case 'NAVIGATE': {
          // If a tabId is provided, update that tab. Otherwise update the active tab.
          if (typeof action.tabId === 'number') {
            await chrome.tabs.update(action.tabId, { url: action.url });
          } else {
            await chrome.tabs.update({ url: action.url });
          }
          return { success: true };
        }

        case 'CLICK': {
          return await this.sendContentAction(action.tabId, {
            type: 'CLICK',
            selector: action.selector
          });
        }

        case 'FILL': {
          return await this.sendContentAction(action.tabId, {
            type: 'FILL',
            selector: action.selector,
            value: action.value
          });
        }

        case 'EVALUATE_SCRIPT': {
          // Run arbitrary JS in the page via the content script.
          return await this.sendContentAction(action.tabId, {
            type: 'EVALUATE_SCRIPT',
            code: action.code
          });
        }

        case 'TAKE_SCREENSHOT': {
          // Capture visible tab. Returns a data URL.
          // If a windowId is provided use it, otherwise use current window.
          const dataUrl = await chrome.tabs.captureVisibleTab(action.windowId ?? undefined, { format: 'png' });
          return { success: true, dataUrl };
        }

        default:
          return { success: false, error: `unknown-action:${action.type}` };
      }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  }
}