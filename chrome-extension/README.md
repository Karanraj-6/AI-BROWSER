# Chrome DevTools MCP Agent

This Chrome extension connects the Gemini API to a hosted Model Context Protocol (MCP) server backed by the Chrome DevTools MCP project. The UI lets you request browser automations, preview the generated plan, and execute it directly in the active tab. Because the MCP server runs remotely, users only need to install the extension—no local scripts or native helpers are required.

## Prerequisites

- A Google Gemini API key with access to the `gemini-2.5-flash` model.
- A publicly reachable MCP server (for example, the [`chrome-devtools-mcp`](../chrome-devtools-mcp) project deployed on a service such as Fast MCP).

## Setup

```powershell
npm install
npm run build
```

Load the `dist` directory as an unpacked extension in Chrome (chrome://extensions > Developer mode > Load unpacked).

## Configuration

1. Open the extension popup and go to **Show settings**.
2. Paste your Gemini API key and save it. Keys are stored locally via `chrome.storage.local`.
3. Enter the WebSocket URL of your hosted MCP server (for example `wss://your-mcp.example.com/v1/ws`) and save it. The background service worker will reconnect automatically using the new endpoint.

You can also trigger a manual reconnect from the header if you redeploy the MCP server.

## Usage

1. Navigate to the page you want to automate.
2. Provide the task you want performed in the composer.
3. The extension requests a plan from Gemini. Review the proposed actions or enable **Auto agent** to execute them automatically.
4. Track execution progress and tooling output in the popup.

## Development

```powershell
npm run dev
```

The Vite dev server rebuilds the popup. Use `npm run build` before loading the unpacked extension.

## Deployment Checklist

- Host the MCP server on a publicly accessible endpoint with TLS (wss://).
- Update the extension configuration defaults if you have an organization-specific endpoint.
- Publish the packaged extension to the Chrome Web Store.
