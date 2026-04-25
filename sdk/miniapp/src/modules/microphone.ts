/**
 * @fileoverview MicrophoneModule — audio input event subscriptions.
 *
 * Houses transcription / translation / VAD / raw audio chunk events. Audio
 * *output* (TTS, file playback) lives on `session.audio` — the split is by
 * I/O direction since they have different permissions, lifecycles, and
 * developer mental models.
 *
 * MICROPHONE permission must be declared in miniapp.json for any of these
 * subscriptions to succeed; the phone runtime rejects with
 * PERMISSION_NOT_DECLARED otherwise.
 */

import {MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {
  AudioChunkData,
  TranscriptionData,
  TranslationData,
  UnsubscribeFn,
  VadData,
} from "./events"

export class MicrophoneModule {
  constructor(private readonly session: MiniappSession) {}

  /**
   * Subscribe to live transcription.
   *
   * By default subscribes to `transcription:auto` — the cloud auto-detects
   * the spoken language. The detected language is in `data.language`. Pass
   * a BCP-47 tag (e.g. `"en-US"`) to pin a specific language.
   *
   * Overload form:
   *   onTranscription(handler)              — auto-detect
   *   onTranscription(language, handler)    — pinned to `language`
   */
  onTranscription(handler: (data: TranscriptionData) => void): UnsubscribeFn
  onTranscription(language: string, handler: (data: TranscriptionData) => void): UnsubscribeFn
  onTranscription(
    languageOrHandler: string | ((data: TranscriptionData) => void),
    maybeHandler?: (data: TranscriptionData) => void,
  ): UnsubscribeFn {
    const language = typeof languageOrHandler === "string" ? languageOrHandler : "auto"
    const handler =
      typeof languageOrHandler === "function" ? languageOrHandler : (maybeHandler as (data: TranscriptionData) => void)
    return this.session._subscribe(
      `${MiniappStreamType.TRANSCRIPTION}:${language}`,
      handler as (data: unknown) => void,
    )
  }

  /** Subscribe to translated transcription from `fromLang` to `toLang`. */
  onTranslation(
    fromLang: string,
    toLang: string,
    handler: (data: TranslationData) => void,
  ): UnsubscribeFn {
    return this.session._subscribe(
      `${MiniappStreamType.TRANSLATION}:${fromLang}:${toLang}`,
      handler as (data: unknown) => void,
    )
  }

  /**
   * Subscribe to voice activity detection (VAD) events. `data.status` is
   * `true` while the user is speaking, `false` when silent.
   */
  onVoiceActivity(handler: (data: VadData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.VAD, handler as (data: unknown) => void)
  }

  /**
   * Subscribe to raw audio chunks. Format depends on the phone's mic mode
   * (PCM or LC3, base64-encoded).
   */
  onAudioChunk(handler: (data: AudioChunkData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.AUDIO_CHUNK, handler as (data: unknown) => void)
  }
}
