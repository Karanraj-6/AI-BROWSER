// Helper that maintains a WebSocket connection to a remote Chrome DevTools MCP
// instance and exposes a simple request/response API for JSON-RPC calls. The
// bridge now supports dynamic reconfiguration so the extension can target a
// hosted MCP endpoint instead of a local native process.

export type MCPBridgeStatus = 'connecting' | 'connected' | 'disconnected';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: any;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string;
  result: any;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string;
  error: {
    code: number;
    message: string;
    data?: any;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeoutId?: number;
};

const RECONNECT_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;

const normalizeUrl = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

export class MCPBridge {
  private url: string | null = null;
  private status: MCPBridgeStatus = 'disconnected';
  private socket: WebSocket | null = null;
  private reconnectTimer: number | undefined;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private statusListeners = new Set<(status: MCPBridgeStatus) => void>();
  private notificationListeners = new Set<(payload: any) => void>();

  constructor(initialUrl?: string | null) {
    if (initialUrl) {
      this.setUrl(initialUrl);
    }
  }

  setUrl(next: string | null) {
    const normalized = normalizeUrl(next);
    if (this.url === normalized) {
      if (normalized && !this.socket) {
        this.connect();
      }
      if (!normalized) {
        this.teardown(new Error('MCP bridge disabled by configuration.'), { suppressReconnect: true });
      }
      return;
    }

    this.url = normalized;

    if (!this.url) {
      this.teardown(new Error('MCP bridge disabled by configuration.'), { suppressReconnect: true });
      return;
    }

    this.teardown(new Error('Reconfiguring MCP bridge endpoint.'), { suppressReconnect: true });
    this.connect();
  }

  getUrl(): string | null {
    return this.url;
  }

  private connect() {
    if (!this.url) {
      this.updateStatus('disconnected');
      return;
    }
    if (this.socket || this.status === 'connecting') {
      return;
    }

    this.clearReconnectTimer();
    this.updateStatus('connecting');
    try {
      this.socket = new WebSocket(this.url);
    } catch (error) {
      this.teardown(error as Error);
      return;
    }

    this.socket.addEventListener('open', () => {
      this.updateStatus('connected');
    });

    this.socket.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });

    this.socket.addEventListener('error', () => {
      // Errors are followed by close; no extra handling needed here.
    });

    this.socket.addEventListener('close', () => {
      this.teardown();
    });
  }

  private teardown(error?: Error, options: { suppressReconnect?: boolean } = {}) {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (closeError) {
        // Best effort only; ignore close failures.
      }
    }
    this.socket = null;
    this.updateStatus('disconnected');

    for (const [id, pending] of this.pending.entries()) {
      pending.reject(
        error ?? new Error('MCP bridge disconnected before response arrived.'),
      );
      if (pending.timeoutId !== undefined) {
        clearTimeout(pending.timeoutId);
      }
      this.pending.delete(id);
    }

    if (options.suppressReconnect || !this.url) {
      this.clearReconnectTimer();
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== undefined || !this.url) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, RECONNECT_DELAY_MS) as unknown as number;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private handleMessage(raw: string) {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch (parseError) {
      console.warn('Ignoring non-JSON message from MCP bridge', raw);
      return;
    }

    if (typeof data?.id === 'string' || typeof data?.id === 'number') {
      const key = String(data.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      this.pending.delete(key);
      if (pending.timeoutId !== undefined) {
        clearTimeout(pending.timeoutId);
      }
      if ('error' in data && data.error) {
        const message = data.error.message ?? 'Unknown MCP error';
        pending.reject(new Error(message));
      } else if ('result' in data) {
        pending.resolve(data.result);
      } else {
        pending.resolve(undefined);
      }
      return;
    }

    for (const listener of this.notificationListeners) {
      try {
        listener(data);
      } catch (listenerError) {
        console.error('MCP notification listener failed', listenerError);
      }
    }
  }

  private updateStatus(next: MCPBridgeStatus) {
    if (this.status === next) {
      return;
    }
    this.status = next;
    for (const listener of this.statusListeners) {
      try {
        listener(next);
      } catch (listenerError) {
        console.error('MCP status listener failed', listenerError);
      }
    }
  }

  onStatusChange(listener: (status: MCPBridgeStatus) => void) {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onNotification(listener: (payload: any) => void) {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  getStatus(): MCPBridgeStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  reconnectNow() {
    if (!this.url) {
      this.updateStatus('disconnected');
      return;
    }
    if (this.socket) {
      this.socket.close();
    } else {
      this.connect();
    }
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    if (!this.isConnected()) {
      throw new Error('mcp-disconnected');
    }
    return this.sendRequest('tools/call', {
      name,
      arguments: args,
    });
  }

  private sendRequest(method: string, params?: any) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('mcp-disconnected');
    }

    const id = String(this.nextId++);
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('mcp-timeout'));
      }, REQUEST_TIMEOUT_MS) as unknown as number;

      this.pending.set(id, { resolve, reject, timeoutId });
      try {
        this.socket?.send(JSON.stringify(request));
      } catch (sendError) {
        this.pending.delete(id);
        clearTimeout(timeoutId);
        reject(sendError);
      }
    });
  }
}
