/**
 * Locates the `pi` executable and works out how to launch it.
 *
 * This module is intentionally free of any `vscode` imports so it can be
 * exercised headlessly (see src/testable.ts and scripts/smoke.mjs).
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

export interface LaunchCommand {
  /** Executable that node-pty should spawn. */
  file: string;
  /** Full argument vector (already contains the pi entry point when an interpreter is needed). */
  args: string[];
  /** Resolved path to the pi entry point. */
  piPath: string;
  /** Whether an interpreter (node/bun/...) had to be resolved. */
  kind: 'interpreter' | 'direct';
  /** Human readable description for logs. */
  description: string;
}

export function expandHome(input: string): string {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~' + path.sep)) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function isExecutable(candidate: string): Promise<boolean> {
  if (!(await isFile(candidate))) return false;
  if (IS_WINDOWS) return true;
  try {
    await fs.promises.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binaryNames(binary: string): string[] {
  return IS_WINDOWS ? [`${binary}.cmd`, `${binary}.exe`, `${binary}.bat`, binary] : [binary];
}

function wellKnownDirs(): string[] {
  const home = os.homedir();
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return [
      path.join(appData, 'npm'),
      path.join(localAppData, 'pnpm'),
      path.join(localAppData, 'Yarn', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.local', 'bin'),
    ];
  }
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.bun', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/local/bin',
    '/usr/bin',
  ];
}

/** Expands `<base>/<version>/bin` style directories (pi-node, nvm, fnm, n, ...). */
async function versionedBinDirs(): Promise<string[]> {
  const home = os.homedir();
  const bases: string[] = IS_WINDOWS
    ? [
        path.join(home, 'AppData', 'Roaming', 'nvm'),
        path.join(home, '.volta', 'tools', 'image', 'node'),
      ]
    : [
        path.join(home, '.local', 'share', 'pi-node'),
        path.join(home, '.nvm', 'versions', 'node'),
        path.join(home, '.local', 'share', 'fnm', 'node-versions'),
        path.join(home, '.fnm', 'node-versions'),
        path.join(home, '.n', 'versions', 'node'),
        path.join(home, '.nodenv', 'versions'),
        path.join(home, '.asdf', 'installs', 'nodejs'),
      ];

  const out: string[] = [];
  for (const base of bases) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    // Newest versions first is not required, but keeps deterministic ordering.
    const names = entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const name of names) {
      const roots = [path.join(base, name), path.join(base, name, 'installation')];
      for (const root of roots) {
        out.push(path.join(root, 'bin'));
        out.push(root); // nvm-windows keeps node.exe directly in the version dir
      }
    }
  }
  return out;
}

function pathDirs(): string[] {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

/** Asks the user's login shell for its PATH (GUI apps often miss nvm/homebrew). */
async function loginShellDirs(): Promise<string[]> {
  if (IS_WINDOWS) return [];
  const shell = process.env.SHELL || '/bin/sh';
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      ['-ilc', 'printf "%s" "$PATH"'],
      { timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error && !stdout) return resolve([]);
        resolve(String(stdout).split(path.delimiter).filter(Boolean));
      },
    );
    child.on('error', () => resolve([]));
  });
}

async function firstMatch(dirs: Iterable<string>, names: string[]): Promise<string | undefined> {
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

let cachedLoginDirs: string[] | undefined;

export async function findPiExecutable(): Promise<string | undefined> {
  const configured = process.env.PI_EXECUTABLE;
  if (configured) {
    const expanded = expandHome(configured);
    if (await isExecutable(expanded)) return expanded;
  }

  const names = binaryNames('pi');

  const direct = await firstMatch(pathDirs(), names);
  if (direct) return direct;

  const wellKnown = await firstMatch(wellKnownDirs(), names);
  if (wellKnown) return wellKnown;

  const versioned = await firstMatch(await versionedBinDirs(), names);
  if (versioned) return versioned;

  if (cachedLoginDirs === undefined) cachedLoginDirs = await loginShellDirs();
  return firstMatch(cachedLoginDirs, names);
}

async function readShebang(file: string): Promise<string | undefined> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head[0] !== 0x23 || head[1] !== 0x21) return undefined; // '#!'
    const line = head.toString('utf8').split('\n', 1)[0].slice(2).trim();
    return line || undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Extracts the interpreter name from a shebang line. */
function interpreterFromShebang(shebang: string): string | undefined {
  const parts = shebang.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const base = path.basename(parts[0]);
  if (base !== 'env') return base;
  // `#!/usr/bin/env node`, `#!/usr/bin/env -S node --experimental-x`
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('-')) continue;
    return path.basename(part);
  }
  return undefined;
}

async function findInterpreter(interpreter: string, piPath: string): Promise<string | undefined> {
  // 1. A sibling interpreter wins: the pi-node distribution ships its own node.
  const sibling = path.join(path.dirname(piPath), interpreter);
  if (await isExecutable(sibling)) return sibling;

  let realDir: string | undefined;
  try {
    realDir = path.dirname(await fs.promises.realpath(piPath));
  } catch {
    realDir = undefined;
  }
  if (realDir) {
    const siblingReal = path.join(realDir, interpreter);
    if (await isExecutable(siblingReal)) return siblingReal;
  }

  // 2. Anything on PATH / well known locations.
  const names = binaryNames(interpreter);
  const fromPath = await firstMatch(pathDirs(), names);
  if (fromPath) return fromPath;
  const fromWellKnown = await firstMatch(wellKnownDirs(), names);
  if (fromWellKnown) return fromWellKnown;

  if (cachedLoginDirs === undefined) cachedLoginDirs = await loginShellDirs();
  return firstMatch(cachedLoginDirs, names);
}

/**
 * Works out the concrete spawn arguments for a resolved pi entry point.
 * `pi` is usually a `#!/usr/bin/env node` script, which breaks when node is
 * not on the extension host PATH — so we prefer an explicit interpreter.
 */
export async function resolveLaunchCommand(piPath: string, extraArgs: string[] = []): Promise<LaunchCommand> {
  // Windows npm shims are .cmd/.bat files, which CreateProcess cannot run
  // directly — they have to go through cmd.exe.
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(piPath)) {
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    return {
      file: comspec,
      args: ['/d', '/s', '/c', piPath, ...extraArgs],
      piPath,
      kind: 'interpreter',
      description: `${comspec} /c ${piPath}`,
    };
  }

  const shebang = await readShebang(piPath);
  const interpreter = shebang ? interpreterFromShebang(shebang) : undefined;

  if (interpreter) {
    const resolved = await findInterpreter(interpreter, piPath);
    if (resolved) {
      return {
        file: resolved,
        args: [piPath, ...extraArgs],
        piPath,
        kind: 'interpreter',
        description: `${resolved} ${piPath}`,
      };
    }
  }

  return {
    file: piPath,
    args: extraArgs,
    piPath,
    kind: 'direct',
    description: piPath,
  };
}
