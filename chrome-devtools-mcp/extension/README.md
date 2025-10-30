# MCP Attach Helper (extension)

Minimal extension that can attach to the active tab using chrome.debugger and run a small CDP snippet.

How to load
- In Chrome, go to chrome://extensions
- Enable "Developer mode"
- Click "Load unpacked" and select this `extension/` folder

Usage
- Click the extension action button to attach to the active tab and attempt to play a video (or run the small snippet).
- Or send a runtime message from the console or a script:

```js
chrome.runtime.sendMessage({ action: 'attachAndRun' }, (resp) => console.log(resp));
```

Notes
- The extension needs the `debugger` permission. While attached, the tab cannot be inspected by other DevTools clients.
- For a production integration you may want to implement Native Messaging to relay commands from an external MCP process.
