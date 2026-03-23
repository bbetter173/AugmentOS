/**
 * CameraManager — v3 SDK Camera API
 *
 * Covers:
 * - photo capture
 * - externally-triggered photo events
 * - unmanaged RTMP streaming
 * - managed stream orchestration/status
 */

import { EventEmitter } from "events";
import {
  AppToCloudMessageType,
  CloudToAppMessageType,
  type ManagedStreamStatus,
  type RestreamDestination,
  type RtmpStreamStatus,
  StreamType,
  type StreamStatusCheckResponse,
  type AudioConfig,
  type StreamConfig,
  type VideoConfig,
} from "../../types";

export interface PhotoOptions {
  size?: "small" | "medium" | "large" | "full";
  compression?: "none" | "medium" | "heavy";
  saveToGallery?: boolean;
  sound?: boolean;
  timeout?: number;
}

export interface PhotoData {
  url: string;
  width: number;
  height: number;
  timestamp: number;
  savedToGallery: boolean;
}

export interface RtmpStreamOptions {
  rtmpUrl: string;
  video?: VideoConfig;
  audio?: AudioConfig;
  stream?: StreamConfig;
  sound?: boolean;
}

export interface ManagedStreamOptions {
  quality?: "720p" | "1080p";
  enableWebRTC?: boolean;
  video?: VideoConfig;
  audio?: AudioConfig;
  stream?: StreamConfig;
  restreamDestinations?: RestreamDestination[];
  sound?: boolean;
}

export interface ManagedStreamResult {
  hlsUrl: string;
  dashUrl: string;
  webrtcUrl?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  streamId: string;
}

export interface ExistingStreamInfo {
  hasActiveStream: boolean;
  streamInfo?: {
    type: "managed" | "unmanaged";
    streamId: string;
    status: string;
    createdAt: Date;
    hlsUrl?: string;
    dashUrl?: string;
    webrtcUrl?: string;
    previewUrl?: string;
    thumbnailUrl?: string;
    activeViewers?: number;
    rtmpUrl?: string;
    requestingAppId?: string;
  };
}

export type StreamStatusHandler = (status: RtmpStreamStatus) => void;

export interface CameraManagerDeps {
  router: {
    on(key: string, handler: (streamType: string, data: any, message: any) => void): () => void;
  };
  messageHandlers: {
    register(type: string, handler: (msg: any) => void): () => void;
  };
  addSubscription: (stream: string) => void;
  removeSubscription: (stream: string) => void;
  sendMessage: (message: any) => void;
  logger: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  getPackageName: () => string;
  getSessionId: () => string;
}

interface PendingPhotoRequest {
  requestId: string;
  resolve: (data: PhotoData) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingStreamCheck {
  resolve: (response: ExistingStreamInfo) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const STREAM_CHECK_TIMEOUT_MS = 5_000;
const MANAGED_STREAM_TIMEOUT_MS = 30_000;

function generateRequestId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export class CameraManager {
  private readonly deps: CameraManagerDeps;
  private readonly events = new EventEmitter();
  private readonly handlerCleanups: Array<() => void> = [];

  private pendingRequests = new Map<string, PendingPhotoRequest>();
  private pendingStreamChecks = new Map<string, PendingStreamCheck>();
  private pendingManagedStreamRequest:
    | {
        resolve: (value: ManagedStreamResult) => void;
        reject: (reason?: any) => void;
        timeoutId: ReturnType<typeof setTimeout>;
      }
    | undefined;

  private _hasPermission = true;
  private isStreaming = false;
  private currentStreamUrl?: string;
  private currentStreamState?: RtmpStreamStatus;
  private isManagedStreaming = false;
  private currentManagedStreamId?: string;
  private currentManagedStreamUrls?: ManagedStreamResult;
  private managedStreamStatus?: ManagedStreamStatus;

  constructor(deps: CameraManagerDeps) {
    this.deps = deps;

    this.handlerCleanups.push(
      this.deps.messageHandlers.register(CloudToAppMessageType.PHOTO_RESPONSE, (msg: any) =>
        this.handlePhotoResponse(msg),
      ),
      this.deps.messageHandlers.register(CloudToAppMessageType.RTMP_STREAM_STATUS, (msg: any) =>
        this.handleRtmpStreamStatus(msg),
      ),
      this.deps.messageHandlers.register(CloudToAppMessageType.MANAGED_STREAM_STATUS, (msg: any) =>
        this.handleManagedStreamStatus(msg),
      ),
      this.deps.messageHandlers.register(CloudToAppMessageType.STREAM_STATUS_CHECK_RESPONSE, (msg: any) =>
        this.handleStreamCheckResponse(msg),
      ),
    );
  }

  takePhoto(opts?: PhotoOptions): Promise<PhotoData> {
    return new Promise<PhotoData>((resolve, reject) => {
      const requestId = generateRequestId("photo_req");
      const timeoutMs = opts?.timeout ?? DEFAULT_TIMEOUT_MS;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Photo request timed out after ${timeoutMs}ms (requestId: ${requestId})`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { requestId, resolve, reject, timer });

      const message = {
        type: AppToCloudMessageType.PHOTO_REQUEST,
        packageName: this.deps.getPackageName(),
        sessionId: this.deps.getSessionId(),
        requestId,
        timestamp: new Date(),
        saveToGallery: opts?.saveToGallery ?? false,
        size: opts?.size ?? "medium",
        compress: opts?.compression ?? "none",
        sound: opts?.sound,
      };

      try {
        this.deps.sendMessage(message);
        this.deps.logger.info(
          { requestId, size: message.size, compress: message.compress, saveToGallery: message.saveToGallery },
          "📸 Photo request sent",
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  onPhotoTaken(handler: (photo: PhotoData) => void): () => void {
    const streamKey = StreamType.PHOTO_TAKEN;
    this.deps.addSubscription(streamKey);

    const routerCleanup = this.deps.router.on(streamKey, (_streamType, data) => {
      try {
        handler(normalisePhotoData(data));
      } catch (err) {
        this.deps.logger.error("[CameraManager] Error in onPhotoTaken handler:", err);
      }
    });

    return () => {
      routerCleanup();
      this.deps.removeSubscription(streamKey);
    };
  }

  async startStream(options: RtmpStreamOptions): Promise<void> {
    if (!options.rtmpUrl) {
      throw new Error("rtmpUrl is required");
    }

    if (this.isStreaming) {
      throw new Error("Already streaming. Stop the current stream before starting a new one.");
    }

    this.currentStreamUrl = options.rtmpUrl;
    this.deps.sendMessage({
      type: AppToCloudMessageType.RTMP_STREAM_REQUEST,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      rtmpUrl: options.rtmpUrl,
      video: options.video,
      audio: options.audio,
      stream: options.stream,
      sound: options.sound,
      timestamp: new Date(),
    });
    this.isStreaming = true;
  }

  async stopStream(): Promise<void> {
    if (!this.isStreaming && !this.currentStreamState?.streamId) {
      return;
    }

    this.deps.sendMessage({
      type: AppToCloudMessageType.RTMP_STREAM_STOP,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      streamId: this.currentStreamState?.streamId,
      timestamp: new Date(),
    });
  }

  isCurrentlyStreaming(): boolean {
    return this.isStreaming;
  }

  getCurrentStreamUrl(): string | undefined {
    return this.currentStreamUrl;
  }

  getStreamStatus(): RtmpStreamStatus | undefined {
    return this.currentStreamState;
  }

  onStreamStatus(handler: StreamStatusHandler): () => void {
    this.deps.addSubscription(StreamType.RTMP_STREAM_STATUS);
    this.events.on("rtmp_stream_status", handler);

    return () => {
      this.events.off("rtmp_stream_status", handler);
      this.deps.removeSubscription(StreamType.RTMP_STREAM_STATUS);
    };
  }

  async startManagedStream(options: ManagedStreamOptions = {}): Promise<ManagedStreamResult> {
    if (this.isManagedStreaming) {
      throw new Error("Already streaming. Stop the current managed stream before starting a new one.");
    }

    this.deps.sendMessage({
      type: AppToCloudMessageType.MANAGED_STREAM_REQUEST,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      quality: options.quality,
      enableWebRTC: options.enableWebRTC,
      video: options.video,
      audio: options.audio,
      stream: options.stream,
      restreamDestinations: options.restreamDestinations,
      sound: options.sound,
      timestamp: new Date(),
    });
    this.isManagedStreaming = true;

    return new Promise<ManagedStreamResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingManagedStreamRequest?.timeoutId === timeoutId) {
          this.pendingManagedStreamRequest = undefined;
          this.isManagedStreaming = false;
          reject(new Error("Managed stream request timeout"));
        }
      }, MANAGED_STREAM_TIMEOUT_MS);

      this.pendingManagedStreamRequest = { resolve, reject, timeoutId };
    });
  }

  async stopManagedStream(): Promise<void> {
    this.deps.sendMessage({
      type: AppToCloudMessageType.MANAGED_STREAM_STOP,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      timestamp: new Date(),
    });
  }

  onManagedStreamStatus(handler: (status: ManagedStreamStatus) => void): () => void {
    this.deps.addSubscription(StreamType.MANAGED_STREAM_STATUS);
    this.events.on("managed_stream_status", handler);

    return () => {
      this.events.off("managed_stream_status", handler);
      this.deps.removeSubscription(StreamType.MANAGED_STREAM_STATUS);
    };
  }

  isManagedStreamActive(): boolean {
    return this.isManagedStreaming;
  }

  getManagedStreamUrls(): ManagedStreamResult | undefined {
    return this.currentManagedStreamUrls;
  }

  getManagedStreamStatus(): ManagedStreamStatus | undefined {
    return this.managedStreamStatus;
  }

  async checkExistingStream(): Promise<ExistingStreamInfo> {
    return new Promise<ExistingStreamInfo>((resolve) => {
      const requestId = generateRequestId("stream_check");
      const timeoutId = setTimeout(() => {
        this.pendingStreamChecks.delete(requestId);
        resolve({ hasActiveStream: false });
      }, STREAM_CHECK_TIMEOUT_MS);

      this.pendingStreamChecks.set(requestId, { resolve, timeoutId });

      this.deps.sendMessage({
        type: AppToCloudMessageType.STREAM_STATUS_CHECK,
        packageName: this.deps.getPackageName(),
        sessionId: this.deps.getSessionId(),
        requestId,
        timestamp: new Date(),
      });
    });
  }

  get hasPermission(): boolean {
    return this._hasPermission;
  }

  handlePhotoResponse(message: any): void {
    const requestId: string | undefined = message?.requestId;
    if (!requestId) {
      this.deps.logger.warn("[CameraManager] Received PHOTO_RESPONSE without requestId:", message);
      return;
    }

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      this.deps.logger.debug(`[CameraManager] No pending request for requestId="${requestId}" — ignoring.`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);

    if (message.error?.code === "permission_denied") {
      this._hasPermission = false;
    }

    if (message.success === false) {
      const errorMsg = message.error?.message ?? message.error?.code ?? "Photo capture failed";
      pending.reject(new Error(errorMsg));
      return;
    }

    pending.resolve({
      url: message.photoUrl ?? "",
      width: message.width ?? 0,
      height: message.height ?? 0,
      timestamp: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
      savedToGallery: message.savedToGallery ?? false,
    });
  }

  private handleRtmpStreamStatus(message: RtmpStreamStatus): void {
    this.currentStreamState = {
      ...message,
      timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
    };

    if (message.status === "stopped" || message.status === "error" || message.status === "timeout") {
      this.isStreaming = false;
      this.currentStreamUrl = undefined;
    } else {
      this.isStreaming = true;
    }

    this.events.emit("rtmp_stream_status", this.currentStreamState);
  }

  private handleManagedStreamStatus(status: ManagedStreamStatus): void {
    this.managedStreamStatus = status;

    if (status.status === "initializing" && status.streamId) {
      this.isManagedStreaming = true;
      this.currentManagedStreamId = status.streamId;
    }

    if (status.status === "active") {
      this.isManagedStreaming = true;
      this.currentManagedStreamId = status.streamId;

      if (status.hlsUrl && status.dashUrl) {
        const result: ManagedStreamResult = {
          hlsUrl: status.hlsUrl,
          dashUrl: status.dashUrl,
          webrtcUrl: status.webrtcUrl,
          previewUrl: status.previewUrl,
          thumbnailUrl: status.thumbnailUrl,
          streamId: status.streamId ?? "",
        };

        this.currentManagedStreamUrls = result;

        if (this.pendingManagedStreamRequest) {
          clearTimeout(this.pendingManagedStreamRequest.timeoutId);
          this.pendingManagedStreamRequest.resolve(result);
          this.pendingManagedStreamRequest = undefined;
        }
      }
    }

    if (status.status === "error" || status.status === "stopped") {
      if (this.pendingManagedStreamRequest) {
        clearTimeout(this.pendingManagedStreamRequest.timeoutId);
        this.pendingManagedStreamRequest.reject(new Error(status.message || "Managed stream failed"));
        this.pendingManagedStreamRequest = undefined;
      }

      this.isManagedStreaming = false;
      this.currentManagedStreamId = undefined;
      this.currentManagedStreamUrls = undefined;
    }

    this.events.emit("managed_stream_status", status);
  }

  private handleStreamCheckResponse(response: StreamStatusCheckResponse): void {
    // Match by requestId from the response — don't blindly pop the first entry.
    // This prevents concurrent checkExistingStream() calls from resolving the wrong promise.
    const requestId = (response as any).requestId;
    const pending = requestId ? this.pendingStreamChecks.get(requestId) : undefined;

    // Fallback: if the cloud doesn't include requestId, pop the first entry (v2 behavior)
    if (!pending) {
      const firstEntry = this.pendingStreamChecks.entries().next();
      if (firstEntry.done || !firstEntry.value) {
        return;
      }
      const [fallbackId, fallbackPending] = firstEntry.value;
      clearTimeout(fallbackPending.timeoutId);
      this.pendingStreamChecks.delete(fallbackId);
      fallbackPending.resolve({
        hasActiveStream: response.hasActiveStream,
        streamInfo: response.streamInfo
          ? {
              ...response.streamInfo,
              createdAt: new Date(response.streamInfo.createdAt),
            }
          : undefined,
      });
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingStreamChecks.delete(requestId!);
    pending.resolve({
      hasActiveStream: response.hasActiveStream,
      streamInfo: response.streamInfo
        ? {
            ...response.streamInfo,
            createdAt: new Date(response.streamInfo.createdAt),
          }
        : undefined,
    });
  }

  destroy(): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`CameraManager destroyed — session disconnected (${requestId})`));
    }
    this.pendingRequests.clear();

    for (const [requestId, pending] of this.pendingStreamChecks) {
      clearTimeout(pending.timeoutId);
      pending.resolve({ hasActiveStream: false });
      this.pendingStreamChecks.delete(requestId);
    }

    if (this.pendingManagedStreamRequest) {
      clearTimeout(this.pendingManagedStreamRequest.timeoutId);
      this.pendingManagedStreamRequest.reject(new Error("CameraManager destroyed — session disconnected"));
      this.pendingManagedStreamRequest = undefined;
    }

    for (const cleanup of this.handlerCleanups) {
      cleanup();
    }
    this.handlerCleanups.length = 0;

    this.events.removeAllListeners();
    this.currentStreamState = undefined;
    this.currentStreamUrl = undefined;
    this.isStreaming = false;
    this.managedStreamStatus = undefined;
    this.currentManagedStreamId = undefined;
    this.currentManagedStreamUrls = undefined;
    this.isManagedStreaming = false;
  }
}

function normalisePhotoData(raw: any): PhotoData {
  return {
    url: raw.photoUrl ?? raw.url ?? "",
    width: raw.width ?? 0,
    height: raw.height ?? 0,
    timestamp: raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now(),
    savedToGallery: raw.savedToGallery ?? false,
  };
}
