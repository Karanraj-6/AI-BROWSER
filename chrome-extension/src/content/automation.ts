// Content script handling DOM-level automation actions.
// The file listens for messages from the background script and executes
// the requested operation in the page context.
type AutomationAction =
  | { type: 'CLICK'; selector: string }
  | { type: 'FILL'; selector: string; value: string }
  | { type: 'EVALUATE_SCRIPT'; code: string };

const waitForDocumentReady = async (): Promise<void> => {
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    return;
  }

  await new Promise<void>((resolve) => {
    const handleStateChange = () => {
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        document.removeEventListener('readystatechange', handleStateChange);
        resolve();
      }
    };
    document.addEventListener('readystatechange', handleStateChange);
  });
};

const waitForElement = async (selector: string, timeout = 15000): Promise<Element | null> => {
  await waitForDocumentReady();

  const locate = () => document.querySelector(selector);
  const immediate = locate();
  if (immediate) {
    return immediate;
  }

  return new Promise((resolve) => {
    let resolved = false;
    let observer: MutationObserver | null = null;
    let pollId: number | null = null;
    let timeoutId: number | null = null;

    const cleanup = () => {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (pollId !== null) {
        clearInterval(pollId);
        pollId = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const finish = (element: Element | null) => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      resolve(element);
    };

    const check = () => {
      const element = locate();
      if (element) {
        finish(element);
        return true;
      }
      return false;
    };

    observer = new MutationObserver(() => {
      check();
    });

    const observerTarget = document.body ?? document.documentElement;
    if (observerTarget) {
      observer.observe(observerTarget, { childList: true, subtree: true });
    }

    pollId = window.setInterval(() => {
      check();
    }, 200);

    timeoutId = window.setTimeout(() => {
      finish(null);
    }, timeout);

    check();
  });
};

const handleAction = async (action: AutomationAction): Promise<any> => {
  switch (action.type) {
    case 'CLICK': {
      const element = await waitForElement(action.selector) as HTMLElement | null;
      if (!element) {
        return { success: false, error: 'selector-not-found' };
      }
      try {
        element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      } catch (error) {
        // scrollIntoView may throw if the element is detached; ignore and attempt click regardless.
      }
      element.click();
      return { success: true };
    }

    case 'FILL': {
      const input = await waitForElement(action.selector) as (HTMLInputElement | HTMLTextAreaElement | null);
      if (!input) {
        return { success: false, error: 'selector-not-found' };
      }
      if ('value' in input) {
        (input as HTMLInputElement | HTMLTextAreaElement).focus();
        (input as HTMLInputElement | HTMLTextAreaElement).value = action.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true };
      }
      return { success: false, error: 'unsupported-element' };
    }

    case 'EVALUATE_SCRIPT': {
      // eslint-disable-next-line no-eval
      const result = eval(action.code);
      return { success: true, result };
    }

    default:
      return { success: false, error: `unsupported-action:${(action as any)?.type}` };
  }
};

chrome.runtime.onMessage.addListener((request: any, _sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) => {
  if (request?.type === 'CONTENT_ACTION') {
    Promise.resolve(handleAction(request.payload))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error?.message ?? String(error) }));
    return true; // Keep the channel open for the async response.
  }
  return undefined;
});
