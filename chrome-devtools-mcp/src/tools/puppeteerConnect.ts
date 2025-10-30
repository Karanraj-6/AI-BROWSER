/**
 * Helper to launch Chrome with a remote debugging port and connect via puppeteer.connect.
 *
 * Usage: import { launchChromeAndConnect } from './tools/puppeteerConnect';
 *
 * Note: This helper attempts provided ports in order. If Chrome is already
 * running with the provided user-data-dir, launching a new instance may
 * hand windows to the already-running process. Prefer a dedicated
 * userDataDir or start Chrome with --remote-debugging-port manually.
 */
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { setTimeout as wait } from 'timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import { puppeteer } from '../third_party/index.js';

export async function launchChromeAndConnect(options: {
  chromePath?: string;
  userDataDir?: string;
  ports?: number[];
  headless?: boolean;
  timeoutMs?: number;
}): Promise<{ browser: any; chromeProcess?: ChildProcessWithoutNullStreams; port: number }>
{
  const { chromePath, userDataDir, ports = [9222, 9223, 9224], headless = false, timeoutMs = 15000 } = options;

  // Resolve chrome executable if not provided. Try common locations per OS.
  function findDefaultChrome(): string | undefined {
    const platform = os.platform();
    const candidates: string[] = [];
    if (platform === 'win32') {
      candidates.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
      );
    } else if (platform === 'darwin') {
      candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    } else {
      // linux / other unix-like
      candidates.push(
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
      );
    }
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (_) {
        // ignore
      }
    }
    return undefined;
  }

  const resolvedChrome = chromePath ?? findDefaultChrome();
  if (!resolvedChrome) {
    throw new Error('Chrome executable not found. Pass options.chromePath or install Chrome.');
  }

  let chromeProcess: ChildProcessWithoutNullStreams | undefined;

  for (const port of ports) {
    const browserURL = `http://127.0.0.1:${port}`;
    try {
      // If a remote debugging endpoint is already open, try to connect.
      const browser = await puppeteer.connect({ browserURL, defaultViewport: null, handleDevToolsAsPage: true });
      return { browser, port };
    } catch (e) {
      // Not available yet — attempt to launch Chrome with this port.
      const args = [
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
      ];
      if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
      if (headless) args.push('--headless=new');

      try {
        // use pipes for stdin so the type matches ChildProcessWithoutNullStreams
        chromeProcess = spawn(resolvedChrome, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (spawnErr) {
        // Unable to spawn using resolved path — rethrow so caller can handle.
        throw new Error(`Failed to spawn Chrome at ${resolvedChrome}: ${(spawnErr as Error).message}`);
      }

      // Wait for the debugging endpoint to come up.
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          await wait(250);
          const browser = await puppeteer.connect({ browserURL, defaultViewport: null, handleDevToolsAsPage: true });
          return { browser, chromeProcess, port };
        } catch (err) {
          // keep polling
        }
      }

      // Timed out for this port — try next port
      // Kill the spawned process if it was created
      try {
        if (chromeProcess) chromeProcess.kill();
      } catch (e) {}
      chromeProcess = undefined;
    }
  }

  throw new Error('Unable to connect to Chrome on any provided port');
}

export default launchChromeAndConnect;
