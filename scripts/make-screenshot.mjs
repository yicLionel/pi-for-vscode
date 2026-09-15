/**
 * Regenerates docs/screenshot.png.
 *
 * The terminal content is real: pi is spawned in a PTY, its TUI bytes are
 * captured, and those exact bytes are replayed into the shipped webview bundle
 * (media/main.js) rendered inside a VS Code window frame.
 *
 * Usage: npm run docs:screenshot
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome, sleep, waitForValue } from './lib/cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testable = path.join(root, 'dist', 'testable.mjs');
const outFile = path.join(root, 'docs', 'screenshot.png');

const WINDOW = { width: 1020, height: 720 };

// A short, fixed cwd so the TUI never truncates it and it can be rewritten into
// something presentable. macOS resolves /tmp to /private/tmp, so both are mapped.
const DEMO_DIR = '/tmp/pi-demo-app';
const DEMO_DISPLAY = '~/projects/demo-app';

const promptIndex = process.argv.indexOf('--prompt');
const DEMO_PROMPT = promptIndex === -1 ? undefined : process.argv[promptIndex + 1];

// Reuse a previously captured stream to iterate on the frame without spending
// another model call: `--stream /tmp/pi-demo-stream.json`.
const streamIndex = process.argv.indexOf('--stream');
const STREAM_FILE = streamIndex === -1 ? '/tmp/pi-demo-stream.json' : process.argv[streamIndex + 1];

if (!fs.existsSync(testable)) {
  console.error('dist/testable.mjs missing — run `npm run compile` first.');
  process.exit(1);
}

const { PiSession, findPiExecutable, resolveLaunchCommand } = await import(pathToFileURL(testable).href);

const piPath = await findPiExecutable();
if (!piPath) {
  console.error('pi was not found — cannot capture the demo.');
  process.exit(1);
}

/** Captures pi's session at the requested geometry. */
async function capturePiTui(cols, rows) {
  if (fs.existsSync(STREAM_FILE) && !DEMO_PROMPT) {
    console.log(`  reusing captured stream from ${STREAM_FILE}`);
    return fs.readFileSync(STREAM_FILE, 'utf8');
  }

  const launch = await resolveLaunchCommand(piPath, ['--no-skills', '--no-extensions']);

  fs.rmSync(DEMO_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DEMO_DIR, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(DEMO_DIR, 'src', 'server.ts'),
    [
      'import { createServer } from "node:http";',
      '',
      '// Greeting used by the /hello route.',
      'export function greet(name: string): string {',
      '  return `hello ${name}`;',
      '}',
      '',
      'const server = createServer((req, res) => {',
      '  const name = "world";',
      '  res.end(greet(name));',
      '});',
      '',
      'server.listen(3000);',
      '',
    ].join('\n'),
  );

  const session = new PiSession('docs-demo');
  const chunks = [];
  let chunkCount = 0;
  session.onData((data) => {
    chunks.push(data);
    chunkCount++;
  });

  session.spawn({
    file: launch.file,
    args: launch.args,
    cwd: DEMO_DIR,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
    cols,
    rows,
  });

  // Let the startup screen paint.
  await new Promise((resolve) => setTimeout(resolve, 3500));

  if (DEMO_PROMPT) {
    session.write(DEMO_PROMPT + '\r');
    // Wait until the TUI stops producing output (session finished streaming).
    let lastCount = -1;
    let stableFor = 0;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await sleep(500);
      if (chunkCount === lastCount) {
        stableFor += 500;
        if (stableFor >= 4000) break;
      } else {
        stableFor = 0;
        lastCount = chunkCount;
      }
    }
    await sleep(400);
  }

  const stream = chunks.join('');
  session.kill();
  await sleep(400);

  const sanitized = stream.split('/private' + DEMO_DIR).join(DEMO_DISPLAY).split(DEMO_DIR).join(DEMO_DISPLAY);
  fs.writeFileSync(STREAM_FILE, sanitized, 'utf8');
  return sanitized;
}

/** Builds a VS Code window frame whose sidebar hosts the real webview bundle. */
function buildPage(stream, workDir) {
  const mainJs = pathToFileURL(path.join(root, 'media', 'main.js')).href;
  const mainCss = pathToFileURL(path.join(root, 'media', 'main.css')).href;
  const pageFile = path.join(workDir, 'page.html');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="${mainCss}" />
<style>
  :root {
    --vscode-editor-background: #1e1e1e;
    --vscode-editor-foreground: #d4d4d4;
    --vscode-editor-font-family: "SF Mono", Menlo, Monaco, "Courier New", monospace;
    --vscode-editor-font-size: 12px;
    --vscode-editor-font-weight: 400;
    --vscode-terminal-background: #1e1e1e;
    --vscode-terminal-foreground: #cccccc;
    --vscode-terminal-selectionBackground: rgba(255, 255, 255, 0.22);
    --vscode-terminal-ansiBlack: #000000;
    --vscode-terminal-ansiRed: #cd3131;
    --vscode-terminal-ansiGreen: #0dbc79;
    --vscode-terminal-ansiYellow: #e5e510;
    --vscode-terminal-ansiBlue: #2472c8;
    --vscode-terminal-ansiMagenta: #bc3fbc;
    --vscode-terminal-ansiCyan: #11a8cd;
    --vscode-terminal-ansiWhite: #e5e5e5;
    --vscode-terminal-ansiBrightBlack: #666666;
    --vscode-terminal-ansiBrightRed: #f14c4c;
    --vscode-terminal-ansiBrightGreen: #23d18b;
    --vscode-terminal-ansiBrightYellow: #f5f543;
    --vscode-terminal-ansiBrightBlue: #3b8eea;
    --vscode-terminal-ansiBrightMagenta: #d670d6;
    --vscode-terminal-ansiBrightCyan: #29b8db;
    --vscode-terminal-ansiBrightWhite: #ffffff;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; overflow: hidden; background: #1e1e1e; }
  body {
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    color: #cccccc;
    display: flex;
    flex-direction: column;
  }
  #pi-overlay, #pi-menu { display: none; }
  #pi-root { inset: 0 0 12px 0; }

  .titlebar {
    height: 38px; flex: 0 0 38px; background: #3c3c3c;
    display: flex; align-items: center; padding: 0 14px; position: relative;
  }
  .lights { display: flex; gap: 8px; }
  .lights i { width: 12px; height: 12px; border-radius: 50%; display: block; }
  .lights i:nth-child(1) { background: #ff5f57; }
  .lights i:nth-child(2) { background: #febc2e; }
  .lights i:nth-child(3) { background: #28c840; }
  .titlebar .title {
    position: absolute; left: 0; right: 0; text-align: center;
    font-size: 12px; color: #9d9d9d; letter-spacing: 0.2px;
  }

  .body { flex: 1 1 auto; display: flex; min-height: 0; }

  .activitybar {
    width: 48px; flex: 0 0 48px; background: #333333;
    display: flex; flex-direction: column; align-items: center;
    padding-top: 6px; gap: 4px;
  }
  .activitybar .item {
    width: 48px; height: 44px; display: flex; align-items: center; justify-content: center;
    color: #868686; position: relative;
  }
  .activitybar .item svg { width: 22px; height: 22px; }
  .activitybar .item.active { color: #ffffff; }
  .activitybar .item.active::before {
    content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: #ffffff;
  }
  .activitybar .spacer { flex: 1 1 auto; }

  .sidebar {
    width: 430px; flex: 0 0 430px; background: #252526;
    border-right: 1px solid #1b1b1b; display: flex; flex-direction: column; min-height: 0;
  }
  .sidebar-head {
    height: 35px; flex: 0 0 35px; display: flex; align-items: center;
    padding: 0 12px; font-size: 11px; letter-spacing: 0.6px; color: #bbbbbb;
    text-transform: uppercase;
  }
  .sidebar-head .grow { flex: 1 1 auto; }
  .sidebar-head .act { color: #cccccc; margin-left: 12px; font-size: 13px; }
  .sidebar-body { flex: 1 1 auto; min-height: 0; position: relative; background: #1e1e1e; }

  .editor { flex: 1 1 auto; background: #1e1e1e; display: flex; flex-direction: column; min-width: 0; }
  .tabs { height: 35px; flex: 0 0 35px; background: #252526; display: flex; }
  .tab {
    background: #1e1e1e; border-top: 1px solid #007acc; padding: 0 16px;
    display: flex; align-items: center; gap: 8px; font-size: 13px; color: #ffffff;
  }
  .tab .dot { width: 7px; height: 7px; border-radius: 50%; background: #519aba; }
  .code { flex: 1 1 auto; padding: 10px 0 0 0; overflow: hidden; }
  .code .line {
    display: flex; font-family: "SF Mono", Menlo, Monaco, monospace;
    font-size: 12.5px; line-height: 1.55; white-space: pre;
  }
  .code .ln { width: 48px; flex: 0 0 48px; text-align: right; padding-right: 14px; color: #858585; }
  .k { color: #569cd6; } .t { color: #4ec9b0; } .s { color: #ce9178; }
  .c { color: #6a9955; } .f { color: #dcdcaa; } .v { color: #9cdcfe; }
  .n { color: #b5cea8; } .o { color: #d4d4d4; }

  .statusbar {
    height: 22px; flex: 0 0 22px; background: #007acc; color: #ffffff;
    display: flex; align-items: center; padding: 0 12px; font-size: 11.5px; gap: 16px;
  }
</style>
</head>
<body>
  <div class="titlebar">
    <div class="lights"><i></i><i></i><i></i></div>
    <div class="title">src/server.ts &mdash; demo-app &mdash; Visual Studio Code</div>
  </div>

  <div class="body">
    <div class="activitybar">
      <div class="item"><svg viewBox="0 0 24 24" fill="none"><path d="M4 3h11l5 5v13H4z" stroke="currentColor" stroke-width="1.7"/></svg></div>
      <div class="item"><svg viewBox="0 0 24 24" fill="none"><circle cx="10.5" cy="10.5" r="6" stroke="currentColor" stroke-width="1.7"/><path d="M15 15l5 5" stroke="currentColor" stroke-width="1.7"/></svg></div>
      <div class="item"><svg viewBox="0 0 24 24" fill="none"><circle cx="7" cy="6" r="2.4" stroke="currentColor" stroke-width="1.7"/><circle cx="7" cy="18" r="2.4" stroke="currentColor" stroke-width="1.7"/><circle cx="17" cy="10" r="2.4" stroke="currentColor" stroke-width="1.7"/><path d="M7 8.4v7.2M17 12.4c0 3-4 3-7 5" stroke="currentColor" stroke-width="1.7"/></svg></div>
      <div class="item"><svg viewBox="0 0 24 24" fill="none"><path d="M5 4l14 8-14 8z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg></div>
      <div class="item"><svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="6" height="6" stroke="currentColor" stroke-width="1.7"/><rect x="14" y="4" width="6" height="6" stroke="currentColor" stroke-width="1.7"/><rect x="4" y="14" width="6" height="6" stroke="currentColor" stroke-width="1.7"/><rect x="14" y="14" width="6" height="6" stroke="currentColor" stroke-width="1.7"/></svg></div>
      <div class="spacer"></div>
      <div class="item active"><svg viewBox="0 0 24 24" fill="none"><path fill="currentColor" d="M3 4.5h18v2.6H3z"/><path fill="currentColor" d="M5.8 7.1h2.6V19.5H5.8z"/><path fill="currentColor" d="M15.6 7.1h2.6V19.5h-2.6z"/></svg></div>
    </div>

    <div class="sidebar">
      <div class="sidebar-head"><span>Pi</span><span class="grow"></span><span class="act">&#8635;</span><span class="act">&#43;</span><span class="act">&#8942;</span></div>
      <div class="sidebar-body">
        <div id="pi-root">
          <div id="pi-terminal" class="pi-terminal"></div>
          <div id="pi-overlay" class="pi-overlay" hidden><div class="pi-card"><div class="pi-card-title" id="pi-overlay-title"></div><div class="pi-card-message" id="pi-overlay-message"></div><div class="pi-card-actions" id="pi-overlay-actions"></div></div></div>
          <div id="pi-menu" class="pi-menu" hidden></div>
        </div>
      </div>
    </div>

    <div class="editor">
      <div class="tabs"><div class="tab"><span class="dot"></span>server.ts</div></div>
      <div class="code">
        <div class="line"><span class="ln">1</span><span class="k">import</span><span class="o"> { createServer } </span><span class="k">from</span><span class="s"> "node:http"</span><span class="o">;</span></div>
        <div class="line"><span class="ln">2</span><span class="o"></span></div>
        <div class="line"><span class="ln">3</span><span class="c">// Greeting used by the /hello route.</span></div>
        <div class="line"><span class="ln">4</span><span class="k">export function</span><span class="f"> greet</span><span class="o">(</span><span class="v">name</span><span class="o">: </span><span class="t">string</span><span class="o">): </span><span class="t">string</span><span class="o"> {</span></div>
        <div class="line"><span class="ln">5</span><span class="o">  </span><span class="k">return</span><span class="s"> \`hello \${name}\`</span><span class="o">;</span></div>
        <div class="line"><span class="ln">6</span><span class="o">}</span></div>
        <div class="line"><span class="ln">7</span><span class="o"></span></div>
        <div class="line"><span class="ln">8</span><span class="k">const</span><span class="v"> server</span><span class="o"> = </span><span class="f">createServer</span><span class="o">((</span><span class="v">req</span><span class="o">, </span><span class="v">res</span><span class="o">) =&gt; {</span></div>
        <div class="line"><span class="ln">9</span><span class="o">  </span><span class="k">const</span><span class="v"> name</span><span class="o"> = </span><span class="s">"world"</span><span class="o">;</span></div>
        <div class="line"><span class="ln">10</span><span class="o">  </span><span class="v">res</span><span class="o">.</span><span class="f">end</span><span class="o">(</span><span class="f">greet</span><span class="o">(</span><span class="v">name</span><span class="o">));</span></div>
        <div class="line"><span class="ln">11</span><span class="o">});</span></div>
        <div class="line"><span class="ln">12</span><span class="o"></span></div>
        <div class="line"><span class="ln">13</span><span class="v">server</span><span class="o">.</span><span class="f">listen</span><span class="o">(</span><span class="n">3000</span><span class="o">);</span></div>
      </div>
    </div>
  </div>

  <div class="statusbar"><span>&#10003; Pi</span><span>main</span><span>TypeScript</span><span style="flex:1"></span><span>Ln 4, Col 24</span><span>UTF-8</span></div>

<script>
  window.__messages = [];
  window.acquireVsCodeApi = function () {
    return { postMessage: (m) => window.__messages.push(m), getState: () => undefined, setState: () => undefined };
  };
</script>
<script src="${mainJs}"></script>
<script>
  const STREAM = ${JSON.stringify(stream)};
  const send = (data) => window.dispatchEvent(new MessageEvent('message', { data }));

  window.__demo = async function () {
    // Let xterm settle, then replay the captured TUI bytes verbatim.
    send({ type: 'init', settings: { fontFamily: '', fontSize: 12, lineHeight: 1, cursorBlink: false, scrollback: 5000, fileLinks: true }, state: 'running', autoStart: true });
    await new Promise((r) => requestAnimationFrame(() => r()));
    send({ type: 'data', data: STREAM });
    await new Promise((r) => setTimeout(r, 900));
    document.getElementById('pi-overlay').hidden = true;
    document.getElementById('pi-menu').hidden = true;
    window.__demoDone = true;
  };
  window.addEventListener('load', () => { window.__demo().catch(() => { window.__demoDone = true; }); });
</script>
</body>
</html>`;

  fs.writeFileSync(pageFile, html);
  return pageFile;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-shot-'));
const chrome = await launchChrome({ width: WINDOW.width, height: WINDOW.height });

if (!chrome) {
  console.error('No Chromium-based browser found — cannot render docs/screenshot.png');
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

console.log(`\nRendering docs/screenshot.png with ${chrome.browser}\n`);

try {
  // Pass 1: discover the geometry the sidebar actually produces.
  const probePage = buildPage('', workDir);
  await chrome.client.send('Page.navigate', { url: pathToFileURL(probePage).href }, chrome.sessionId);
  await waitForValue(chrome.client, chrome.sessionId, 'window.__messages && window.__messages.find(m => m.type === "resize")', 20000, 'the first resize message');
  const geometry = await chrome.client.send(
    'Runtime.evaluate',
    { expression: 'JSON.stringify(window.__messages.find(m => m.type === "resize"))', returnByValue: true },
    chrome.sessionId,
  );
  const { cols, rows } = JSON.parse(geometry.result.value);
  console.log(`  sidebar geometry: ${cols}x${rows}`);

  // Pass 2: capture pi at exactly one row less than the frame. xterm's fit
  // rounds rows down while the DOM renderer can render each row a fraction
  // taller, so leaving one spare row guarantees the status line is never clipped.
  const stream = await capturePiTui(cols, Math.max(1, rows - 1));
  console.log(`  captured ${stream.length} bytes of real TUI output`);

  const page = buildPage(stream, workDir);
  await chrome.client.send('Page.navigate', { url: pathToFileURL(page).href }, chrome.sessionId);
  await waitForValue(chrome.client, chrome.sessionId, 'window.__demoDone === true', 20000, 'the demo to finish rendering');

  const shot = await chrome.client.send('Page.captureScreenshot', { format: 'png' }, chrome.sessionId);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
  console.log(`\n  wrote ${path.relative(root, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)\n`);
} finally {
  chrome.cleanup();
  fs.rmSync(workDir, { recursive: true, force: true });
}
