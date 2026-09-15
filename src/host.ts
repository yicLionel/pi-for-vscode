import * as vscode from 'vscode';

export type PiHostKind = 'sidebar' | 'panel';

/**
 * Normalises the differences between a `WebviewView` (sidebar) and a
 * `WebviewPanel` (editor tab) so `PiController` can drive either of them.
 */
export interface PiHostAdapter {
  readonly kind: PiHostKind;
  readonly webview: vscode.Webview;
  onDidDispose(listener: () => void): vscode.Disposable;
  onDidChangeVisibility(listener: (visible: boolean) => void): vscode.Disposable;
  isVisible(): boolean;
  reveal(): void;
}
