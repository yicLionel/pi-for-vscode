import * as vscode from 'vscode';
import type { PiController } from './piController';

/** Tracks every live Pi terminal (sidebar + editor tabs). */
export class PiRegistry implements vscode.Disposable {
  private readonly controllers = new Map<string, PiController>();
  private readonly subscriptions = new Map<string, vscode.Disposable>();
  private activeId: string | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.emitter.event;

  add(controller: PiController): void {
    this.controllers.set(controller.id, controller);
    this.subscriptions.set(
      controller.id,
      controller.onDidChangeState(() => this.emitter.fire()),
    );
    if (!this.activeId) this.activeId = controller.id;
    this.emitter.fire();
  }

  remove(id: string): void {
    this.controllers.delete(id);
    this.subscriptions.get(id)?.dispose();
    this.subscriptions.delete(id);
    if (this.activeId === id) {
      this.activeId = this.controllers.keys().next().value as string | undefined;
    }
    this.emitter.fire();
  }

  get(id: string): PiController | undefined {
    return this.controllers.get(id);
  }

  all(): PiController[] {
    return [...this.controllers.values()];
  }

  getActive(): PiController | undefined {
    if (this.activeId) {
      const active = this.controllers.get(this.activeId);
      if (active) return active;
    }
    return this.controllers.values().next().value as PiController | undefined;
  }

  /** Prefers a running session so "send to Pi" always targets something useful. */
  getTarget(): PiController | undefined {
    const active = this.getActive();
    if (active?.isAlive) return active;
    return this.all().find((controller) => controller.isAlive) ?? active;
  }

  setActive(id: string): void {
    if (!this.controllers.has(id)) return;
    this.activeId = id;
    this.emitter.fire();
  }

  dispose(): void {
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
    this.controllers.clear();
    this.emitter.dispose();
  }
}
