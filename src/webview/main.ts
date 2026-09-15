import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { ILink, ITerminalOptions, ITheme, Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './webview.css';

// ---------------------------------------------------------------- VS Code API

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// --------------------------------------------------------------------- types

interface WebviewSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  scrollback: number;
  fileLinks: boolean;
}

type PiState = 'idle' | 'starting' | 'running' | 'exited' | 'error';

const DEFAULT_SETTINGS: WebviewSettings = {
  fontFamily: '',
  fontSize: 0,
  lineHeight: 0,
  cursorBlink: true,
  scrollback: 10000,
  fileLinks: true,
};

// ---------------------------------------------------------------------- dom

const terminalEl = document.getElementById('pi-terminal') as HTMLDivElement;
const overlayEl = document.getElementById('pi-overlay') as HTMLDivElement;
const overlayTitleEl = document.getElementById('pi-overlay-title') as HTMLDivElement;
const overlayMessageEl = document.getElementById('pi-overlay-message') as HTMLDivElement;
const overlayActionsEl = document.getElementById('pi-overlay-actions') as HTMLDivElement;
const menuEl = document.getElementById('pi-menu') as HTMLDivElement;

// -------------------------------------------------------------------- theme

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

function isDarkTheme(): boolean {
  return !document.body.classList.contains('vscode-light');
}

function buildTheme(): ITheme {
  const dark = isDarkTheme();
  const background = cssVar('--vscode-terminal-background', cssVar('--vscode-editor-background', dark ? '#1e1e1e' : '#ffffff'));
  const foreground = cssVar('--vscode-terminal-foreground', cssVar('--vscode-editor-foreground', dark ? '#cccccc' : '#333333'));
  const ansi = (name: string, fallback: string) => cssVar(`--vscode-terminal-ansi${name}`, fallback);

  return {
    background,
    foreground,
    cursor: cssVar('--vscode-terminalCursor-foreground', foreground),
    cursorAccent: background,
    selectionBackground: cssVar('--vscode-terminal-selectionBackground', 'rgba(128, 128, 128, 0.4)'),
    selectionInactiveBackground: cssVar('--vscode-terminal-inactiveSelectionBackground', 'rgba(128, 128, 128, 0.2)'),
    black: ansi('Black', '#000000'),
    red: ansi('Red', '#cd3131'),
    green: ansi('Green', '#0dbc79'),
    yellow: ansi('Yellow', '#e5e510'),
    blue: ansi('Blue', '#2472c8'),
    magenta: ansi('Magenta', '#bc3fbc'),
    cyan: ansi('Cyan', '#11a8cd'),
    white: ansi('White', '#e5e5e5'),
    brightBlack: ansi('BrightBlack', '#666666'),
    brightRed: ansi('BrightRed', '#f14c4c'),
    brightGreen: ansi('BrightGreen', '#23d18b'),
    brightYellow: ansi('BrightYellow', '#f5f543'),
    brightBlue: ansi('BrightBlue', '#3b8eea'),
    brightMagenta: ansi('BrightMagenta', '#d670d6'),
    brightCyan: ansi('BrightCyan', '#29b8db'),
    brightWhite: ansi('BrightWhite', '#ffffff'),
  };
}

let settings: WebviewSettings = { ...DEFAULT_SETTINGS };

function fontOptions(): Pick<ITerminalOptions, 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight'> {
  const family = settings.fontFamily || cssVar('--vscode-editor-font-family', 'Menlo, Monaco, "Courier New", monospace');
  const editorSize = Number.parseInt(cssVar('--vscode-editor-font-size', '13'), 10);
  const size = settings.fontSize > 0 ? settings.fontSize : Number.isFinite(editorSize) && editorSize > 0 ? editorSize : 13;
  return {
    fontFamily: family,
    fontSize: size,
    fontWeight: cssVar('--vscode-editor-font-weight', 'normal') as ITerminalOptions['fontWeight'],
    lineHeight: settings.lineHeight > 0 ? settings.lineHeight : 1.2,
  };
}

// ----------------------------------------------------------------- terminal

const terminal = new Terminal({
  allowProposedApi: true,
  cursorBlink: settings.cursorBlink,
  cursorStyle: 'bar',
  scrollback: settings.scrollback,
  theme: buildTheme(),
  macOptionIsMeta: true,
  rightClickSelectsWord: false,
  smoothScrollDuration: 0,
  drawBoldTextInBrightColors: false,
  ...fontOptions(),
});

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);

terminal.loadAddon(
  new WebLinksAddon((event, uri) => {
    // Match the VS Code terminal: links require a modifier click.
    if (!(event.metaKey || event.ctrlKey)) return;
    vscode.postMessage({ type: 'openExternal', url: uri });
  }),
);

terminal.open(terminalEl);

try {
  const webgl = new WebglAddon();
  webgl.onContextLoss(() => webgl.dispose());
  terminal.loadAddon(webgl);
} catch {
  // The DOM renderer is a perfectly good fallback.
}

// ----------------------------------------------------------------- signaling

function sendInput(data: string): void {
  if (!data) return;
  vscode.postMessage({ type: 'input', data });
}

function pasteText(text: string): void {
  if (!text) return;
  sendInput(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
}

terminal.onData((data) => sendInput(data));

// -------------------------------------------------------------------- resizing

let fitScheduled = false;
let lastCols = 0;
let lastRows = 0;

function fitNow(): void {
  if (terminalEl.clientWidth < 24 || terminalEl.clientHeight < 24) return;
  try {
    fitAddon.fit();
  } catch {
    return;
  }
  if (terminal.cols === lastCols && terminal.rows === lastRows) return;
  lastCols = terminal.cols;
  lastRows = terminal.rows;
  vscode.postMessage({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
}

function scheduleFit(): void {
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    fitNow();
  });
}

new ResizeObserver(() => scheduleFit()).observe(terminalEl);
window.addEventListener('resize', scheduleFit);
document.fonts?.ready.then(() => scheduleFit()).catch(() => undefined);

// ------------------------------------------------------------- clipboard/keys

function copySelection(): void {
  const selection = terminal.getSelection();
  if (selection) vscode.postMessage({ type: 'copy', text: selection });
}

function requestPaste(): void {
  vscode.postMessage({ type: 'paste' });
}

terminal.attachCustomKeyEventHandler((event) => {
  if (event.type !== 'keydown') return true;
  const isMac = /mac/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent);
  const key = event.key.toLowerCase();

  const wantsCopy = isMac
    ? event.metaKey && !event.ctrlKey && key === 'c'
    : (event.ctrlKey && key === 'c' && !event.shiftKey && terminal.hasSelection()) ||
      (event.ctrlKey && event.shiftKey && key === 'c');
  if (wantsCopy) {
    copySelection();
    return false;
  }

  const wantsPaste =
    (isMac && event.metaKey && !event.ctrlKey && key === 'v') ||
    (!isMac && event.ctrlKey && !event.shiftKey && key === 'v') ||
    (!isMac && event.ctrlKey && event.shiftKey && key === 'v') ||
    (event.shiftKey && key === 'insert');
  if (wantsPaste) {
    requestPaste();
    return false;
  }

  // VS Code owns OS-level and command-palette shortcuts.
  if (isMac && event.metaKey) return false;
  if (!isMac && event.ctrlKey && event.shiftKey) return false;
  if (event.key === 'F1') return false;
  return true;
});

// ------------------------------------------------------------ file path links

const FILE_EXTENSIONS =
  'ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|pyi|rs|go|java|c|h|cc|cpp|hpp|cs|rb|php|sh|bash|zsh|fish|yml|yaml|toml|ini|cfg|conf|env|html|htm|css|scss|sass|less|sql|kt|kts|swift|vue|svelte|astro|graphql|gql|xml|txt|lock|tf|proto|ex|exs|erl|hs|ml|lua|pl|pm|r|scala|clj|cljs|dart|zig|nim|jl|gradle|properties';

const FILE_PATTERN = new RegExp(
  `(?<![\\w.\\-/])((?:~\\/|\\.{1,2}\\/|\\/)?(?:[\\w.@+-]+\\/)*[\\w.@+-]+\\.(?:${FILE_EXTENSIONS}))(?::(\\d+))?(?::(\\d+))?`,
  'gi',
);

let linkDisposable: { dispose(): void } | undefined;

function installFileLinks(): void {
  linkDisposable?.dispose();
  linkDisposable = undefined;
  if (!settings.fileLinks) return;

  linkDisposable = terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const links: ILink[] = [];
      FILE_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = FILE_PATTERN.exec(text)) !== null) {
        const file = match[1];
        const lineNumber = match[2] ? Number.parseInt(match[2], 10) : undefined;
        const column = match[3] ? Number.parseInt(match[3], 10) : undefined;
        const start = match.index;
        links.push({
          text: match[0],
          range: {
            start: { x: start + 1, y: bufferLineNumber },
            end: { x: start + match[0].length, y: bufferLineNumber },
          },
          activate(event) {
            if (!(event.metaKey || event.ctrlKey)) return;
            vscode.postMessage({ type: 'openFile', path: file, line: lineNumber, column });
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  });
}

// -------------------------------------------------------------------- overlay

interface OverlayAction {
  label: string;
  action: string;
  primary?: boolean;
}

function showOverlay(title: string, message: string, actions: OverlayAction[]): void {
  overlayTitleEl.textContent = title;
  overlayMessageEl.textContent = message;
  overlayActionsEl.replaceChildren();
  for (const item of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.className = item.primary ? 'pi-button pi-button-primary' : 'pi-button';
    button.addEventListener('click', () => vscode.postMessage({ type: 'action', action: item.action }));
    overlayActionsEl.appendChild(button);
  }
  overlayEl.hidden = false;
}

function hideOverlay(): void {
  overlayEl.hidden = true;
}

let currentState: PiState = 'idle';
let autoStart = true;

function applyState(state: PiState, message: string | undefined): void {
  currentState = state;
  switch (state) {
    case 'starting':
      showOverlay('Starting Pi', 'Launching the Pi coding agent…', []);
      break;
    case 'running':
      hideOverlay();
      terminal.focus();
      scheduleFit();
      break;
    case 'idle':
      if (autoStart) hideOverlay();
      else
        showOverlay('Pi is not running', 'Start Pi to open the coding agent in this terminal.', [
          { label: 'Start Pi', action: 'start', primary: true },
        ]);
      break;
    case 'error':
      showOverlay('Pi could not start', message || 'Unknown error.', [
        { label: 'Retry', action: 'retry', primary: true },
        { label: 'Set pi path…', action: 'pickExecutable' },
        { label: 'Open settings', action: 'openSettings' },
        { label: 'Show logs', action: 'showOutput' },
      ]);
      break;
    case 'exited':
      showOverlay('Pi exited', message || 'The Pi process has exited.', [
        { label: 'Restart', action: 'restart', primary: true },
        { label: 'Show logs', action: 'showOutput' },
      ]);
      break;
  }
}

// ------------------------------------------------------------ context menu

interface MenuItem {
  label: string;
  run?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

function closeMenu(): void {
  menuEl.hidden = true;
}

function openMenu(x: number, y: number): void {
  const items: MenuItem[] = [
    { label: 'Copy', disabled: !terminal.hasSelection(), run: copySelection },
    { label: 'Paste', run: requestPaste },
    { label: 'Select All', run: () => terminal.selectAll() },
    { separator: true, label: '' },
    { label: 'Clear', run: () => sendInput('\x0c') },
    { label: 'Restart Pi', run: () => vscode.postMessage({ type: 'action', action: 'restart' }) },
    { label: 'Kill Pi', run: () => vscode.postMessage({ type: 'action', action: 'kill' }) },
  ];

  menuEl.replaceChildren();
  for (const item of items) {
    if (item.separator) {
      const separator = document.createElement('div');
      separator.className = 'pi-menu-separator';
      menuEl.appendChild(separator);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pi-menu-item';
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    button.addEventListener('click', () => {
      closeMenu();
      item.run?.();
    });
    menuEl.appendChild(button);
  }

  menuEl.hidden = false;
  const rect = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

terminalEl.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  openMenu(event.clientX, event.clientY);
});
window.addEventListener('pointerdown', (event) => {
  if (!menuEl.hidden && !menuEl.contains(event.target as Node)) closeMenu();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
window.addEventListener('blur', closeMenu);

// -------------------------------------------------------------- theme updates

let themeTimer = 0;
function scheduleThemeRefresh(): void {
  if (themeTimer) return;
  themeTimer = window.setTimeout(() => {
    themeTimer = 0;
    terminal.options.theme = buildTheme();
    scheduleFit();
  }, 60);
}

new MutationObserver(scheduleThemeRefresh).observe(document.body, {
  attributes: true,
  attributeFilter: ['class', 'style'],
});
new MutationObserver(scheduleThemeRefresh).observe(document.head, { childList: true, subtree: true });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', scheduleThemeRefresh);

// -------------------------------------------------------------- settings/messages

function applySettings(next: WebviewSettings): void {
  settings = { ...DEFAULT_SETTINGS, ...next };
  Object.assign(terminal.options, fontOptions(), {
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
  });
  installFileLinks();
  scheduleFit();
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = (event.data ?? {}) as Record<string, unknown>;
  switch (message.type) {
    case 'init': {
      if (message.settings) applySettings(message.settings as WebviewSettings);
      autoStart = message.autoStart !== false;
      applyState((message.state as PiState) || 'idle', message.message as string | undefined);
      break;
    }
    case 'settings':
      if (message.settings) applySettings(message.settings as WebviewSettings);
      break;
    case 'state':
      applyState((message.state as PiState) || 'idle', message.message as string | undefined);
      break;
    case 'data':
      terminal.write(String(message.data ?? ''));
      if (currentState !== 'running') {
        currentState = 'running';
        hideOverlay();
      }
      break;
    case 'refit':
      scheduleFit();
      break;
    case 'focus':
      terminal.focus();
      break;
    default:
      break;
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleFit();
});

// ------------------------------------------------------------------- bootstrap

scheduleFit();
vscode.postMessage({ type: 'ready' });
