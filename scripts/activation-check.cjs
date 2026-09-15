/**
 * Headless activation test for the built extension bundle.
 *
 * Loads dist/extension.js with a stub `vscode` module, activates it, resolves
 * the sidebar webview, and drives the real controller -> locator -> PTY
 * pipeline (start, stream, restart, kill). When pi is not installed the test
 * verifies the clean error path instead, so it also passes on CI.
 *
 * Run with plain node, or with VS Code's own Electron helper:
 *   ELECTRON_RUN_AS_NODE=1 "<Code Helper (Plugin)>" scripts/activation-check.cjs
 */
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const root = process.env.PI_EXTENSION_ROOT
  ? path.resolve(process.env.PI_EXTENSION_ROOT)
  : path.resolve(__dirname, '..');
const bundle = path.join(root, 'dist', 'extension.js');

if (!fs.existsSync(bundle)) {
  console.error('dist/extension.js missing — run `npm run compile` first.');
  process.exit(1);
}

// ------------------------------------------------------------------ vscode stub

const disposable = () => ({ dispose() {} });

let webviewViewProvider;
let receivedMessageHandler;
const postedMessages = [];

function makeUri(fsPath) {
  return { fsPath, scheme: 'file', path: fsPath, toString: () => `file://${fsPath}` };
}

class EventEmitter {
  constructor() {
    this.event = () => disposable();
  }
  fire() {}
  dispose() {}
}

const vscodeStub = {
  version: '1.137.0',
  Uri: {
    file: makeUri,
    parse: (value) => makeUri(value),
    joinPath: (base, ...parts) => makeUri([base.fsPath, ...parts].filter(Boolean).join('/')),
  },
  EventEmitter,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  ViewColumn: { Active: -1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Range: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  Selection: class {
    constructor(start, end) {
      Object.assign(this, { start, end });
    }
  },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    registerWebviewViewProvider: (viewType, provider) => {
      webviewViewProvider = { viewType, provider };
      return disposable();
    },
    createWebviewPanel: () => ({
      webview: { postMessage: async () => true, onDidReceiveMessage: () => disposable() },
      onDidDispose: () => disposable(),
      onDidChangeViewState: () => disposable(),
      reveal() {},
      dispose() {},
    }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showOpenDialog: async () => undefined,
    showTextDocument: async () => ({ selection: undefined, revealRange() {} }),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => undefined }),
    onDidChangeConfiguration: () => disposable(),
    getWorkspaceFolder: () => undefined,
    openTextDocument: async () => ({}),
    onDidChangeWorkspaceFolders: () => disposable(),
  },
  commands: {
    registerCommand: () => disposable(),
    executeCommand: async () => undefined,
  },
  env: {
    clipboard: { writeText: async () => undefined, readText: async () => '' },
    openExternal: async () => true,
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// ----------------------------------------------------------------------- helpers

const results = [];
let skipped = 0;

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  - ${name} (skipped: ${reason})`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const stateMessages = () => postedMessages.filter((m) => m.type === 'state');
const hasState = (state) => stateMessages().some((m) => m.state === state);

// -------------------------------------------------------------------------- main

(async () => {
  console.log('\nPi for VS Code — activation test\n');
  console.log(
    `  runtime: node ${process.versions.node} (modules ${process.versions.modules})` +
      (process.versions.electron ? `, electron ${process.versions.electron}` : ''),
  );

  const extension = require(bundle);
  check('bundle exports activate()', () => assert.equal(typeof extension.activate, 'function'));

  const context = {
    subscriptions: [],
    extensionUri: makeUri(root),
    extensionPath: root,
    globalState: { get: () => undefined, update: async () => undefined },
  };

  extension.activate(context);
  check('activate() registers the sidebar webview provider', () => {
    assert.ok(webviewViewProvider, 'registerWebviewViewProvider was never called');
    assert.equal(webviewViewProvider.viewType, 'pi-for-vscode.sidebar');
  });

  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-webview://test',
    asWebviewUri: (uri) => uri,
    onDidReceiveMessage: (handler) => {
      receivedMessageHandler = handler;
      return disposable();
    },
    postMessage: async (message) => {
      postedMessages.push(message);
      return true;
    },
  };

  const view = {
    webview,
    title: '',
    visible: true,
    show() {},
    onDidDispose: () => disposable(),
    onDidChangeVisibility: () => disposable(),
  };

  webviewViewProvider.provider.resolveWebviewView(view);

  check('webview html is generated with a strict CSP and the xterm bundle', () => {
    assert.match(webview.html, /id="pi-terminal"/);
    assert.match(webview.html, /Content-Security-Policy/);
    assert.match(webview.html, /script-src 'nonce-[A-Za-z0-9]{32}'/);
    assert.match(webview.html, /media\/main\.js/);
    assert.match(webview.html, /media\/main\.css/);
  });

  check('webview options allow scripts and restrict resources', () => {
    assert.equal(webview.options.enableScripts, true);
    assert.ok(Array.isArray(webview.options.localResourceRoots));
  });

  // Drive the real pipeline: ready -> resize -> spawn pi (or fail cleanly).
  receivedMessageHandler({ type: 'ready' });
  await waitFor(() => postedMessages.some((m) => m.type === 'init'), 4000, 'the init message');
  check('controller answers `ready` with an init payload', () => {
    const init = postedMessages.find((m) => m.type === 'init');
    assert.ok(init, 'no init message');
    assert.ok(init.settings, 'init carried no settings');
    assert.equal(typeof init.settings.scrollback, 'number');
  });

  receivedMessageHandler({ type: 'resize', cols: 100, rows: 30 });
  await waitFor(() => hasState('running') || hasState('error'), 30000, 'the session to start or fail cleanly');

  const started = hasState('running');

  if (!started) {
    // No pi on this machine: the important thing is a clean, actionable failure.
    check('controller reports a clean, actionable error when pi is unavailable', () => {
      const errorState = stateMessages().find((m) => m.state === 'error');
      assert.ok(errorState, 'no error state was reported');
      assert.ok(
        typeof errorState.message === 'string' && errorState.message.length > 0,
        'error state carried no message',
      );
      assert.match(errorState.message, /not found|pi/i, `unhelpful message: ${errorState.message}`);
    });
    console.log('  (pi is not installed — skipping the PTY lifecycle assertions)');
    skip('PTY starts and the controller reports state=running', 'pi is not installed');
    skip('pi TUI streams terminal data into the webview', 'pi is not installed');
    skip('restart tears down and respawns the PTY', 'pi is not installed');
    skip('clipboard writes reach the VS Code clipboard', 'pi is not installed');
    skip('kill stops the session and reports exited', 'pi is not installed');
  } else {
    check('PTY starts and the controller reports state=running', () => {
      const states = stateMessages().map((m) => m.state);
      assert.ok(states.includes('starting'), `never saw starting: ${states.join(',')}`);
      assert.ok(states.includes('running'), `never saw running: ${states.join(',')}`);
    });

    await waitFor(() => postedMessages.some((m) => m.type === 'data'), 20000, 'TUI output from pi');
    check('pi TUI streams terminal data into the webview', () => {
      const output = postedMessages
        .filter((m) => m.type === 'data')
        .map((m) => m.data)
        .join('');
      assert.ok(output.length > 0, 'no data was forwarded');
      assert.match(output, /\u001b\[/, 'no ANSI escape sequences were forwarded');
    });

    check('no error state was reported', () => {
      const errorState = stateMessages().find((m) => m.state === 'error');
      assert.ok(!errorState, `extension reported an error: ${errorState && errorState.message}`);
    });

    const runningCount = () => stateMessages().filter((m) => m.state === 'running').length;
    const runningBefore = runningCount();

    receivedMessageHandler({ type: 'action', action: 'restart' });
    await waitFor(() => runningCount() > runningBefore, 30000, 'Pi to restart');
    check('restart tears down and respawns the PTY without an exited flicker', () => {
      const exited = stateMessages().filter((m) => m.state === 'exited').length;
      assert.equal(exited, 0, `restart leaked an "exited" state: ${stateMessages().map((m) => m.state).join(',')}`);
      assert.ok(runningCount() > runningBefore, 'the session never came back up');
    });

    await waitFor(
      () => postedMessages.filter((m) => m.type === 'data').length > 1,
      20000,
      'output from the restarted session',
    );

    const copyBefore = postedMessages.filter((m) => m.type === 'copy').length;
    receivedMessageHandler({ type: 'copy', text: 'hello from pi' });
    receivedMessageHandler({ type: 'paste' });
    receivedMessageHandler({ type: 'openFile', path: 'definitely/not/a/real/file.ts', line: 3, column: 1 });
    receivedMessageHandler({ type: 'resize', cols: 80, rows: 24 });
    check('clipboard and link messages are handled without throwing', () => {
      assert.equal(postedMessages.filter((m) => m.type === 'copy').length, copyBefore);
    });

    receivedMessageHandler({ type: 'action', action: 'kill' });
    await waitFor(() => hasState('exited'), 20000, 'the session to report exited after kill');
    check('kill stops the session and reports exited', () => {
      assert.ok(hasState('exited'), `expected an exited state, saw ${stateMessages().map((m) => m.state).join(',')}`);
    });
  }

  // Clean up: disposing the context subscriptions tears the PTY down.
  for (const subscription of [...context.subscriptions].reverse()) {
    try {
      subscription.dispose();
    } catch {
      // ignore
    }
  }

  let failed = 0;
  for (const result of results) {
    if (result.ok) {
      console.log(`  ✓ ${result.name}`);
    } else {
      failed++;
      console.error(`  ✗ ${result.name}`);
      console.error(`      ${result.error && result.error.message}`);
    }
  }

  const summary = [`${results.length - failed} passed`, failed ? `${failed} failed` : undefined, skipped ? `${skipped} skipped` : undefined]
    .filter(Boolean)
    .join(', ');
  console.log(`\n${summary}\n`);

  await sleep(200);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\nactivation test crashed:', error);
  process.exit(1);
});
