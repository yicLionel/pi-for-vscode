import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  legalComments: 'none',
};

/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...common,
  entryPoints: [path.join(root, 'src/extension.ts')],
  outfile: path.join(root, 'dist/extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // node-pty is a native module: it must stay external so it can resolve its
  // prebuilt binaries relative to its own package directory at runtime.
  external: ['vscode', '@homebridge/node-pty-prebuilt-multiarch'],
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  ...common,
  entryPoints: [path.join(root, 'src/webview/main.ts')],
  outfile: path.join(root, 'media/main.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
};

/** Headless harness used by `npm run smoke`. */
const testable = {
  ...common,
  entryPoints: [path.join(root, 'src/testable.ts')],
  outfile: path.join(root, 'dist/testable.mjs'),
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // Keep the native module external so node-pty resolves its own prebuilds from
  // node_modules (bundling its JS would break its __dirname-based lookup).
  external: ['@homebridge/node-pty-prebuilt-multiarch'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
};

const targets = [extension, webview, testable];
const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[esbuild] watching…');
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  console.log(`[esbuild] build complete${production ? ' (production)' : ''}`);
}
