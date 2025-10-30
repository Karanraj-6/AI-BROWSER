// Use the global `chrome` provided by the extension environment and @types/chrome
declare const chrome: any;

export class MCPClient {
  private async waitForTabLoad(tabId: number | undefined, timeoutMs = 20000): Promise<void> {
    if (typeof tabId !== 'number') {
      return;
    }
    const settle = async () => {
      // Give the page a short window to run microtasks even after the load event.
      await new Promise((resolve) => setTimeout(resolve, 150));
    };
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === 'complete') {
        await settle();
        return;
      }
    } catch (error) {
      // If the tab cannot be retrieved treat as non-blocking.
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('navigation-timeout'));
      }, timeoutMs);

      const listener = (updatedTabId: number, changeInfo: any) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          clearTimeout(timeoutId);
          chrome.tabs.onUpdated.removeListener(listener);
          settle().then(resolve).catch(resolve);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  }

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
          const updatedTab =
            typeof action.tabId === 'number'
              ? await chrome.tabs.update(action.tabId, {url: action.url})
              : await chrome.tabs.update({url: action.url});

          const targetTabId = typeof action.tabId === 'number' ? action.tabId : updatedTab?.id;
          try {
            await this.waitForTabLoad(targetTabId);
          } catch (error) {
            console.warn('Timed out waiting for navigation', error);
          }
          return { success: true };
        }

        case 'CLICK': {
          await this.waitForTabLoad(action.tabId);
          return await this.sendContentAction(action.tabId, {
            type: 'CLICK',
            selector: action.selector
          });
        }

        case 'FILL': {
          await this.waitForTabLoad(action.tabId);
          return await this.sendContentAction(action.tabId, {
            type: 'FILL',
            selector: action.selector,
            value: action.value
          });
        }

        case 'EVALUATE_SCRIPT': {
          await this.waitForTabLoad(action.tabId);
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