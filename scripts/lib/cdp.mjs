/**
 * Minimal Chrome DevTools Protocol client used by the browser-driven checks.
 *
 * Uses Node's global WebSocket (Node >= 22) so there is no dependency on
 * Playwright/Puppeteer. Chrome is driven with real timers, which matters because
 * xterm.js renders on requestAnimationFrame and starves under virtual time.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

export function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
        return;
      }
      for (const handler of this.handlers) handler(message);
    });
  }

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }
}

function connect(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out connecting to ${url}`));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(new Cdp(socket));
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`could not connect to ${url}`));
    });
  });
}

/**
 * Launches headless Chrome and returns a page session ready to navigate.
 * Returns undefined when no Chromium-based browser is installed.
 */
/**
 * Removes Chrome's throwaway profile directory.
 *
 * Chrome's renderer/GPU helper processes can keep writing into the profile for a
 * moment after the parent is killed, which makes rmSync fail with ENOTEMPTY —
 * observed as a macOS CI failure on an otherwise fully green run. A leftover temp
 * directory is harmless, so retry briefly and then give up rather than throwing.
 */
export function removeProfile(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // Sync sleep: this also runs from a process 'exit' handler, where nothing
      // asynchronous would ever get a chance to run.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

export async function launchChrome({ width = 900, height = 600, args = [] } = {}) {
  const browser = findBrowser();
  if (!browser) return undefined;

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-chrome-'));
  const chrome = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--allow-file-access-from-files',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--disable-extensions',
      `--window-size=${width},${height}`,
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      ...args,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const cleanup = () => {
    try {
      chrome.kill('SIGKILL');
    } catch {
      // ignore
    }
    removeProfile(profileDir);
  };

  let devtoolsUrl;
  try {
    devtoolsUrl = await new Promise((resolve, reject) => {
      let buffer = '';
      const onChunk = (chunk) => {
        buffer += chunk.toString();
        const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) resolve(match[1]);
      };
      chrome.stderr.on('data', onChunk);
      chrome.stdout.on('data', onChunk);
      chrome.on('exit', (code) => reject(new Error(`Chrome exited early with code ${code}`)));
      setTimeout(() => reject(new Error('timed out waiting for the DevTools endpoint')), 20000);
    });
  } catch (error) {
    cleanup();
    throw error;
  }

  const client = await connect(devtoolsUrl);
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });

  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);

  return {
    browser,
    client,
    sessionId,
    cleanup() {
      client.close();
      cleanup();
    },
  };
}

/** Polls an expression until it returns a truthy value. */
export async function waitForValue(client, sessionId, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evaluation = await client.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    const value = evaluation?.result?.value;
    if (value) return value;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}
