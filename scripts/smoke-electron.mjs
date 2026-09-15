/**
 * Runs the activation test inside VS Code's own Electron runtime.
 *
 * This is the strongest local guarantee that the native PTY module matches the
 * ABI of the extension host (prebuilt N-API binaries are ABI independent, but
 * this proves it on the machine that will run the extension).
 *
 * Skips gracefully when VS Code cannot be located.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = path.join(root, 'scripts', 'activation-check.cjs');

const CANDIDATES = [
  '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
  '/Applications/Visual Studio Code - Insiders.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
  '/snap/code/current/usr/share/code/code',
  '/usr/share/code/code',
];

function findHelper() {
  if (process.env.VSCODE_HELPER && fs.existsSync(process.env.VSCODE_HELPER)) return process.env.VSCODE_HELPER;
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const helper = findHelper();
if (!helper) {
  console.log('VS Code runtime not found — skipping the Electron ABI check.');
  process.exit(0);
}

console.log(`Using VS Code runtime: ${helper}\n`);
const result = spawnSync(helper, [check], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

process.exit(result.status ?? 1);
