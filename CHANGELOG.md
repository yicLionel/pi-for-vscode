# Changelog

## 0.1.0

- Initial release.
- Pi TUI in the VS Code sidebar (Activity Bar) rendered with xterm.js over a real PTY.
- Additional Pi terminals in editor tabs.
- Automatic `pi` discovery, including the `pi-node` distribution and login-shell `PATH`.
- Interpreter resolution so `#!/usr/bin/env node` scripts launch without `node` on `PATH`.
- Theme, font and cursor synchronisation with VS Code.
- Send selection / file reference to Pi; clickable `path:line:col` links.
- Status bar entry, output channel, and an interactive error overlay.
