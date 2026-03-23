import type { Context } from "hono";
import type { ToolCall } from "./types";
import type { AuthVariables, SessionWebhookRequest, StopWebhookRequest, WebhookResponse } from "./types";
import { AppServer, type AppServerConfig } from "./app/server";
import { AppSession } from "./app/session";
import { MentraSession } from "./session";
import { type _ToolCallHandler } from "./internal/_MiniAppServerCallbackBridge";
import { _MiniAppServerRuntime } from "./internal/_MiniAppServerRuntime";

/**
 * Internal bridge session type used by the compatibility host.
 *
 * The public surface still extends AppServer for compatibility, but webhook
 * session lifecycle now flows through the v3 MentraSession runtime.
 */
class CompatMentraSession extends AppSession {}

export type MiniAppServerConfig = AppServerConfig;

export type SessionHandler = (session: MentraSession) => void | Promise<void>;
export type StopHandler = (session: MentraSession | null, reason: string) => void | Promise<void>;
export type ToolCallHandler = _ToolCallHandler;

/**
 * v3 cloud/server host for Mentra mini apps.
 *
 * Naming note:
 * - `MiniAppServer` is cloud/server-specific.
 * - `MentraSession` is the per-user session abstraction.
 *
 * Implementation note:
 * This class still extends AppServer for backward compatibility, while its
 * webhook-driven session lifecycle is routed through the v3 MentraSession
 * runtime and compatibility facades.
 */
export class MiniAppServer extends AppServer {
  private readonly _runtime: _MiniAppServerRuntime;

  constructor(config: MiniAppServerConfig) {
    super(config);
    this._runtime = new _MiniAppServerRuntime({
      packageName: config.packageName,
      apiKey: config.apiKey,
      logger: this.logger,
      serverUrl: config.cloudApiUrl,
      photoRequestBridge: {
        registerPhotoRequest: this.registerPhotoRequest.bind(this),
        completePhotoRequest: this.completePhotoRequest.bind(this),
      },
    });
  }

  public onSession(handler: SessionHandler): this;
  public override onSession(session: AppSession, sessionId: string, userId: string): Promise<void>;
  public override onSession(
    arg1: SessionHandler | AppSession,
    sessionId?: string,
    userId?: string,
  ): this | Promise<void> {
    if (typeof arg1 === "function") {
      this._runtime.onSession((session) => arg1(session.session));
      return this;
    }

    const mentraSession = arg1 as CompatMentraSession;
    return super.onSession(mentraSession, sessionId!, userId!);
  }

  public onStop(handler: StopHandler): this;
  public override onStop(sessionId: string, userId: string, reason: string): Promise<void>;
  public override onStop(arg1: StopHandler | string, userId?: string, reason?: string): this | Promise<void> {
    if (typeof arg1 === "function") {
      this._runtime.onStop((session, stopReason) => arg1(session?.session ?? null, stopReason));
      return this;
    }

    return super.onStop(arg1, userId!, reason!);
  }

  public onToolCall(handler: ToolCallHandler): this;
  public override onToolCall(toolCall: ToolCall): Promise<string | undefined>;
  public override onToolCall(arg1: ToolCallHandler | ToolCall): this | Promise<string | undefined> {
    if (typeof arg1 === "function") {
      this._runtime.onToolCall(arg1);
      return this;
    }

    return super.onToolCall(arg1);
  }

  protected override async handleSessionWebhookRequest(
    request: SessionWebhookRequest,
    c: Context<{ Variables: AuthVariables }>,
  ): Promise<Response> {
    try {
      const response = await this._runtime.handleSessionRequest(request);
      const record = this._runtime.registry.getBySessionId(request.sessionId);
      if (record) {
        this.setActiveSession(request.sessionId, request.userId, record.compatSession as unknown as AppSession);
        record.compatSession.events.onDisconnected((info) => {
          if (!info?.permanent) {
            return;
          }

          if (this.getActiveSessionById(request.sessionId) === (record.compatSession as unknown as AppSession)) {
            this.removeActiveSession(request.sessionId, request.userId);
          }

          this.cleanupPhotoRequestsForSession(request.sessionId);
        });
      }

      return c.json(response as WebhookResponse);
    } catch (error) {
      this.logger.error(error, "Failed to connect MiniAppServer runtime session");
      return c.json(
        {
          status: "error",
          message: "Failed to connect",
        } as WebhookResponse,
        500,
      );
    }
  }

  protected override async handleStopWebhookRequest(
    request: StopWebhookRequest,
    c: Context<{ Variables: AuthVariables }>,
  ): Promise<Response> {
    try {
      const response = await this._runtime.handleStopRequest(request);
      this.removeActiveSession(request.sessionId, request.userId);
      return c.json(response as WebhookResponse);
    } catch (error) {
      this.logger.error(error, "Failed to stop MiniAppServer runtime session");
      return c.json(
        {
          status: "error",
          message: "Failed to process stop request",
        } as WebhookResponse,
        500,
      );
    }
  }
}
