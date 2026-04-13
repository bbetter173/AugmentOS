/**
 * @fileoverview AudioModule — glasses / phone audio output.
 *
 * - play({audioUrl}): play an arbitrary URL via the phone's audioPlaybackService.
 * - speak(text): send a SPEAK request. Phone constructs the cloud TTS URL from
 *   phone-side cloudUrl config, fetches the MP3, and plays it. Resolves when
 *   playback completes. Rejects with a TTS_* error code if cloud TTS fails.
 * - stop(): stop any audio this miniapp has playing.
 */

import {MiniappErrorCode, MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export interface PlayAudioOptions {
  audioUrl: string
  volume?: number
  stopOtherAudio?: boolean
}

export interface SpeakOptions {
  voice_id?: string
  voice_settings?: Record<string, unknown>
  volume?: number
  stopOtherAudio?: boolean
}

export interface SpeakResult {
  /** True if playback completed; false if playback was interrupted. */
  completed: boolean
}

export class AudioModule {
  constructor(private readonly session: MiniappSession) {}

  /** Play a URL. Resolves when playback completes on the phone. */
  async play(options: PlayAudioOptions): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.PLAY_AUDIO,
      audioUrl: options.audioUrl,
      volume: options.volume,
      stopOtherAudio: options.stopOtherAudio ?? false,
    })
  }

  /**
   * Speak text via cloud TTS. Phone constructs the TTS URL (miniapp SDK has no
   * `cloudUrl`), fetches the MP3, and plays it through the phone audio output.
   *
   * Rejects with a MiniappRequestError containing a `code` field on cloud-side
   * TTS failures: `TTS_TEXT_TOO_LONG`, `TTS_INVALID_VOICE`, `TTS_UPSTREAM_ERROR`.
   */
  async speak(text: string, options: SpeakOptions = {}): Promise<SpeakResult> {
    try {
      const result = await this.session.sendRequest<SpeakResult | null>({
        type: MiniappRequestType.SPEAK,
        text,
        voice_id: options.voice_id,
        voice_settings: options.voice_settings,
        volume: options.volume,
        stopOtherAudio: options.stopOtherAudio ?? false,
      })
      return result ?? {completed: true}
    } catch (err) {
      // Normalize so callers can `catch (e) { if (e.code === "TTS_TEXT_TOO_LONG") ...`
      if (err && typeof err === "object" && "code" in err) {
        throw err
      }
      throw {code: MiniappErrorCode.INTERNAL, message: String(err)}
    }
  }

  /** Stop any audio this miniapp is currently playing. */
  stop(): void {
    this.session.sendOneShot({type: MiniappRequestType.STOP_AUDIO})
  }
}
