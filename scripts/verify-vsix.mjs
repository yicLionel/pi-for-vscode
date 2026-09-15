/**
 * Verifies the packaged .vsix by extracting it exactly like VS Code does and
 * running the headless activation test against the extracted extension.
 *
 * Usage: node scripts/verify-vsix.mjs [path/to.vsix]
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const vsix =
  process.argv[2] ??
  fs
    .readdirSync(root)
    .filter((name) => name.endsWith('.vsix'))
    .sort()
    .pop();

if (!vsix) {
  console.error('No .vsix found — run `npm run package` first.');
  process.exit(1);
}

const vsixPath = path.isAbsolute(vsix) ? vsix : path.join(root, vsix);
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-vsix-'));
const extractDir = path.join(workDir, 'unpacked');

console.log(`\nVerifying ${path.basename(vsixPath)}\n`);
console.log(`  extracting to ${extractDir}`);

const unzip = spawnSync('unzip', ['-q', vsixPath, '-d', extractDir], { stdio: 'inherit' });
if (unzip.status !== 0) {
  console.error('failed to extract the vsix');
  process.exit(1);
}

const extensionDir = path.join(extractDir, 'extension');
for (const required of ['dist/extension.js', 'media/main.js', 'media/main.css', 'package.json', 'node_modules/@homebridge/node-pty-prebuilt-multiarch/package.json']) {
  const target = path.join(extensionDir, required);
  if (!fs.existsSync(target)) {
    console.error(`  ✗ packaged extension is missing ${required}`);
    process.exit(1);
  }
  console.log(`  ✓ contains ${required}`);
}

// Drop the activation harness into the extracted extension and run it there.
fs.mkdirSync(path.join(extensionDir, 'scripts'), { recursive: true });
fs.copyFileSync(
  path.join(root, 'scripts', 'activation-check.cjs'),
  path.join(extensionDir, 'scripts', 'activation-check.cjs'),
);

const runtimes = [{ name: 'node', command: process.execPath, env: {} }];
const helper = '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)';
if (process.platform === 'darwin' && fs.existsSync(helper)) {
  runtimes.push({ name: 'vscode electron', command: helper, env: { ELECTRON_RUN_AS_NODE: '1' } });
}

let failed = false;
for (const runtime of runtimes) {
  console.log(`\n  running activation test with ${runtime.name}:`);
  const result = spawnSync(runtime.command, [path.join(extensionDir, 'scripts', 'activation-check.cjs')], {
    stdio: 'inherit',
    cwd: extensionDir,
    env: { ...process.env, ...runtime.env },
  });
  if (result.status !== 0) failed = true;
}

fs.rmSync(workDir, { recursive: true, force: true });

if (failed) {
  console.error('\npackaged extension verification FAILED\n');
  process.exit(1);
}
console.log('\npackaged extension verified successfully\n');
