# Changelog

## 0.1.2

- New: **New Pi Conversation (in the TUI)** starts a fresh conversation in the
  sidebar window by sending `/new`, instead of opening another editor tab. The
  sidebar toolbar's `+` button now does this.
- New: **Switch Pi Conversation (History)** opens pi's own conversation history
  picker via `/resume` (folder/all scope, search, rename, delete).
- New: **Cycle Pi Session Windows** moves focus through the sidebar and any
  editor-tab sessions. Palette only.
- `New Pi Terminal (Editor Tab)` keeps its command but moves to the end of the
  sidebar toolbar with a distinct icon.

## 0.1.1

- Fix: a late terminal chunk arriving after Pi exited could flip the UI back to
  "running" and hide the *Pi exited* overlay.
- Fix: the PTY smoke test intermittently lost the last line of output, which made
  the ubuntu CI job flaky.
- CI now also publishes a GitHub Release (VSIX + `SHA256SUMS.txt`) on tag push.

## 0.1.0

- Initial release.
- Pi TUI in the VS Code sidebar (Activity Bar) rendered with xterm.js over a real PTY.
- Additional Pi terminals in editor tabs.
- Automatic `pi` discovery, including the `pi-node` distribution and login-shell `PATH`.
- Interpreter resolution so `#!/usr/bin/env node` scripts launch without `node` on `PATH`.
- Theme, font and cursor synchronisation with VS Code.
- Send selection / file reference to Pi; clickable `path:line:col` links.
- Status bar entry, output channel, and an interactive error overlay.
