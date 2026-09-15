/**
 * Headless build target: bundles the vscode-free modules so `scripts/smoke.mjs`
 * can exercise the real production code with plain Node.
 */
export { PiSession } from './piSession';
export { expandHome, findPiExecutable, resolveLaunchCommand } from './piLocator';
