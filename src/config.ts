import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { expandHome } from './piLocator';

export interface PiSettings {
  executablePath: string;
  args: string[];
  autoStart: boolean;
  cwd: 'workspace' | 'file' | 'home' | 'custom';
  customCwd: string;
  env: Record<string, string>;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  scrollback: number;
  sendSubmit: boolean;
  fileLinks: boolean;
}

export function readSettings(): PiSettings {
  const config = vscode.workspace.getConfiguration('pi-for-vscode');
  return {
    executablePath: config.get<string>('executablePath', '').trim(),
    args: config.get<string[]>('args', []).filter((a) => typeof a === 'string'),
    autoStart: config.get<boolean>('autoStart', true),
    cwd: config.get<PiSettings['cwd']>('cwd', 'workspace'),
    customCwd: config.get<string>('customCwd', '').trim(),
    env: config.get<Record<string, string>>('env', {}),
    fontFamily: config.get<string>('fontFamily', '').trim(),
    fontSize: config.get<number>('fontSize', 0),
    lineHeight: config.get<number>('lineHeight', 0),
    cursorBlink: config.get<boolean>('cursorBlink', true),
    scrollback: Math.max(500, config.get<number>('scrollback', 10000)),
    sendSubmit: config.get<boolean>('sendSubmit', false),
    fileLinks: config.get<boolean>('fileLinks', true),
  };
}

/** Settings that are safe to hand to the webview. */
export function webviewSettings(settings: PiSettings) {
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    fileLinks: settings.fileLinks,
  };
}

export function resolveCwd(settings: PiSettings): string {
  const workspaceFolder = vscode.window.activeTextEditor
    ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
    : undefined;
  const workspacePath = workspaceFolder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  switch (settings.cwd) {
    case 'file': {
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.scheme === 'file') {
        return path.dirname(editor.document.uri.fsPath);
      }
      return workspacePath ?? os.homedir();
    }
    case 'home':
      return os.homedir();
    case 'custom': {
      const custom = expandHome(settings.customCwd);
      return custom || os.homedir();
    }
    case 'workspace':
    default:
      return workspacePath ?? os.homedir();
  }
}
