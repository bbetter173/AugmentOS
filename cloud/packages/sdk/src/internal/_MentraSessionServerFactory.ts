import { WebSocketTransport } from "../transport/WebSocketTransport";
import type { SessionWebhookRequest } from "../types";
import { MentraSession, type MentraSessionConfig } from "../session";
import { _CompatMentraSessionAdapter } from "../session/internal/_CompatMentraSessionAdapter";
import type { _CompatPhotoRequestBridge } from "../session/internal/_CompatCameraAdapter";

export interface _MentraSessionServerFactoryConfig {
  packageName: string;
  apiKey: string;
  serverUrl?: string;
  logLevel?: MentraSessionConfig["logLevel"];
  verbose?: MentraSessionConfig["verbose"];
  photoRequestBridge?: _CompatPhotoRequestBridge;
}

export interface _MentraSessionServerFactoryResult {
  session: MentraSession;
  compatSession: _CompatMentraSessionAdapter;
}

export class _MentraSessionServerFactory {
  private readonly config: _MentraSessionServerFactoryConfig;

  constructor(config: _MentraSessionServerFactoryConfig) {
    this.config = config;
  }

  create(request: SessionWebhookRequest): _MentraSessionServerFactoryResult {
    const websocketUrl = request.websocketUrl || request.mentraOSWebsocketUrl || request.augmentOSWebsocketUrl;
    if (!websocketUrl) {
      throw new Error("Session webhook is missing websocketUrl/mentraOSWebsocketUrl/augmentOSWebsocketUrl");
    }

    const transport = new WebSocketTransport({
      url: websocketUrl,
      headers: {
        "x-user-id": request.userId,
        "x-session-id": request.sessionId,
        "x-package-name": this.config.packageName,
        "x-api-key": this.config.apiKey,
      },
    });

    const session = new MentraSession({
      packageName: this.config.packageName,
      apiKey: this.config.apiKey,
      sessionId: request.sessionId,
      userId: request.userId,
      serverUrl: this.config.serverUrl,
      transport,
      logLevel: this.config.logLevel,
      verbose: this.config.verbose,
    });

    return {
      session,
      compatSession: new _CompatMentraSessionAdapter(session, {
        photoRequestBridge: this.config.photoRequestBridge,
      }),
    };
  }
}
