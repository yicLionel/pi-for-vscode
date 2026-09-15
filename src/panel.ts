import * as vscode from 'vscode';
import type { PiHostAdapter } from './host';
import { PiController } from './piController';
import type { PiRegistry } from './registry';

let panelCounter = 0;

/** Opens a Pi terminal in an editor tab (a second, independent session). */
export function openPiPanel(
  context: vscode.ExtensionContext,
  registry: PiRegistry,
  output: vscode.OutputChannel,
  viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active,
): PiController {
  const id = `panel-${++panelCounter}`;
  const panel = vscode.window.createWebviewPanel('pi-for-vscode.panel', 'Pi', viewColumn, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'pi.svg');

  const adapter: PiHostAdapter = {
    kind: 'panel',
    webview: panel.webview,
    onDidDispose: (listener) => panel.onDidDispose(listener),
    onDidChangeVisibility: (listener) => panel.onDidChangeViewState(() => listener(panel.visible)),
    isVisible: () => panel.visible,
    reveal: () => panel.reveal(undefined, true),
  };

  const controller = new PiController(id, adapter, context, output, 'Pi');
  registry.add(controller);
  controller.setup();

  panel.onDidDispose(() => {
    registry.remove(id);
    controller.dispose();
  });

  return controller;
}
