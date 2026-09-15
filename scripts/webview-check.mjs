/**
 * Drives the real webview bundle (media/main.js + media/main.css) in headless
 * Chrome over the DevTools Protocol and asserts the frontend contract:
 * the ready/resize handshake, TUI rendering, the state overlay and the menu.
 *
 * Chrome is driven with real timers (no virtual time), because xterm.js renders
 * on requestAnimationFrame.
 *
 * Skips gracefully when no Chromium-based browser is installed.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harness = path.join(root, 'scripts', 'webview-harness.html');

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

/** Minimal Chrome DevTools Protocol client built on Node's global WebSocket. */
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

  static connect(url, timeoutMs = 15000) {
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

const browser = findBrowser();
if (!browser) {
  console.log('No Chromium-based browser found — skipping the webview rendering check.');
  process.exit(0);
}

if (!fs.existsSync(path.join(root, 'media', 'main.js'))) {
  console.error('media/main.js missing — run `npm run compile` first.');
  process.exit(1);
}

console.log('\nPi for VS Code — webview rendering check\n');
console.log(`  browser: ${browser}`);

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
    '--window-size=900,600',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

function cleanup() {
  try {
    chrome.kill('SIGKILL');
  } catch {
    // ignore
  }
  fs.rmSync(profileDir, { recursive: true, force: true });
}
process.on('exit', cleanup);

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
  console.error(`  ✗ ${String(error)}`);
  cleanup();
  process.exit(1);
}

let client;
try {
  client = await Cdp.connect(devtoolsUrl);
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });

  const pageErrors = [];
  client.onEvent((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails;
      pageErrors.push(details?.exception?.description ?? details?.text ?? 'unknown exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      pageErrors.push(message.params.args?.map((a) => a.value ?? a.description).join(' '));
    }
  });

  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  await client.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 900, height: 600, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );

  await client.send('Page.navigate', { url: pathToFileURL(harness).href }, sessionId);

  const deadline = Date.now() + 30000;
  let findings = null;
  while (Date.now() < deadline) {
    const evaluation = await client.send(
      'Runtime.evaluate',
      { expression: 'window.__result ?? null', returnByValue: true },
      sessionId,
    );
    const value = evaluation?.result?.value;
    if (value) {
      findings = value;
      break;
    }
    await sleep(150);
  }

  if (!findings) {
    console.error('  ✗ the harness never produced a result');
    cleanup();
    process.exit(1);
  }

  findings.pageErrors = pageErrors;

  const checks = [
    ['xterm.js mounted into the sidebar container', () => findings.hasTerminal === true],
    ['the DOM renderer is active', () => findings.hasRows === true],
    ['the webview posts `ready` on load', () => findings.readyPosted === true],
    ['the webview posts a `resize` with real geometry', () => findings.resizePosted === true],
    ['the starting overlay is shown while launching', () => findings.startingOverlayShown === true],
    ['TUI output is rendered in the terminal', () => findings.renderedHello === true],
    ['ANSI colouring does not leak into the text', () => findings.renderedHasNoEscapeCodes === true],
    ['file paths are visible in the terminal buffer', () => findings.renderedPath === true],
    ['the overlay hides once Pi is running', () => findings.overlayHiddenWhileRunning === true],
    ['the error overlay is actionable', () => findings.errorOverlayShown === true && findings.errorOverlayButtons >= 4],
    ['overlay buttons post an action message', () => findings.actionPosted === true],
    ['right click opens the context menu', () => findings.menuOpened === true],
    ['the context menu offers restart', () => findings.menuHasRestart === true && findings.menuItems >= 6],
    ['no uncaught frontend errors', () => pageErrors.length === 0],
  ];

  let failed = 0;
  for (const [name, predicate] of checks) {
    let ok = false;
    let detail = '';
    try {
      ok = predicate();
    } catch (error) {
      detail = String(error);
    }
    if (ok) {
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.error(`  ✗ ${name}${detail ? ` (${detail})` : ''}`);
    }
  }

  if (pageErrors.length) console.error(`\n  frontend errors: ${JSON.stringify(pageErrors)}`);

  console.log(`\n${checks.length - failed} passed, ${failed} failed\n`);
  if (failed) {
    console.error(`rendered text: ${JSON.stringify(findings.renderedText)}\n`);
    console.error(`posted message types: ${JSON.stringify(findings.postedTypes)}\n`);
  }

  cleanup();
  process.exit(failed === 0 ? 0 : 1);
} catch (error) {
  console.error('  ✗ webview check crashed:', error);
  client?.close();
  cleanup();
  process.exit(1);
}
