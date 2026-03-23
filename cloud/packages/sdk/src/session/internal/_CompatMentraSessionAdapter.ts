import type { AppSettings } from "../../types";
import { MentraSession } from "../MentraSession";
import { _CompatAudioOutputStreamAdapter } from "./_CompatAudioOutputStreamAdapter";
import { _CompatCameraAdapter, type _CompatPhotoRequestBridge } from "./_CompatCameraAdapter";
import { _CompatEventManagerAdapter } from "./_CompatEventManagerAdapter";
import { _CompatSettingsAdapter } from "./_CompatSettingsAdapter";

export class _CompatMentraSessionAdapter {
  readonly session: MentraSession;

  readonly layouts: {
    showText: MentraSession["display"]["showText"];
    showTextWall: MentraSession["display"]["showTextWall"];
    showDoubleTextWall: MentraSession["display"]["showDoubleTextWall"];
    showReferenceCard: MentraSession["display"]["showReferenceCard"];
    showDashboardCard: MentraSession["display"]["showDashboardCard"];
    showBitmap: MentraSession["display"]["showBitmap"];
    clear: MentraSession["display"]["clear"];
    updateText: (payload: { text: string }) => void;
  };
  readonly simpleStorage: MentraSession["storage"];
  readonly audio: {
    speak: MentraSession["speaker"]["speak"];
    playAudio: (options: {
      url: string;
      volume?: number;
      trackId?: 0 | 1 | 2;
      stopOtherAudio?: boolean;
    }) => Promise<any>;
    stopAudio: (trackId?: 0 | 1 | 2) => Promise<void>;
    createOutputStream: (options?: Record<string, any>) => Promise<_CompatAudioOutputStreamAdapter>;
  };
  readonly camera: _CompatCameraAdapter;
  readonly led: MentraSession["led"];
  readonly location: MentraSession["location"];
  readonly device: MentraSession["device"];
  readonly dashboard: MentraSession["dashboard"];
  readonly settings: _CompatSettingsAdapter;
  readonly events: _CompatEventManagerAdapter;

  constructor(
    session: MentraSession,
    options?: {
      photoRequestBridge?: _CompatPhotoRequestBridge;
    },
  ) {
    this.session = session;
    this.layouts = {
      showText: session.display.showText.bind(session.display),
      showTextWall: session.display.showTextWall.bind(session.display),
      showDoubleTextWall: session.display.showDoubleTextWall.bind(session.display),
      showReferenceCard: session.display.showReferenceCard.bind(session.display),
      showDashboardCard: session.display.showDashboardCard.bind(session.display),
      showBitmap: session.display.showBitmap.bind(session.display),
      clear: session.display.clear.bind(session.display),
      updateText: ({ text }) => session.display.showTextWall(text),
    };
    this.simpleStorage = session.storage;
    this.audio = {
      speak: session.speaker.speak.bind(session.speaker),
      playAudio: (options) =>
        session.speaker.play({
          url: options.url,
          volume: options.volume,
          trackId: options.trackId,
          stopOtherAudio: options.stopOtherAudio,
        }),
      stopAudio: (trackId) => session.speaker.stop(trackId),
      createOutputStream: async (options?: Record<string, any>) =>
        new _CompatAudioOutputStreamAdapter(await session.speaker.createStream(options)),
    };
    this.camera = new _CompatCameraAdapter(session, {
      photoRequestBridge: options?.photoRequestBridge,
      getCompatSession: () => this,
    });
    this.led = session.led;
    this.location = session.location;
    this.device = session.device;
    this.dashboard = session.dashboard;
    this.settings = new _CompatSettingsAdapter(session);
    this.events = new _CompatEventManagerAdapter(session);
  }

  get userId(): string | undefined {
    return this.session.userId;
  }

  get packageName(): string {
    return this.session.packageName;
  }

  getSessionId(): string {
    return this.session.sessionId;
  }

  getPackageName(): string {
    return this.session.packageName;
  }

  onTranscription(handler: (data: any) => void): () => void {
    return this.events.onTranscription(handler);
  }

  onTranscriptionForLanguage(language: string, handler: (data: any) => void): () => void {
    return this.events.onTranscriptionForLanguage(language, handler);
  }

  onTranslationForLanguage(source: string, target: string, handler: (data: any) => void): () => void {
    return this.session.translation.fromTo(source, target, handler);
  }

  onHeadPosition(handler: (data: any) => void): () => void {
    return this.events.onHeadPosition(handler);
  }

  onButtonPress(handler: (data: any) => void): () => void {
    return this.events.onButtonPress(handler);
  }

  onTouchEvent(gestureOrHandler: string | ((data: any) => void), handler?: (data: any) => void): () => void {
    return this.events.onTouchEvent(gestureOrHandler, handler);
  }

  onPhoneNotifications(handler: (data: any) => void): () => void {
    return this.events.onPhoneNotifications(handler);
  }

  onPhoneNotificationDismissed(handler: (data: any) => void): () => void {
    return this.events.onPhoneNotificationDismissed(handler);
  }

  onVpsCoordinates(handler: (data: any) => void): () => void {
    return this.events.onVpsCoordinates(handler);
  }

  onPhotoTaken(handler: (data: any) => void): () => void {
    return this.events.onPhotoTaken(handler);
  }

  async releaseOwnership(reason: "switching_clouds" | "clean_shutdown" | "user_logout"): Promise<void> {
    await this.session.releaseOwnership(reason);
  }

  async disconnect(_options?: {
    releaseOwnership?: boolean;
    reason?: "switching_clouds" | "clean_shutdown" | "user_logout";
  }): Promise<void> {
    if (_options?.releaseOwnership && _options.reason) {
      await this.releaseOwnership(_options.reason);
    }

    await this.session.disconnect();
  }

  updateSettingsForTesting(newSettings: AppSettings): void {
    this.session.updateSettingsForTesting(newSettings);
  }
}
