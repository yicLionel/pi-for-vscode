/**
 * Thin wrapper around a node-pty process running the Pi TUI.
 *
 * Deliberately free of `vscode` imports so it can be tested headlessly.
 */
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';

type PtyModule = typeof import('@homebridge/node-pty-prebuilt-multiarch');

let ptyModule: PtyModule | undefined;
let ptyLoadError: Error | undefined;

function loadPty(): PtyModule {
  if (ptyModule) return ptyModule;
  if (ptyLoadError) throw ptyLoadError;
  try {
    // Lazy require so a broken native module only breaks spawning, not activation.
    ptyModule = require('@homebridge/node-pty-prebuilt-multiarch') as PtyModule;
    return ptyModule;
  } catch (error) {
    ptyLoadError = error instanceof Error ? error : new Error(String(error));
    throw ptyLoadError;
  }
}

export interface PiSpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
}

export interface PiExitEvent {
  exitCode: number;
  signal?: number;
}

export interface Disposable {
  dispose(): void;
}

type Listener<T> = (value: T) => void;

class Signal<T> {
  private readonly listeners = new Set<Listener<T>>();

  add(listener: Listener<T>): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A failing listener must not take down the terminal stream.
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export class PiSession {
  private pty: IPty | undefined;
  private killed = false;
  private _pid: number | undefined;

  private readonly dataSignal = new Signal<string>();
  private readonly exitSignal = new Signal<PiExitEvent>();
  private readonly titleSignal = new Signal<string>();

  constructor(readonly id: string) {}

  readonly onData: (listener: Listener<string>) => Disposable = (listener) => this.dataSignal.add(listener);
  readonly onExit: (listener: Listener<PiExitEvent>) => Disposable = (listener) => this.exitSignal.add(listener);
  readonly onTitle: (listener: Listener<string>) => Disposable = (listener) => this.titleSignal.add(listener);

  get pid(): number | undefined {
    return this._pid;
  }

  get alive(): boolean {
    return this.pty !== undefined;
  }

  spawn(options: PiSpawnOptions): void {
    if (this.pty) throw new Error('PiSession.spawn() called twice');

    const pty = loadPty();
    const cols = Math.max(1, Math.floor(options.cols) || 80);
    const rows = Math.max(1, Math.floor(options.rows) || 24);

    const proc = pty.spawn(options.file, options.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd,
      env: options.env as Record<string, string>,
      encoding: 'utf8',
    } as Parameters<PtyModule['spawn']>[2]);

    this.pty = proc;
    this._pid = proc.pid;
    this.killed = false;

    proc.onData((data) => this.dataSignal.emit(typeof data === 'string' ? data : String(data)));
    proc.onExit(({ exitCode, signal }) => {
      this.pty = undefined;
      this._pid = undefined;
      this.exitSignal.emit({ exitCode, signal: typeof signal === 'number' ? signal : undefined });
    });

    // Title reporting (OSC 0/2) is best effort and absent on some platforms.
    const maybeTitle = proc as unknown as { on?: (event: string, cb: (title: string) => void) => void };
    maybeTitle.on?.('title', (title: string) => this.titleSignal.emit(title));
  }

  write(data: string): void {
    if (!data) return;
    try {
      this.pty?.write(data);
    } catch {
      // Process may have exited between the check and the write.
    }
  }

  resize(cols: number, rows: number): void {
    const safeCols = Math.max(1, Math.floor(cols) || 0);
    const safeRows = Math.max(1, Math.floor(rows) || 0);
    if (!this.pty || !safeCols || !safeRows) return;
    try {
      this.pty.resize(safeCols, safeRows);
    } catch {
      // Resizing a dead pty throws on some platforms.
    }
  }

  kill(): void {
    if (!this.pty || this.killed) return;
    this.killed = true;
    const proc = this.pty;
    try {
      proc.kill();
    } catch {
      // ignore
    }
    // Escalate if the process ignores SIGHUP.
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2000);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  }

  dispose(): void {
    this.kill();
    this.dataSignal.clear();
    this.exitSignal.clear();
    this.titleSignal.clear();
  }
}
