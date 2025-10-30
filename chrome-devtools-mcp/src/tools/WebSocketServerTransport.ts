type WsModule = typeof import('ws');
// If @types/ws isn't installed, silence a few implicit any complaints in this helper.
// The project can add '@types/ws' as a dev dependency if strict typing is desired.

// Minimal transport implementation that mirrors the StdioServerTransport API
// used by the MCP Server. It accepts a single WebSocket client and forwards
// JSON-RPC messages between the WS client and the MCP Server.
export class WebSocketServerTransport {
  public onmessage: ((msg: any) => void) | undefined;
  public onerror: ((err: Error) => void) | undefined;
  public onclose: (() => void) | undefined;

  private wss: any | undefined;
  private socket: any | undefined;
  private port: number;
  private wsModule: WsModule | null = null;

  constructor(port = 8080, host = '127.0.0.1') {
    this.port = port;
    this._host = host;
  }

  private _host: string;

  async start(): Promise<void> {
    if (this.wss) return;
    const wsModule = await this.loadModule();
    const WebSocketServerCtor =
      (wsModule as any).WebSocketServer ?? (wsModule as any).Server ?? (wsModule.default as any)?.Server;
    if (!WebSocketServerCtor) {
      throw new Error('WebSocket module did not expose a server constructor');
    }
    this.wss = new WebSocketServerCtor({host: this._host, port: this.port});
    this.wss.on('connection', (ws: any) => {
      // Accept a single client; replace any existing socket
      this.socket = ws;
      ws.on('message', (data: any) => {
        try {
          const text = typeof data === 'string' ? data : data.toString();
          const msg = JSON.parse(text);
          this.onmessage && this.onmessage(msg);
        } catch (e) {
          this.onerror && this.onerror(e instanceof Error ? e : new Error(String(e)));
        }
      });
      ws.on('close', () => {
        this.socket = undefined;
        this.onclose && this.onclose();
      });
      ws.on('error', (err: any) => {
        this.onerror && this.onerror(err instanceof Error ? err : new Error(String(err)));
      });
    });
    return new Promise((resolve, reject) => {
      this.wss!.on('listening', () => resolve());
      this.wss!.on('error', (err: any) => reject(err));
    });
  }

  async close(): Promise<void> {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {}
      this.socket = undefined;
    }
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = undefined;
    }
    this.onclose && this.onclose();
  }

  async send(message: any): Promise<void> {
    const wsModule = await this.loadModule();
    const WebSocketCtor = (wsModule as any).WebSocket ?? wsModule.default;
    if (!WebSocketCtor) {
      throw new Error('WebSocket module did not expose a client constructor');
    }
    if (!this.socket || this.socket.readyState !== WebSocketCtor.OPEN) {
      throw new Error('No WebSocket client connected');
    }
    return new Promise((resolve, reject) => {
      try {
        const json = JSON.stringify(message);
        this.socket!.send(json, (err: any) => (err ? reject(err) : resolve()));
      } catch (e) {
        reject(e);
      }
    });
  }
  private async loadModule(): Promise<WsModule> {
    if (!this.wsModule) {
      this.wsModule = (await import('ws')) as WsModule;
    }
    return this.wsModule;
  }
}

export default WebSocketServerTransport;
