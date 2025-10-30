// Content script handling DOM-level automation actions.
// The file listens for messages from the background script and executes
// the requested operation in the page context.
type AutomationAction =
  | { type: 'CLICK'; selector: string }
  | { type: 'FILL'; selector: string; value: string }
  | { type: 'EVALUATE_SCRIPT'; code: string };

const waitForElement = async (selector: string, timeout = 5000): Promise<Element | null> => {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};

const handleAction = async (action: AutomationAction): Promise<any> => {
  switch (action.type) {
    case 'CLICK': {
      const element = await waitForElement(action.selector, 5000) as HTMLElement | null;
      if (!element) {
        return { success: false, error: 'selector-not-found' };
      }
      element.click();
      return { success: true };
    }

    case 'FILL': {
      const input = await waitForElement(action.selector, 5000) as (HTMLInputElement | HTMLTextAreaElement | null);
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
