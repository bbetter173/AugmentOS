import type { Logger } from "pino";
import type { WebhookResponse, SessionWebhookRequest, StopWebhookRequest, ToolCall } from "../types";
import type { _V2PhotoRequestBridge } from "../session/internal/_V2CameraShim";
import { _V2SessionShim } from "../session/internal/_V2SessionShim";
import { _MentraSessionServerFactory } from "./_MentraSessionServerFactory";
import { _MiniAppServerCallbackBridge } from "./_MiniAppServerCallbackBridge";
import { _MiniAppSessionRegistry } from "./_MiniAppSessionRegistry";

export interface _MiniAppServerRuntimeConfig {
  packageName: string;
  apiKey: string;
  logger: Logger;
  serverUrl?: string;
  logLevel?: "none" | "error" | "warn" | "info" | "debug";
  verbose?: boolean;
  photoRequestBridge?: _V2PhotoRequestBridge;
}

export class _MiniAppServerRuntime {
  readonly registry = new _MiniAppSessionRegistry();

  private readonly logger: Logger;
  private readonly factory: _MentraSessionServerFactory;
  private readonly callbacks = new _MiniAppServerCallbackBridge<_V2SessionShim>();
  private readonly stopSuppression = new Set<string>();

  constructor(config: _MiniAppServerRuntimeConfig) {
    this.logger = config.logger;
    this.factory = new _MentraSessionServerFactory({
      packageName: config.packageName,
      apiKey: config.apiKey,
      serverUrl: config.serverUrl,
      logLevel: config.logLevel,
      verbose: config.verbose,
      photoRequestBridge: config.photoRequestBridge,
    });
  }

  onSession(handler: (session: _V2SessionShim) => void | Promise<void>): void {
    this.callbacks.registerSessionHandler(handler);
  }

  onStop(handler: (session: _V2SessionShim | null, reason: string) => void | Promise<void>): void {
    this.callbacks.registerStopHandler(handler);
  }

  onToolCall(handler: (toolCall: ToolCall) => string | undefined | Promise<string | undefined>): void {
    this.callbacks.registerToolCallHandler(handler);
  }

  async handleSessionRequest(request: SessionWebhookRequest): Promise<WebhookResponse> {
    const existing = this.registry.getBySessionId(request.sessionId);
    if (existing) {
      this.stopSuppression.add(request.sessionId);
      try {
        await existing.compatSession.releaseOwnership("switching_clouds");
      } catch (error) {
        this.logger.warn(
          { error, sessionId: request.sessionId },
          "Failed to release ownership on existing runtime session",
        );
      }

      await existing.session.disconnect();
      this.registry.deleteIfSameSession(request.sessionId, existing.session);
      this.stopSuppression.delete(request.sessionId);
    }

    const created = this.factory.create(request);

    this.registry.set({
      session: created.session,
      compatSession: created.compatSession,
      userId: request.userId,
      sessionId: request.sessionId,
    });

    created.compatSession.events.onDisconnected(async (info) => {
      if (!info?.permanent) {
        return;
      }

      const removed = this.registry.deleteIfSameSession(request.sessionId, created.session);
      if (!removed) {
        return;
      }

      if (this.stopSuppression.has(request.sessionId)) {
        return;
      }

      try {
        await this.callbacks.handleStop(request.sessionId, info.reason || "Session disconnected", async () => {});
      } catch (error) {
        this.logger.error(error, "MiniAppServer runtime stop handler failed after permanent disconnect");
      }
    });

    created.compatSession.events.onError((error) => {
      this.logger.error(error, "MiniAppServer runtime session error");
    });

    try {
      await created.session.connect();
    } catch (error) {
      this.registry.deleteIfSameSession(request.sessionId, created.session);
      throw error;
    }

    await this.callbacks.handleSession(created.compatSession, request.sessionId, async () => {});
    return { status: "success" };
  }

  async handleStopRequest(request: StopWebhookRequest): Promise<WebhookResponse> {
    this.stopSuppression.add(request.sessionId);
    const existing = this.registry.deleteBySessionId(request.sessionId);
    if (existing) {
      await existing.session.disconnect();
    }

    try {
      await this.callbacks.handleStop(request.sessionId, request.reason, async () => {});
    } finally {
      this.stopSuppression.delete(request.sessionId);
    }
    return { status: "success" };
  }

  async handleToolCall(toolCall: ToolCall): Promise<{ status: "success"; reply: string | null }> {
    const activeSession = this.registry.getByUserId(toolCall.userId)?.compatSession ?? null;
    const response = await this.callbacks.handleToolCall(
      {
        ...toolCall,
        activeSession: activeSession as any,
      },
      async () => undefined,
    );

    return {
      status: "success",
      reply: response ?? null,
    };
  }

  async shutdown(): Promise<void> {
    for (const record of this.registry.values()) {
      this.stopSuppression.add(record.sessionId);
      await record.session.disconnect();
    }
    this.registry.clear();
    this.stopSuppression.clear();
  }
}
