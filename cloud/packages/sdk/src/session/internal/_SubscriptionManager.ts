import type { Logger } from "pino";
import { AppToCloudMessageType } from "../../types/message-types";

export interface _SubscriptionManagerDeps {
  logger: Logger;
  isConnected: () => boolean;
  sendMessage: (message: unknown) => void;
  getPackageName: () => string;
  getSessionId: () => string;
}

export class _SubscriptionManager {
  private readonly deps: _SubscriptionManagerDeps;
  private readonly subscriptions = new Set<string>();

  constructor(deps: _SubscriptionManagerDeps) {
    this.deps = deps;
  }

  add(stream: string): void {
    this.subscriptions.add(stream);
    if (this.deps.isConnected()) {
      this.sync();
    }
  }

  remove(stream: string): void {
    this.subscriptions.delete(stream);
    if (this.deps.isConnected()) {
      this.sync();
    }
  }

  sync(): void {
    this.deps.sendMessage({
      type: AppToCloudMessageType.SUBSCRIPTION_UPDATE,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      subscriptions: this.snapshot(),
      timestamp: new Date(),
    });
  }

  snapshot(): string[] {
    return Array.from(this.subscriptions);
  }

  clear(): void {
    this.subscriptions.clear();
  }
}
