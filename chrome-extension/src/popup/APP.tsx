import React, { useEffect, useState } from 'react';
import type { MCPBridgeStatus } from '../lib/mcp-bridge';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type PlanStep = {
  type: string;
  params?: Record<string, any>;
};

type ProgressUpdate = {
  status: 'running' | 'completed' | 'failed';
  index: number;
  step: PlanStep;
  result?: any;
  error?: string;
};

const sendMessage = (message: any): Promise<any> =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: any) => {
      const lastError = chrome.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      if (response && response.success === false && response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });

const queryActiveTabId = async (): Promise<number | undefined> => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id;
};

const formatError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'missing-gemini-key') {
    return 'Add your Google Gemini API key in Settings first.';
  }
  if (message.startsWith('gemini-error')) {
    return 'Gemini request failed. Check the key and try again.';
  }
  if (message === 'empty-plan') {
    return 'No plan available to execute.';
  }
  if (message === 'mcp-disconnected') {
    return 'Connect the Chrome DevTools MCP bridge (npm run dev) before running MCP tools.';
  }
  if (message === 'mcp-timeout') {
    return 'MCP bridge timed out. Confirm the MCP server is running and reachable.';
  }
  if (message === 'call-tool-missing-name') {
    return 'Gemini attempted to call a MCP tool without specifying its name.';
  }
  return message;
};

const describePlanStep = (step?: PlanStep) => {
  if (!step) {
    return 'Action';
  }
  if (step.type === 'CALL_TOOL') {
    const tool = step.params?.tool || step.params?.toolName || step.params?.name;
    return tool ? `${step.type} (${tool})` : step.type;
  }
  return step.type;
};

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<string>('Ready');
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [autoMode, setAutoMode] = useState(false);
  const [progress, setProgress] = useState<ProgressUpdate[]>([]);
  const [planExecution, setPlanExecution] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState('');
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<MCPBridgeStatus>('disconnected');
  const [mcpAddress] = useState('ws://127.0.0.1:8080');

  useEffect(() => {
    sendMessage({ type: 'GET_SETTINGS' })
      .then((response) => {
        if (response) {
          setHasGeminiKey(Boolean(response.geminiKey));
          if (typeof response.autoMode === 'boolean') {
            setAutoMode(response.autoMode);
          }
          if (response.mcpStatus) {
            setMcpStatus(response.mcpStatus);
          }
        }
      })
      .catch((error: Error) => {
        setStatus(formatError(error));
      });
  }, []);

  useEffect(() => {
    const handleRuntimeMessages = (message: any) => {
      if (!message) {
        return;
      }
      if (message.type === 'LLM_PROGRESS') {
        setProgress((prev) => [...prev, message.payload]);
      }
      if (message.type === 'LLM_PLAN') {
        if (Array.isArray(message.payload?.plan)) {
          setPlan(message.payload.plan);
        }
      }
      if (message.type === 'MCP_STATUS' && message.payload?.status) {
        setMcpStatus(message.payload.status);
      }
      if (message.type === 'MCP_NOTIFICATION') {
        // Surface lightweight MCP notifications in status bar without interrupting workflows.
        const text = typeof message.payload?.method === 'string'
          ? `MCP: ${message.payload.method}`
          : 'MCP notification received.';
        setStatus(text);
      }
    };
    chrome.runtime.onMessage.addListener(handleRuntimeMessages);
    return () => {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessages);
    };
  }, []);

  const saveSettings = async (updates: Record<string, any>) => {
    try {
      await sendMessage({ type: 'SAVE_SETTINGS', payload: updates });
      if (updates.geminiKey !== undefined) {
        setHasGeminiKey(Boolean(updates.geminiKey));
        setStatus('Gemini API key saved locally.');
      }
      if (updates.autoMode !== undefined) {
        setAutoMode(Boolean(updates.autoMode));
      }
    } catch (error) {
      setStatus(formatError(error));
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }
    if (!hasGeminiKey) {
      setStatus('Add your Google Gemini API key in Settings first.');
      setShowSettings(true);
      return;
    }

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
  const newHistory = [...messages, userMessage];
    setMessages(newHistory);
    setInput('');
    setLoading(true);
    setStatus('Contacting Gemini...');
    setPlan([]);
    setProgress([]);
    setPlanExecution([]);

    try {
      const tabId = await queryActiveTabId();
      const response = await sendMessage({
        type: 'LLM_REQUEST',
        payload: {
          prompt: trimmed,
          history: newHistory,
          autoMode,
          tabId,
        },
      });

      if (response?.reply) {
        setMessages((prev) => [...prev, { role: 'assistant', content: response.reply }]);
      }
      if (Array.isArray(response?.plan)) {
        setPlan(response.plan);
      }
      if (Array.isArray(response?.execution)) {
        setPlanExecution(response.execution);
      }
      setStatus(autoMode ? 'Auto agent finished.' : 'Plan ready.');
    } catch (error) {
      setStatus(formatError(error));
    } finally {
      setLoading(false);
    }
  };

  const handleRunPlan = async () => {
    if (!plan.length) {
      return;
    }
    setStatus('Running plan...');
    setProgress([]);
    setPlanExecution([]);
    try {
      const tabId = await queryActiveTabId();
      const response = await sendMessage({
        type: 'EXECUTE_PLAN',
        payload: { plan, tabId },
      });
      if (Array.isArray(response?.execution)) {
        setPlanExecution(response.execution);
      }
      setStatus('Plan execution completed.');
    } catch (error) {
      setStatus(formatError(error));
    }
  };

  const handleSaveGeminiKey = async () => {
    const trimmed = geminiKeyInput.trim();
    if (!trimmed) {
      setStatus('Enter a valid Gemini API key.');
      return;
    }
    await saveSettings({ geminiKey: trimmed });
    setGeminiKeyInput('');
  };

  const toggleAutoMode = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const checked = event.target.checked;
    setAutoMode(checked);
    await saveSettings({ autoMode: checked });
    setStatus(checked ? 'Auto agent will execute plans automatically.' : 'Manual approval required to run plans.');
  };

  const renderPlanStep = (step: PlanStep, index: number) => (
    <li key={`${step.type}-${index}`} className="plan-step">
      <div className="plan-step__title">
        <strong>{index + 1}.</strong> {describePlanStep(step)}
      </div>
      {step.params ? (
        <pre className="plan-step__params">{JSON.stringify(step.params, null, 2)}</pre>
      ) : null}
    </li>
  );

  const renderProgress = (update: ProgressUpdate, index: number) => (
    <li key={`progress-${index}`} className={`progress-item progress-item--${update.status}`}>
      <span>
        Step {update.index + 1}: {describePlanStep(update.step)} — {update.status.toUpperCase()}
      </span>
      {update.error ? <span className="progress-item__error">{update.error}</span> : null}
      {update.result ? (
        <pre className="progress-item__result">{JSON.stringify(update.result, null, 2)}</pre>
      ) : null}
    </li>
  );

  const renderExecutionResult = (entry: any, index: number) => (
    <li key={`exec-${index}`} className={`progress-item ${entry.success ? 'progress-item--completed' : 'progress-item--failed'}`}>
      <span>
        Step {index + 1}: {describePlanStep(plan[index])} {entry.success ? '✅' : '❌'}
      </span>
      {entry.error ? <span className="progress-item__error">{entry.error}</span> : null}
      {entry.result ? (
        <pre className="progress-item__result">{JSON.stringify(entry.result, null, 2)}</pre>
      ) : null}
    </li>
  );

  return (
    <div className="popup-root">
      <header className="popup-header">
        <h1>MCP Agent</h1>
        <div className={`mcp-status mcp-status--${mcpStatus}`}>
          <span className="mcp-status__dot" />
          <span>{mcpStatus === 'connected' ? 'MCP connected' : mcpStatus === 'connecting' ? 'MCP connecting…' : 'MCP disconnected'}</span>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={autoMode} onChange={toggleAutoMode} />
          <span>Auto agent</span>
        </label>
      </header>

      <section className="settings">
        <button className="link-button" onClick={() => setShowSettings((prev) => !prev)}>
          {showSettings ? 'Hide settings' : 'Show settings'}
        </button>
        {showSettings ? (
          <div className="settings__content">
            <label className="input-group">
              <span>Google Gemini API key</span>
              <input
                type="password"
                value={geminiKeyInput}
                placeholder={hasGeminiKey ? 'Key is stored locally. Enter to replace.' : 'Paste your API key'}
                onChange={(event) => setGeminiKeyInput(event.target.value)}
              />
            </label>
            <button className="primary" onClick={handleSaveGeminiKey}>Save key</button>
            <p className="settings__hint">Keys stay on this device only.</p>
            <p className="settings__hint">
              MCP bridge URL: {mcpAddress} ({mcpStatus})
            </p>
          </div>
        ) : null}
      </section>

      <section className="chat-log">
        {messages.map((message, index) => (
          <div key={`message-${index}`} className={`chat-message chat-message--${message.role}`}>
            <div className="chat-message__role">{message.role === 'user' ? 'You' : 'Agent'}</div>
            <div className="chat-message__content">{message.content}</div>
          </div>
        ))}
        {!messages.length ? <p className="empty-state">Ask the agent to automate a task in the current tab.</p> : null}
      </section>

      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="e.g., Open Gmail and draft a new email"
          rows={3}
          disabled={loading}
        />
        <button type="submit" className="primary" disabled={loading}>
          {loading ? 'Thinking…' : 'Send'}
        </button>
      </form>

      {plan.length > 0 && !autoMode ? (
        <section className="plan">
          <div className="section-header">
            <h2>Proposed plan</h2>
            <button className="primary" onClick={handleRunPlan}>Run plan</button>
          </div>
          <ol className="plan-list">{plan.map(renderPlanStep)}</ol>
        </section>
      ) : null}

      {progress.length > 0 ? (
        <section className="progress">
          <h2>Progress</h2>
          <ul className="progress-list">{progress.map(renderProgress)}</ul>
        </section>
      ) : null}

      {planExecution.length > 0 ? (
        <section className="progress">
          <h2>Execution summary</h2>
          <ul className="progress-list">{planExecution.map(renderExecutionResult)}</ul>
        </section>
      ) : null}

      <footer className="status-bar">{status}</footer>
    </div>
  );
}

export default App;