#!/usr/bin/env node
// @ts-nocheck
import path from 'node:path';
import os from 'node:os';
import { launchChromeAndConnect } from '../src/tools/puppeteerConnect.js';

async function main() {
  const args = process.argv.slice(2);
  const portArg = args.find(a => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : undefined;

  const userDataDir = path.join(os.homedir(), '.cache', 'mcp-attach-profile');

  try {
    const { browser, chromeProcess, port: usedPort } = await launchChromeAndConnect({
      userDataDir,
      ports: port ? [port] : [9222, 9223, 9224],
      headless: false,
      timeoutMs: 20000,
    });
    console.log('Connected to Chrome on port', usedPort);
  const pages = await browser.pages();
  console.log('Pages:', pages.map((p: any) => p.url()));
    // keep process running so the spawned chrome (if any) stays alive
    // caller can Ctrl+C to exit
  } catch (err) {
    console.error('Failed to connect:', err);
    process.exit(1);
  }
}

main();
