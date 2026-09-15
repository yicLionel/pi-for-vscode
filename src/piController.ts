import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PiSettings, readSettings, resolveCwd, webviewSettings } from './config';
import type { PiHostAdapter } from './host';
import { expandHome, findPiExecutable, LaunchCommand, resolveLaunchCommand } from './piLocator';
import { PiSession } from './piSession';
import { getWebviewHtml } from './webviewHtml';

export type PiState = 'idle' | 'starting' | 'running' | 'exited' | 'error';

/** Runtime metadata inherited from a parent Pi process must not leak into the child. */
const INHERITED_PI_ENV = [
  'PI_SESSION_ID',
  'PI_SESSION_FILE',
  'PI_CODING_AGENT',
  'PI_MODEL',
  'PI_PROVIDER',
  'PI_REASONING_LEVEL',
  'PI_EXECUTABLE',
  'PI_OFFLINE',
];

export class PiNotFoundError extends Error {
  constructor() {
    super('Could not find the `pi` executable.');
    this.name = 'PiNotFoundError';
  }
}

interface InboundMessage {
  type?: string;
  data?: string;
  text?: string;
  cols?: number;
  rows?: number;
  url?: string;
  path?: string;
  line?: number;
  column?: number;
  action?: string;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Wraps text in bracketed-paste markers so the Pi editor pastes it verbatim. */
function bracketPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

export class PiController implements vscode.Disposable {
  private readonly session: PiSession;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly stateEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeState = this.stateEmitter.event;

  private settings: PiSettings;
  private state: PiState = 'idle';
  private stateMessage = '';
  private cols = 80;
  private rows = 24;
  private webviewReady = false;
  private forceStart = false;
  private starting = false;
  private launch?: LaunchCommand;
  private currentCwd?: string;
  private title: string;
  private disposed = false;

  constructor(
    readonly id: string,
    private readonly host: PiHostAdapter,
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    title: string,
  ) {
    this.title = title;
    this.session = new PiSession(id);
    this.settings = readSettings();
  }

  // ---------------------------------------------------------------- lifecycle

  setup(): void {
    const { webview } = this.host;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webview.html = getWebviewHtml(webview, this.context.extensionUri);

    this.disposables.push(
      webview.onDidReceiveMessage((message: InboundMessage) => void this.handleMessage(message ?? {})),
      this.host.onDidDispose(() => this.dispose()),
      this.host.onDidChangeVisibility((visible) => {
        if (!visible) return;
        this.post({ type: 'refit' });
        // Re-arm the terminal in case the PTY never came up.
        void this.ensureStarted();
      }),
      this.session.onData((data) => this.handleData(data)),
      this.session.onExit(({ exitCode }) => this.handleExit(exitCode)),
      this.session.onTitle((title) => {
        this.title = title;
      }),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.stateEmitter.dispose();
  }

  // -------------------------------------------------------------- public API

  get label(): string {
    return this.title;
  }

  get currentState(): PiState {
    return this.state;
  }

  get isAlive(): boolean {
    return this.session.alive;
  }

  get pid(): number | undefined {
    return this.session.pid;
  }

  get resolvedExecutable(): string | undefined {
    return this.launch?.piPath;
  }

  get kind() {
    return this.host.kind;
  }

  focus(): void {
    if (!this.host.isVisible()) this.host.reveal();
    this.post({ type: 'focus' });
  }

  async restart(): Promise<void> {
    // Suppress the intermediate "exited" overlay while we bounce the process.
    this.pendingRestart = true;
    try {
      await this.stopSession();
      this.forceStart = true;
      await this.start();
    } finally {
      this.pendingRestart = false;
    }
  }

  kill(): void {
    if (!this.session.alive) {
      this.setState('idle', 'Pi is not running.');
      return;
    }
    // The exit handler flips the UI into the "exited" state with a Restart button.
    void this.stopSession();
  }

  clear(): void {
    // Ctrl+L is the conventional "redraw/clear" key for TUI applications.
    this.session.write('\x0c');
    this.focus();
  }

  sendText(text: string, submit: boolean): void {
    if (!text) return;
    this.forceStart = true;
    this.write(bracketPaste(text) + (submit ? '\r' : ''));
    this.focus();
  }

  applySettings(): void {
    this.settings = readSettings();
    this.post({ type: 'settings', settings: webviewSettings(this.settings) });
  }

  // ------------------------------------------------------------- message I/O

  private async handleMessage(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        this.postInit();
        return;
      case 'input':
        if (typeof message.data === 'string') this.write(message.data);
        return;
      case 'resize': {
        const cols = clamp(message.cols, 2, 1000, this.cols);
        const rows = clamp(message.rows, 1, 500, this.rows);
        if (cols === this.cols && rows === this.rows && this.session.alive) return;
        this.cols = cols;
        this.rows = rows;
        if (this.session.alive) this.session.resize(cols, rows);
        else void this.ensureStarted();
        return;
      }
      case 'copy':
        if (typeof message.text === 'string' && message.text) {
          await vscode.env.clipboard.writeText(message.text);
        }
        return;
      case 'paste': {
        const text = await vscode.env.clipboard.readText();
        if (text) this.write(bracketPaste(text));
        return;
      }
      case 'action':
        await this.handleAction(message.action);
        return;
      case 'openExternal':
        if (typeof message.url === 'string') await this.openExternal(message.url);
        return;
      case 'openFile':
        if (typeof message.path === 'string') await this.openFile(message.path, message.line, message.column);
        return;
      default:
        return;
    }
  }

  private async handleAction(action: string | undefined): Promise<void> {
    switch (action) {
      case 'start':
        this.forceStart = true;
        await this.start();
        return;
      case 'restart':
        await this.restart();
        return;
      case 'retry':
        this.forceStart = true;
        await this.start();
        return;
      case 'pickExecutable':
        await vscode.commands.executeCommand('pi-for-vscode.pickExecutable');
        return;
      case 'kill':
        this.kill();
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('pi-for-vscode.openSettings');
        return;
      case 'showOutput':
        this.output.show(true);
        return;
      default:
        return;
    }
  }

  // ----------------------------------------------------------------- session

  private pendingRestart = false;

  private async ensureStarted(): Promise<void> {
    if (!this.webviewReady || this.session.alive || this.starting || this.disposed) return;
    if (!this.settings.autoStart && !this.forceStart) {
      this.setState('idle', 'Pi is not running.');
      return;
    }
    await this.start();
  }

  private async start(): Promise<void> {
    if (this.starting || this.session.alive || this.disposed) return;
    this.starting = true;
    this.setState('starting', 'Starting Pi…');

    try {
      const settings = readSettings();
      this.settings = settings;
      const cwd = resolveCwd(settings);
      this.currentCwd = cwd;

      const configured = settings.executablePath ? expandHome(settings.executablePath) : undefined;
      const piPath = configured || (await findPiExecutable());
      if (!piPath) throw new PiNotFoundError();
      if (!fs.existsSync(piPath)) {
        throw new Error(`Configured pi executable does not exist: ${piPath}`);
      }

      const launch = await resolveLaunchCommand(piPath, settings.args);
      this.launch = launch;

      this.output.appendLine(`[start] cwd=${cwd}`);
      this.output.appendLine(`[start] launch=${launch.description} (${launch.kind})`);

      this.session.spawn({
        file: launch.file,
        args: launch.args,
        cwd,
        env: this.buildEnv(settings, cwd),
        cols: this.cols,
        rows: this.rows,
      });

      this.output.appendLine(`[start] pid=${this.session.pid ?? 'unknown'}`);
      this.forceStart = false;
      this.setState('running');
      this.post({ type: 'meta', cwd, executable: launch.piPath, pid: this.session.pid });
      this.flushPending();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[error] ${message}`);
      if (error instanceof PiNotFoundError) {
        this.setState(
          'error',
          'Pi was not found on PATH. Install it with `npm install -g @earendil-works/pi-coding-agent`, or point the extension at the binary.',
        );
      } else {
        this.setState('error', message);
      }
    } finally {
      this.starting = false;
    }
  }

  private async stopSession(): Promise<void> {
    if (!this.session.alive) return;
    const exited = new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const disposable = this.session.onExit(() => {
        disposable.dispose();
        if (timer) clearTimeout(timer);
        resolve();
      });
      timer = setTimeout(() => {
        disposable.dispose();
        resolve();
      }, 2000);
    });
    this.session.kill();
    await exited;
  }

  private readonly pendingInput: string[] = [];

  private write(data: string): void {
    if (this.session.alive) {
      this.session.write(data);
      return;
    }
    if (this.pendingInput.length > 64) this.pendingInput.shift();
    this.pendingInput.push(data);
    void this.ensureStarted();
  }

  private flushPending(): void {
    if (!this.pendingInput.length) return;
    const queued = this.pendingInput.join('');
    this.pendingInput.length = 0;
    this.session.write(queued);
  }

  private handleData(data: string): void {
    // node-pty can deliver a trailing data chunk after `exit` has fired. That must
    // still be shown, but it must not resurrect a dead session's state.
    if (this.state !== 'running' && this.session.alive) this.setState('running');
    this.post({ type: 'data', data });
  }

  private handleExit(exitCode: number): void {
    this.output.appendLine(`[exit] code=${exitCode}`);
    if (this.disposed) return;
    if (this.pendingRestart) return;
    this.setState('exited', `Pi exited with code ${exitCode}.`);
  }

  private buildEnv(settings: PiSettings, cwd: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (INHERITED_PI_ENV.includes(key)) continue;
      if (key === 'NO_COLOR') continue;
      env[key] = value;
    }
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'vscode';
    env.TERM_PROGRAM_VERSION = vscode.version;
    env.FORCE_COLOR = '1';
    env.PWD = cwd;
    if (!env.LANG) env.LANG = 'en_US.UTF-8';
    for (const [key, value] of Object.entries(settings.env ?? {})) {
      if (typeof value === 'string') env[key] = value;
    }
    return env;
  }

  // ------------------------------------------------------------------- state

  private setState(state: PiState, message = ''): void {
    this.state = state;
    this.stateMessage = message;
    if (state === 'running') this.stateMessage = '';
    this.post({ type: 'state', state, message: this.stateMessage });
    void vscode.commands.executeCommand('setContext', 'pi-for-vscode.hasSession', this.session.alive);
    this.stateEmitter.fire();
  }

  private postInit(): void {
    this.post({
      type: 'init',
      settings: webviewSettings(this.settings),
      state: this.state,
      message: this.stateMessage,
      cwd: this.currentCwd,
      executable: this.launch?.piPath,
      autoStart: this.settings.autoStart,
      kind: this.host.kind,
    });
    void this.ensureStarted();
  }

  private post(message: unknown): void {
    if (this.disposed) return;
    void Promise.resolve(this.host.webview.postMessage(message)).catch(() => undefined);
  }

  // ---------------------------------------------------------------- commands

  private async openExternal(url: string): Promise<void> {
    try {
      const uri = vscode.Uri.parse(url, true);
      if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
        await vscode.env.openExternal(uri);
      }
    } catch (error) {
      this.output.appendLine(`[link] failed to open ${url}: ${String(error)}`);
    }
  }

  private async openFile(candidate: string, line?: number, column?: number): Promise<void> {
    const cwd = this.currentCwd ?? resolveCwd(this.settings);
    const cleaned = candidate.replace(/^[("'`\[]+/, '').replace(/[)"'`\],.;]+$/, '');
    if (!cleaned) return;

    const expanded = expandHome(cleaned);
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);

    let stat: fs.Stats | undefined;
    try {
      stat = await fs.promises.stat(absolute);
    } catch {
      stat = undefined;
    }

    const target = stat?.isDirectory() ? absolute : absolute;
    if (!stat) {
      this.output.appendLine(`[link] not found: ${absolute}`);
      return;
    }

    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      const editor = await vscode.window.showTextDocument(document, { preview: true });
      if (typeof line === 'number' && line > 0) {
        const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, (column ?? 1) - 1));
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch (error) {
      this.output.appendLine(`[link] failed to open ${absolute}: ${String(error)}`);
    }
  }
}
