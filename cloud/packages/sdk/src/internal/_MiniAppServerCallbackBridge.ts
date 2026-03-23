import type { AppSession } from "../app/session";
import type { ToolCall } from "../types";

export type _SessionHandler<TSession = AppSession> = (session: TSession) => void | Promise<void>;
export type _StopHandler<TSession = AppSession> = (session: TSession | null, reason: string) => void | Promise<void>;
export type _ToolCallHandler = (toolCall: ToolCall) => string | undefined | Promise<string | undefined>;

export class _MiniAppServerCallbackBridge<TSession = AppSession> {
  private sessionHandler?: _SessionHandler<TSession>;
  private stopHandler?: _StopHandler<TSession>;
  private toolCallHandler?: _ToolCallHandler;
  private readonly sessionById = new Map<string, TSession>();

  registerSessionHandler(handler: _SessionHandler<TSession>): void {
    this.sessionHandler = handler;
  }

  registerStopHandler(handler: _StopHandler<TSession>): void {
    this.stopHandler = handler;
  }

  registerToolCallHandler(handler: _ToolCallHandler): void {
    this.toolCallHandler = handler;
  }

  async handleSession(session: TSession, sessionId: string, fallback: () => Promise<void>): Promise<void> {
    this.sessionById.set(sessionId, session);

    if (this.sessionHandler) {
      await this.sessionHandler(session);
      return;
    }

    await fallback();
  }

  async handleStop(sessionId: string, reason: string, fallback: () => Promise<void>): Promise<void> {
    const session = this.sessionById.get(sessionId) ?? null;
    this.sessionById.delete(sessionId);

    if (this.stopHandler) {
      await this.stopHandler(session, reason);
      return;
    }

    await fallback();
  }

  async handleToolCall(toolCall: ToolCall, fallback: () => Promise<string | undefined>): Promise<string | undefined> {
    if (this.toolCallHandler) {
      return this.toolCallHandler(toolCall);
    }

    return fallback();
  }
}
