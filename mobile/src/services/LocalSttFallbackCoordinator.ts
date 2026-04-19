import CoreModule from "core"

import STTModelManager from "@/services/STTModelManager"
import {useSettingsStore, SETTINGS} from "@/stores/settings"

/**
 * Test-mode coordinator: when the feature flag is on AND a local miniapp is
 * subscribed to transcription, always run local STT (no watchdog, no cloud
 * recovery logic). Meant for validating the local-STT pipeline end-to-end
 * before layering in cloud-failure detection.
 */
class LocalSttFallbackCoordinator {
  private static instance: LocalSttFallbackCoordinator

  private hasTranscriptionSubscription = false
  private activeLanguage: string | null = null
  private localActive = false

  private constructor() {
    useSettingsStore.subscribe(
      (s) => s.getSetting(SETTINGS.local_stt_fallback_enabled.key),
      (enabled) => {
        this.log(`feature flag changed: ${enabled}`)
        void this.reconcile()
      },
    )
  }

  static getInstance(): LocalSttFallbackCoordinator {
    if (!LocalSttFallbackCoordinator.instance) {
      LocalSttFallbackCoordinator.instance = new LocalSttFallbackCoordinator()
    }
    return LocalSttFallbackCoordinator.instance
  }

  isActive(): boolean {
    return this.localActive
  }

  getActiveLanguage(): string | null {
    return this.activeLanguage
  }

  onSubscriptionChange(hasTranscription: boolean, language: string | null): void {
    this.log(`onSubscriptionChange(hasTx=${hasTranscription}, lang=${language})`)
    this.hasTranscriptionSubscription = hasTranscription
    this.activeLanguage = hasTranscription ? language : null
    void this.reconcile()
  }

  // Kept for API compatibility; unused in test mode.
  onVad(_isSpeaking: boolean): void {}
  onCloudTranscript(): void {}

  private async reconcile(): Promise<void> {
    const flag = this.flagEnabled()
    const shouldBeActive = flag && this.hasTranscriptionSubscription

    if (shouldBeActive && !this.localActive) {
      await this.startLocalStt()
    } else if (!shouldBeActive && this.localActive) {
      this.stopLocalStt("subscription gone or flag disabled")
    }
  }

  private async startLocalStt(): Promise<void> {
    this.log("starting local stt")
    try {
      await CoreModule.restartTranscriber()
    } catch (err) {
      this.log(`restartTranscriber failed: ${err}`)
    }
    useSettingsStore.getState().setSetting(SETTINGS.local_stt_fallback_active.key, true)
    this.localActive = true
  }

  private stopLocalStt(reason: string): void {
    this.log(`stopping local stt: ${reason}`)
    useSettingsStore.getState().setSetting(SETTINGS.local_stt_fallback_active.key, false)
    this.localActive = false
  }

  private flagEnabled(): boolean {
    return !!useSettingsStore.getState().getSetting(SETTINGS.local_stt_fallback_enabled.key)
  }

  private log(msg: string): void {
    console.log(`[LocalSttFallback] ${msg}`)
  }
}

const localSttFallbackCoordinator = LocalSttFallbackCoordinator.getInstance()
export default localSttFallbackCoordinator
