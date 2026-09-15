import * as vscode from 'vscode';

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
  const nonce = randomNonce();

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Pi</title>
  </head>
  <body>
    <div id="pi-root">
      <div id="pi-terminal" class="pi-terminal" role="application" aria-label="Pi terminal"></div>
      <div id="pi-overlay" class="pi-overlay" hidden>
        <div class="pi-card">
          <div class="pi-card-title" id="pi-overlay-title"></div>
          <div class="pi-card-message" id="pi-overlay-message"></div>
          <div class="pi-card-actions" id="pi-overlay-actions"></div>
        </div>
      </div>
      <div id="pi-menu" class="pi-menu" hidden></div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
