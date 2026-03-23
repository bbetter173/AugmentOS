import { WebSocketTransport } from "../transport/WebSocketTransport";
import type { SessionWebhookRequest } from "../types";
import { MentraSession, type MentraSessionConfig } from "../session";
import { _V2SessionShim } from "../session/internal/_V2SessionShim";
import type { _V2PhotoRequestBridge } from "../session/internal/_V2CameraShim";

export interface _MentraSessionServerFactoryConfig {
  packageName: string;
  apiKey: string;
  serverUrl?: string;
  logLevel?: MentraSessionConfig["logLevel"];
  verbose?: MentraSessionConfig["verbose"];
  photoRequestBridge?: _V2PhotoRequestBridge;
}

export interface _MentraSessionServerFactoryResult {
  session: MentraSession;
  compatSession: _V2SessionShim;
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
      compatSession: new _V2SessionShim(session, {
        photoRequestBridge: this.config.photoRequestBridge,
      }),
    };
  }
}
