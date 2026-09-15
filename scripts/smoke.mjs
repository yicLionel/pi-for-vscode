/**
 * End-to-end smoke test for the parts of the extension that do not need a
 * VS Code window: pi discovery, launch resolution, and the real PTY session.
 *
 * Tests that need pi or a POSIX shell are skipped (not failed) when unavailable,
 * so this runs unchanged on CI.
 *
 * Run with: npm run smoke
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testablePath = path.join(root, 'dist', 'testable.mjs');

if (!fs.existsSync(testablePath)) {
  console.error('dist/testable.mjs missing — run `npm run compile` first.');
  process.exit(1);
}

const { PiSession, findPiExecutable, resolveLaunchCommand, expandHome } = await import(
  pathToFileURL(testablePath).href
);

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  - ${name} (skipped: ${reason})`);
}

function spawnShell(script, cols, rows) {
  const session = new PiSession('smoke');
  const chunks = [];
  session.onData((data) => chunks.push(data));
  const exit = new Promise((resolve) => session.onExit((event) => resolve(event)));
  session.spawn({
    file: '/bin/sh',
    args: ['-c', script],
    cwd: root,
    env: { ...process.env, TERM: 'xterm-256color' },
    cols,
    rows,
  });
  return { session, chunks, exit };
}

console.log('\nPi for VS Code — smoke tests\n');

// ------------------------------------------------------------------ pure logic

await test('expandHome resolves ~', () => {
  assert.notEqual(expandHome('~'), '~');
  assert.ok(expandHome('~/foo').endsWith(`${path.sep}foo`));
});

await test('build artifacts exist', () => {
  for (const artifact of ['dist/extension.js', 'media/main.js', 'media/main.css', 'media/pi.svg', 'media/icon.png']) {
    assert.ok(fs.existsSync(path.join(root, artifact)), `missing ${artifact}`);
  }
});

// ------------------------------------------------------------- pi and launching

const piPath = await findPiExecutable();
const hasPosixShell = process.platform !== 'win32';
const piReason = 'pi is not installed in this environment';

if (piPath) {
  await test('findPiExecutable locates pi', () => {
    assert.ok(fs.existsSync(piPath), `resolved path does not exist: ${piPath}`);
    console.log(`      -> ${piPath}`);
  });

  await test('resolveLaunchCommand prefers the bundled node interpreter', async () => {
    const launch = await resolveLaunchCommand(piPath, ['--version']);
    assert.equal(launch.kind, 'interpreter', `expected an interpreter launch, got ${launch.kind}`);
    assert.match(path.basename(launch.file), /^(node|cmd|cmd\.exe)(\.exe)?$/i);
    assert.equal(launch.args[0], piPath);
    assert.deepEqual(launch.args.slice(1), ['--version']);
    console.log(`      -> ${launch.description}`);
  });
} else {
  skip('findPiExecutable locates pi', piReason);
  skip('resolveLaunchCommand prefers the bundled node interpreter', piReason);
}

// ------------------------------------------------------------------------ PTY

if (hasPosixShell) {
  await test('node-pty spawns a real pty and reports a TTY', async () => {
    const { session, chunks, exit } = spawnShell(
      'if [ -t 1 ]; then echo TTY_YES; else echo TTY_NO; fi; printf "\\033[31mred\\033[0m\\n"',
      100,
      30,
    );
    const result = await exit;
    const output = chunks.join('');
    assert.equal(result.exitCode, 0);
    assert.match(output, /TTY_YES/, `expected a TTY, got ${JSON.stringify(output)}`);
    assert.match(output, /\u001b\[31mred/, 'expected ANSI colour sequences to pass through');
    session.dispose();
  });

  await test('PTY resize and stdin round-trip', async () => {
    const { session, chunks, exit } = spawnShell('read line; echo "PONG:$line"; stty size', 90, 40);
    session.resize(120, 50);
    setTimeout(() => session.write('hello\r'), 200);
    const result = await exit;

    const output = chunks.join('');
    assert.equal(result.exitCode, 0);
    assert.match(output, /PONG:hello/);
    assert.match(output, /50 120/, `expected the resized geometry, got ${JSON.stringify(output)}`);
    session.dispose();
  });
} else {
  skip('node-pty spawns a real pty and reports a TTY', 'requires a POSIX shell');
  skip('PTY resize and stdin round-trip', 'requires a POSIX shell');
}

if (piPath) {
  await test('pi runs end-to-end in the pty with the resolved interpreter', async () => {
    const launch = await resolveLaunchCommand(piPath, ['--version']);
    const session = new PiSession('smoke-pi');
    const chunks = [];
    session.onData((data) => chunks.push(data));
    const exit = new Promise((resolve) => session.onExit((event) => resolve(event)));

    session.spawn({
      file: launch.file,
      args: launch.args,
      cwd: root,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      cols: 100,
      rows: 30,
    });

    const result = await exit;
    const output = chunks.join('').replace(/\u001b\[[0-9;]*m/g, '').trim();
    assert.equal(result.exitCode, 0, `pi --version exited with ${result.exitCode}: ${output}`);
    assert.match(output, /\d+\.\d+\.\d+/, `unexpected version output: ${JSON.stringify(output)}`);
    console.log(`      -> pi ${output.split('\n').pop()}`);
    session.dispose();
  });
} else {
  skip('pi runs end-to-end in the pty with the resolved interpreter', piReason);
}

const summary = [`${passed} passed`, failed ? `${failed} failed` : undefined, skipped ? `${skipped} skipped` : undefined]
  .filter(Boolean)
  .join(', ');
console.log(`\n${summary}\n`);
process.exit(failed === 0 ? 0 : 1);
