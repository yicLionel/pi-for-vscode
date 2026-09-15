import * as vscode from 'vscode';
import type { PiHostAdapter } from './host';
import { PiController } from './piController';
import type { PiRegistry } from './registry';

export const SIDEBAR_VIEW_TYPE = 'pi-for-vscode.sidebar';
export const SIDEBAR_CONTAINER_ID = 'pi-for-vscode';
export const SIDEBAR_CONTROLLER_ID = 'sidebar';

export class PiSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private controller: PiController | undefined;
  private pendingFocus = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: PiRegistry,
    private readonly output: vscode.OutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.title = 'Pi';

    const adapter: PiHostAdapter = {
      kind: 'sidebar',
      webview: view.webview,
      onDidDispose: (listener) => view.onDidDispose(listener),
      onDidChangeVisibility: (listener) => view.onDidChangeVisibility(() => listener(view.visible)),
      isVisible: () => view.visible,
      reveal: () => {
        try {
          view.show(true);
        } catch {
          // Older VS Code versions do not expose WebviewView.show().
        }
      },
    };

    const controller = new PiController(
      SIDEBAR_CONTROLLER_ID,
      adapter,
      this.context,
      this.output,
      'Pi',
    );
    this.controller = controller;
    this.registry.add(controller);
    controller.setup();

    this.disposables.push(
      view.onDidDispose(() => {
        this.registry.remove(SIDEBAR_CONTROLLER_ID);
        this.controller = undefined;
        this.view = undefined;
      }),
    );

    if (this.pendingFocus) {
      this.pendingFocus = false;
      void this.focus();
    }
  }

  /** Brings the Pi sidebar into view and focuses the TUI. */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`workbench.view.extension.${SIDEBAR_CONTAINER_ID}`);
    try {
      await vscode.commands.executeCommand(`${SIDEBAR_VIEW_TYPE}.focus`);
    } catch {
      // The generated focus command is not always available; the view is open anyway.
    }
    this.view?.show?.(false);
    if (this.controller) {
      this.registry.setActive(SIDEBAR_CONTROLLER_ID);
      this.controller.focus();
    } else {
      this.pendingFocus = true;
    }
  }

  get activeController(): PiController | undefined {
    return this.controller;
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }
}
