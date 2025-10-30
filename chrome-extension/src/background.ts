// Background service worker glue logic
// Use the global `chrome` provided by the extension environment and @types/chrome
declare const chrome: any;
import { MCPClient } from './lib/mcp-client';
import { MCPBridge, type MCPBridgeStatus } from './lib/mcp-bridge';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type PlanStep = {
  type: string;
  params?: Record<string, any>;
};

const STORAGE_KEYS = {
  GEMINI_KEY: 'geminiKey',
  AUTO_MODE: 'autoMode',
};

const GEMINI_MODEL = 'gemini-2.5-flash';
const MCP_WS_URL = 'ws://127.0.0.1:8080';

const mcp = new MCPClient();
const remoteMcp = new MCPBridge(MCP_WS_URL);

const readFromStorage = (keys: string[]): Promise<Record<string, any>> =>
  new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result: any) => {
      const lastError = chrome.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(result || {});
    });
  });

const writeToStorage = (values: Record<string, any>): Promise<void> =>
  new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const lastError = chrome.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });

const notifyPopup = (type: string, payload: any) => {
  chrome.runtime.sendMessage({ type, payload });
};

const getActiveTabId = async (): Promise<number | undefined> => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id;
};

type ActiveTabContext = {
  id?: number;
  url?: string;
  title?: string;
} | null;

const getActiveTabContext = async (): Promise<ActiveTabContext> => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  if (!tab) {
    return null;
  }
  return {
    id: tab.id,
    url: tab.url ?? undefined,
    title: tab.title ?? undefined,
  };
};

const buildLocalPagesSummary = async (activeTabId?: number): Promise<string | null> => {
  const tabs = await chrome.tabs.query({});
  if (!tabs?.length) {
    return null;
  }
  const lines: string[] = ['# list_pages response', '## Pages'];
  tabs.forEach((tab: any, index: number) => {
    const url = tab?.url ?? 'about:blank';
    const title = tab?.title ? ` (${tab.title})` : '';
    const isSelected = Boolean(tab?.active) || (typeof activeTabId === 'number' && tab?.id === activeTabId);
    lines.push(`${index}: ${url}${title}${isSelected ? ' [selected]' : ''}`);
  });
  return lines.join('\n');
};

const buildGeminiPayload = (
  history: ChatMessage[],
  prompt: string,
  remoteStatus: MCPBridgeStatus,
  tabContext: ActiveTabContext,
  pageSummary: string | null,
) => {
  const contents = history.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: prompt }] });
  const tabHint = tabContext?.url
    ? `Active tab: ${tabContext.title ?? 'Untitled'} (${tabContext.url}). Always begin automation by emitting CALL_TOOL extension_select_page with { "url": "${tabContext.url}" } so the MCP operates on the existing tab.\n`
    : 'Always begin automation by selecting the current tab via CALL_TOOL extension_select_page before other actions.\n';
  const remoteInstruction =
    remoteStatus === 'connected'
      ? `${tabHint}The model is authorized to call any tool exposed by the Chrome DevTools MCP server. Use exact tool identifiers when emitting CALL_TOOL (for example: list_pages, select_page, navigate_page, new_page, extension_click_selector, extension_fill_selector, extension_evaluate_script, etc.). Decide which tools to use based on the user's request and combine them as needed — you do not need to ask for permission before calling tools. Prefer operating inside the user's current Chrome window and navigate within the active tab when possible; open new tabs/pages only when necessary. Wait for navigations to complete before interacting and always select a page (select_page or extension_select_page) only after it is actually open. If an action is potentially destructive (closing pages, deleting data), proceed only if the user explicitly requested it.`
      : 'The Chrome DevTools MCP bridge is currently unavailable. Do not emit CALL_TOOL steps.';
  const pagesInstruction = pageSummary
    ? `Current open tabs/windows (from list_pages):
${pageSummary}
Use these entries to decide whether navigation is required before selecting a page.
`
    : '';
  return {
    contents,
    systemInstruction: {
      parts: [
        {
          text:
            'You are an automation planner for a Chrome extension. Always respond with JSON matching this schema:\n' +
            '{\n' +
            '  "reply": string,\n' +
            '  "plan": [\n' +
            '    { "type": "NAVIGATE" | "CLICK" | "FILL" | "EVALUATE_SCRIPT" | "TAKE_SCREENSHOT" | "CALL_TOOL", "params": object }\n' +
            '  ]\n' +
            '}\n' +
            'Only include supported action types. Leave "plan" empty if no browser action is required. Prefer short, factual replies. ' +
            remoteInstruction +
            pagesInstruction,
        },
      ],
    },
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
    },
  };
};

const extractJson = (text: string) => {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  const withoutFence = trimmed.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(withoutFence);
  } catch (error) {
    try {
      const first = withoutFence.indexOf('{');
      const last = withoutFence.lastIndexOf('}');
      if (first !== -1 && last !== -1 && last > first) {
        return JSON.parse(withoutFence.slice(first, last + 1));
      }
    } catch (_) {
      // fall-through
    }
  }
  return null;
};

const callGemini = async (prompt: string, history: ChatMessage[]): Promise<{ reply: string; plan: PlanStep[] }> => {
  const { [STORAGE_KEYS.GEMINI_KEY]: apiKey } = await readFromStorage([STORAGE_KEYS.GEMINI_KEY]);
  if (!apiKey) {
    throw new Error('missing-gemini-key');
  }

  const tabContext = await getActiveTabContext();
  const pageSummary = await buildLocalPagesSummary(tabContext?.id);
  const payload = buildGeminiPayload(history, prompt, remoteMcp.getStatus(), tabContext, pageSummary);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`gemini-error:${response.status}:${bodyText || response.statusText}`);
  }

  const body = await response.json();
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const parsed = extractJson(text);
  if (!parsed || typeof parsed.reply !== 'string' || !Array.isArray(parsed.plan)) {
    return {
      reply: text || 'I was unable to create a plan.',
      plan: [],
    };
  }
  return {
    reply: parsed.reply,
    plan: parsed.plan.filter((step: any) => step && typeof step.type === 'string'),
  };
};

const executePlan = async (plan: PlanStep[], tabId?: number) => {
  const results: any[] = [];
  const tabContext = await getActiveTabContext();
  for (let index = 0; index < plan.length; index += 1) {
    const step = plan[index];
    notifyPopup('LLM_PROGRESS', {
      status: 'running',
      index,
      step,
    });
    try {
      const mergedParams = step?.params && typeof step.params === 'object' ? step.params : {};
      let actionResult: any;
      if (step.type === 'CALL_TOOL') {
        let toolName =
          mergedParams.tool ||
          mergedParams.toolName ||
          // support snake_case from some LLM outputs
          (mergedParams as any).tool_name ||
          mergedParams.name ||
          (step as any).tool ||
          (step as any).toolName ||
          (step as any).tool_name;
        let toolArgs: Record<string, any> | undefined;
        if (!toolName) {
          // Attempt to infer the intended tool from common parameter shapes to reduce
          // failures when the model emits an incomplete CALL_TOOL. This is a best-effort
          // fallback and may be incorrect for complex plans.
          let inferredName: string | null = null;
          let inferredArgs: any = {};
          if (mergedParams?.selector) {
            if (mergedParams?.value !== undefined) {
              inferredName = 'extension_fill_selector';
              inferredArgs = { selector: mergedParams.selector, value: mergedParams.value };
            } else {
              inferredName = 'extension_click_selector';
              inferredArgs = { selector: mergedParams.selector };
            }
          } else if (mergedParams?.url) {
            // Prefer navigating the current page rather than opening new pages.
            inferredName = 'navigate_page';
            inferredArgs = { type: 'url', url: mergedParams.url };
          } else if (mergedParams?.code) {
            inferredName = 'extension_evaluate_script';
            inferredArgs = { code: mergedParams.code };
          } else if (mergedParams?.text && typeof mergedParams.text === 'string') {
            // Generic text might be intended for a fill
            inferredName = 'extension_fill_selector';
            inferredArgs = { selector: mergedParams.selector ?? 'input', value: mergedParams.text };
          }

          if (inferredName) {
            notifyPopup('LLM_WARNING', {
              message: 'CALL_TOOL missing tool name — inferring tool',
              inferredTool: inferredName,
              originalStep: step,
            });
            toolName = inferredName;
            toolArgs = inferredArgs;
          } else {
            throw new Error('call-tool-missing-name');
          }
        }
        // Normalize and collect tool arguments from multiple possible shapes the model may emit.
        const stepAny: any = step as any;
        const mergedAny: any = mergedParams as any;
        if (!toolArgs) {
          toolArgs =
            mergedParams.arguments ||
            // support common alternate names
            (mergedParams as any).tool_params ||
            (mergedParams as any).toolParams ||
            mergedParams.args ||
            (step as any).arguments ||
            (step as any).args ||
            (step as any).tool_params ||
            (step as any).toolParams ||
            {};
        }

        // If the model put parameters at the top-level of the step (e.g. { "tool_name": "extension_select_page", "url": "..." })
        // pull common fields through so the MCP tool receives the expected shape.
        if (!toolArgs || Object.keys(toolArgs).length === 0) {
          if (stepAny.url) {
            toolArgs = {...toolArgs, url: stepAny.url};
          }
          if (mergedAny.url) {
            toolArgs = {...toolArgs, url: mergedAny.url};
          }
          if (stepAny.selector) {
            toolArgs = {...toolArgs, selector: stepAny.selector};
          }
          if (stepAny.value) {
            toolArgs = {...toolArgs, value: stepAny.value};
          }
          if (stepAny.code) {
            toolArgs = {...toolArgs, code: stepAny.code};
          }
          // Merge nested tool_params if present at root
          if (stepAny.tool_params && typeof stepAny.tool_params === 'object') {
            toolArgs = { ...toolArgs, ...stepAny.tool_params };
          }
          if (mergedAny.tool_params && typeof mergedAny.tool_params === 'object') {
            toolArgs = { ...toolArgs, ...mergedAny.tool_params };
          }
        } else {
          // Even if toolArgs is non-empty, prefer explicit top-level url/selector/value if provided
          if (stepAny.url) toolArgs.url = stepAny.url;
          if (mergedAny.url) toolArgs.url = mergedAny.url;
        }

        // Debug: announce the resolved tool name and args so callers can audit
        try {
          // Send an in-extension debug notification and also log to the console.
          notifyPopup('LLM_DEBUG', {
            message: 'Resolved CALL_TOOL',
            index,
            step,
            toolName,
            toolArgs,
          });
        } catch (e) {
          // ignore popup notify failures
        }
        // Console log is useful for local development and when examining service-worker logs.
        // eslint-disable-next-line no-console
        console.debug('[MCP DEBUG] CALL_TOOL resolved', { index, toolName, toolArgs, step });

        // Map common extension/pages tools to local mcp actions so we can operate within
        // the user's current Chrome window without involving the MCP server (which may
        // launch a new browser). If a mapping exists, perform the local action instead.
        const lname = String(toolName || '').toLowerCase();
        const isExtensionTool = lname.startsWith('extension_');
        const isPagesTool = lname.startsWith('pages_') || lname === 'new_page' || lname === 'navigate_page' || lname === 'list_pages' || lname === 'select_page';

        const extract = (k: string) => (toolArgs && toolArgs[k] !== undefined ? toolArgs[k] : (step as any)[k] ?? (mergedParams as any)[k]);

        if (isPagesTool) {
          // Handle navigation/new_page/select_page locally when possible
          if (lname === 'new_page') {
            const url = extract('url');
            const forceNew = Boolean(extract('forceNew')) || Boolean(extract('force_new'));
            if (!url) {
              // No URL: block because we must not open a new window/tab without explicit user intent.
              notifyPopup('LLM_WARNING', { message: 'Blocked request to open a new page without URL.' , index, step});
              throw new Error('blocked-new-page-without-url');
            }
            if (forceNew) {
              // Respect explicit forceNew only if the MCP bridge is connected; otherwise block.
              if (!remoteMcp.isConnected()) {
                notifyPopup('LLM_WARNING', { message: 'Attempted force-new but MCP bridge not connected; blocked.', index, step});
                throw new Error('blocked-new-page-force-new-bridge-off');
              }
              actionResult = await remoteMcp.callTool('new_page', toolArgs);
            } else {
              // Navigate current tab instead of opening a new page.
              actionResult = await mcp.handleAction({ type: 'NAVIGATE', url, tabId });
            }
          } else if (lname === 'navigate_page' || lname === 'pages_navigate' || lname === 'pages_navigate_page') {
            const url = extract('url');
            if (!url) {
              throw new Error('navigate-missing-url');
            }
            actionResult = await mcp.handleAction({ type: 'NAVIGATE', url, tabId });
          } else if (lname === 'list_pages') {
            // list_pages is MCP-only: call remote if available, otherwise synthesize a minimal response.
            const summary = await buildLocalPagesSummary(tabContext?.id);
            const summaryText = summary ?? `# list_pages response\n## Pages\n0: ${tabContext?.url ?? 'about:blank'} [selected]`;
            actionResult = { content: [{ type: 'text', text: summaryText }] };
          } else if (lname === 'select_page' || lname === 'extension_select_page') {
            const url = extract('url') ?? extract('pageUrl') ?? extract('page');
            if (!url) {
              throw new Error('select-page-missing-url');
            }
            // Instead of selecting another tab, navigate the current tab to the requested URL.
            actionResult = await mcp.handleAction({ type: 'NAVIGATE', url, tabId });
          } else {
            // Unknown pages tool: forward to MCP if available
            if (!remoteMcp.isConnected()) {
              throw new Error('mcp-bridge-not-connected');
            }
            actionResult = await remoteMcp.callTool(toolName, toolArgs);
          }
        } else if (isExtensionTool) {
          // Map extension_* tools to local content-script actions
          if (lname.includes('click') && extract('selector')) {
            actionResult = await mcp.handleAction({ type: 'CLICK', selector: extract('selector'), tabId });
          } else if (lname.includes('fill') && extract('selector')) {
            actionResult = await mcp.handleAction({ type: 'FILL', selector: extract('selector'), value: extract('value') ?? extract('text') ?? extract('v') , tabId });
          } else if (lname.includes('evaluate') && extract('code')) {
            actionResult = await mcp.handleAction({ type: 'EVALUATE_SCRIPT', code: extract('code'), tabId });
          } else if (lname.includes('select_page')) {
            const url = extract('url') ?? extract('pageUrl') ?? extract('page');
            if (!url) {
              throw new Error('select-page-missing-url');
            }
            actionResult = await mcp.handleAction({ type: 'NAVIGATE', url, tabId });
          } else {
            // Unknown extension tool: forward if bridge available
            if (!remoteMcp.isConnected()) {
              throw new Error('mcp-bridge-not-connected');
            }
            actionResult = await remoteMcp.callTool(toolName, toolArgs);
          }
        } else {
          // Not a pages/extension tool: must call MCP bridge
          if (!remoteMcp.isConnected()) {
            throw new Error('mcp-bridge-not-connected');
          }
          actionResult = await remoteMcp.callTool(toolName, toolArgs);
        }
        if (actionResult && (actionResult.isError || actionResult.success === false)) {
          const messageFromContent = Array.isArray(actionResult.content)
            ? actionResult.content.find((part: any) => part && typeof part.text === 'string')?.text
            : undefined;
          const errorMessage =
            messageFromContent || actionResult.error || actionResult.message || 'CALL_TOOL failed';
          throw new Error(errorMessage);
        }
      } else {
        actionResult = await mcp.handleAction({ ...mergedParams, type: step.type, tabId });
      }
      results.push({ success: true, result: actionResult });
      notifyPopup('LLM_PROGRESS', {
        status: 'completed',
        index,
        step,
        result: actionResult,
      });
    } catch (error: any) {
      results.push({ success: false, error: error?.message ?? String(error) });
      notifyPopup('LLM_PROGRESS', {
        status: 'failed',
        index,
        step,
        error: error?.message ?? String(error),
      });
      break;
    }
  }
  return results;
};

const handleLLMRequest = async (payload: any) => {
  const { prompt, history = [], autoMode = false, tabId: providedTabId } = payload || {};
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('invalid-prompt');
  }

  const tabId = typeof providedTabId === 'number' ? providedTabId : await getActiveTabId();
  const result = await callGemini(prompt, history);

  notifyPopup('LLM_PLAN', { plan: result.plan, reply: result.reply });

  let execution: any[] | undefined;
  if (autoMode && result.plan.length > 0) {
    execution = await executePlan(result.plan, tabId);
  }

  return {
    success: true,
    reply: result.reply,
    plan: result.plan,
    execution,
  };
};

const handleExecutePlan = async (payload: any) => {
  const { plan = [], tabId: providedTabId } = payload || {};
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error('empty-plan');
  }
  const tabId = typeof providedTabId === 'number' ? providedTabId : await getActiveTabId();
  const execution = await executePlan(plan, tabId);
  return { success: true, execution };
};

const handleSaveSettings = async (payload: any) => {
  const updates: Record<string, any> = {};
  if (typeof payload?.geminiKey === 'string') {
    updates[STORAGE_KEYS.GEMINI_KEY] = payload.geminiKey.trim();
  }
  if (typeof payload?.autoMode === 'boolean') {
    updates[STORAGE_KEYS.AUTO_MODE] = payload.autoMode;
  }
  if (!Object.keys(updates).length) {
    return { success: true };
  }
  await writeToStorage(updates);
  return { success: true };
};

const handleGetSettings = async () => {
  const values = await readFromStorage([STORAGE_KEYS.GEMINI_KEY, STORAGE_KEYS.AUTO_MODE]);
  return {
    success: true,
    geminiKey: values?.[STORAGE_KEYS.GEMINI_KEY] ?? null,
    autoMode: values?.[STORAGE_KEYS.AUTO_MODE] ?? false,
    mcpStatus: remoteMcp.getStatus(),
  };
};

const handleCallTool = async (payload: any) => {
  const { tool, toolName, name, arguments: args, params } = payload || {};
  const resolvedTool = tool || toolName || name || params?.tool;
  const resolvedArgs = args ?? params?.arguments ?? payload?.args ?? {};
  if (!resolvedTool) {
    throw new Error('tool-required');
  }
  const result = await remoteMcp.callTool(resolvedTool, resolvedArgs);
  return { success: true, result };
};

// Listen for messages from popup and orchestrate logic
chrome.runtime.onMessage.addListener((request: any, _sender: any, sendResponse: any) => {
  const { type, payload } = request || {};
  if (!type) {
    return undefined;
  }

  const respond = (promise: Promise<any>) => {
    promise
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error?.message ?? String(error) }));
  };

  switch (type) {
    case 'MCP_ACTION':
      respond(mcp.handleAction(payload));
      return true;
    case 'LLM_REQUEST':
      respond(handleLLMRequest(payload));
      return true;
    case 'EXECUTE_PLAN':
      respond(handleExecutePlan(payload));
      return true;
    case 'SAVE_SETTINGS':
      respond(handleSaveSettings(payload));
      return true;
    case 'GET_SETTINGS':
      respond(handleGetSettings());
      return true;
    case 'MCP_CALL_TOOL':
      respond(handleCallTool(payload));
      return true;
    default:
      sendResponse({ success: false, error: `unknown-message:${type}` });
      return undefined;
  }
});

remoteMcp.onStatusChange((status) => {
  notifyPopup('MCP_STATUS', { status });
});

remoteMcp.onNotification((notification) => {
  notifyPopup('MCP_NOTIFICATION', notification);
});