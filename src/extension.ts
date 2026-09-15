import * as path from 'node:path';
import * as vscode from 'vscode';
import { readSettings } from './config';
import { openPiPanel } from './panel';
import { PiController } from './piController';
import { PiRegistry } from './registry';
import { PiSidebarProvider, SIDEBAR_CONTAINER_ID, SIDEBAR_CONTROLLER_ID, SIDEBAR_VIEW_TYPE } from './sidebarProvider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Pi for VS Code');
  const registry = new PiRegistry();

  const sidebar = new PiSidebarProvider(context, registry, output);

  context.subscriptions.push(
    output,
    registry,
    sidebar,
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_TYPE, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  void vscode.commands.executeCommand('setContext', 'pi-for-vscode.hasSession', false);

  // ------------------------------------------------------------- status bar

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.name = 'Pi';
  status.command = 'pi-for-vscode.open';
  context.subscriptions.push(status);

  const refreshStatus = () => {
    const active = registry.getActive();
    const state = active?.currentState ?? 'idle';
    switch (state) {
      case 'running':
        status.text = '$(terminal) Pi';
        status.tooltip = `Pi is running${active?.pid ? ` (pid ${active.pid})` : ''} — click to focus`;
        status.backgroundColor = undefined;
        break;
      case 'starting':
        status.text = '$(sync~spin) Pi';
        status.tooltip = 'Starting Pi…';
        status.backgroundColor = undefined;
        break;
      case 'error':
        status.text = '$(error) Pi';
        status.tooltip = 'Pi could not be started — click for details';
        status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'exited':
        status.text = '$(debug-disconnect) Pi';
        status.tooltip = 'Pi has exited — click to open the sidebar';
        status.backgroundColor = undefined;
        break;
      default:
        status.text = '$(terminal) Pi';
        status.tooltip = 'Open the Pi sidebar';
        status.backgroundColor = undefined;
        break;
    }
    status.show();
  };

  context.subscriptions.push(registry.onDidChange(refreshStatus));
  refreshStatus();

  // ---------------------------------------------------------------- helpers

  const register = (command: string, handler: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  const targetOrWarn = (): PiController | undefined => {
    const target = registry.getTarget();
    if (!target) {
      void vscode.window.showWarningMessage('Pi is not available yet. Open the Pi sidebar first.');
      return undefined;
    }
    return target;
  };

  const insert = (text: string, submit: boolean) => {
    const target = targetOrWarn();
    if (!target) return;
    target.sendText(text, submit);
    void vscode.commands.executeCommand(`workbench.view.extension.${SIDEBAR_CONTAINER_ID}`);
  };

  // --------------------------------------------------------------- commands

  register('pi-for-vscode.open', async () => {
    await sidebar.focus();
  });

  register('pi-for-vscode.newTerminal', () => {
    const controller = openPiPanel(context, registry, output);
    registry.setActive(controller.id);
  });

  register('pi-for-vscode.restart', async () => {
    const target = registry.getTarget();
    if (!target) {
      await sidebar.focus();
      return;
    }
    await target.restart();
  });

  register('pi-for-vscode.kill', () => {
    registry.getTarget()?.kill();
  });

  register('pi-for-vscode.clear', () => {
    registry.getTarget()?.clear();
  });

  register('pi-for-vscode.sendSelection', () => {
    const editor = vscode.window.activeTextEditor;
    const text = editor ? editor.document.getText(editor.selection) : '';
    if (!text.trim()) {
      void vscode.window.showInformationMessage('Select some text first, then run “Send Selection to Pi”.');
      return;
    }
    insert(text, readSettings().sendSubmit);
  });

  register('pi-for-vscode.sendSelectionAndSubmit', () => {
    const editor = vscode.window.activeTextEditor;
    const text = editor ? editor.document.getText(editor.selection) : '';
    if (!text.trim()) {
      void vscode.window.showInformationMessage('Select some text first, then run “Send Selection to Pi and Submit”.');
      return;
    }
    insert(text, true);
  });

  register('pi-for-vscode.sendFilePath', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('No file-backed editor is active.');
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const relative = folder ? path.relative(folder.uri.fsPath, editor.document.uri.fsPath) : editor.document.uri.fsPath;
    const reference = /\s/.test(relative) ? `@"${relative}"` : `@${relative}`;
    insert(`${reference} `, readSettings().sendSubmit);
  });

  register('pi-for-vscode.pickExecutable', async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Use as pi executable',
      title: 'Select the pi executable',
    });
    if (!picked?.length) return;

    const config = vscode.workspace.getConfiguration('pi-for-vscode');
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const target = hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('executablePath', picked[0].fsPath, target);

    const choice = await vscode.window.showInformationMessage(
      `Pi executable set to ${picked[0].fsPath}`,
      'Restart Pi',
      'Open Settings',
    );
    if (choice === 'Restart Pi') await registry.getTarget()?.restart();
    if (choice === 'Open Settings') await vscode.commands.executeCommand('pi-for-vscode.openSettings');
  });

  register('pi-for-vscode.showOutput', () => {
    output.show(true);
  });

  register('pi-for-vscode.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:pi-for-vscode pi-for-vscode');
  });

  // ---------------------------------------------------------- configuration

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('pi-for-vscode')) return;
      for (const controller of registry.all()) controller.applySettings();
    }),
  );
}

export function deactivate(): void {
  // Controllers are disposed through context.subscriptions.
}

// Kept for symmetry with VS Code's activation model.
export { SIDEBAR_CONTROLLER_ID };
