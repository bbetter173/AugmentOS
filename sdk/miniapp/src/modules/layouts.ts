/**
 * @fileoverview LayoutManager — glasses display layouts.
 *
 * Each method builds a DISPLAY request payload and sends it via the session.
 * The phone's LocalMiniappRuntime translates the payload into a CoreModule
 * displayEvent call.
 *
 * No client-side rendering, no Jimp, no bitmap conversion. Bitmaps are sent
 * as base64 strings and the phone's SGC handles the conversion to G1/G2 format.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export type ViewType = "main" | "dashboard"

export interface ShowTextWallOptions {
  view?: ViewType
  durationMs?: number
}

export interface ShowDoubleTextWallOptions extends ShowTextWallOptions {}

export interface ShowReferenceCardOptions extends ShowTextWallOptions {}

export interface ShowBitmapViewOptions {
  view?: ViewType
  /** Base64-encoded PNG/JPEG. Phone SGC converts to G1/G2 1-bit BMP. */
  data: string
  durationMs?: number
}

export interface ShowBitmapAnimationOptions {
  view?: ViewType
  /** Array of base64-encoded frames in playback order. */
  frames: string[]
  /** Frame interval in milliseconds. */
  intervalMs: number
  /** Loop count. 0 = loop forever. */
  loopCount?: number
}

export class LayoutManager {
  constructor(private readonly session: MiniappSession) {}

  /** Show a single block of text filling the glasses display. */
  showTextWall(text: string, options: ShowTextWallOptions = {}): void {
    this.session.sendOneShot({
      type: MiniappRequestType.DISPLAY,
      layout: "text_wall",
      view: options.view ?? "main",
      text,
      durationMs: options.durationMs,
    })
  }

  /** Two stacked text rows — top and bottom. */
  showDoubleTextWall(topText: string, bottomText: string, options: ShowDoubleTextWallOptions = {}): void {
    this.session.sendOneShot({
      type: MiniappRequestType.DISPLAY,
      layout: "double_text_wall",
      view: options.view ?? "main",
      topText,
      bottomText,
      durationMs: options.durationMs,
    })
  }

  /** Reference card — title plus body text. */
  showReferenceCard(title: string, body: string, options: ShowReferenceCardOptions = {}): void {
    this.session.sendOneShot({
      type: MiniappRequestType.DISPLAY,
      layout: "reference_card",
      view: options.view ?? "main",
      title,
      body,
      durationMs: options.durationMs,
    })
  }

  /** Dashboard card — for sections that appear in the OS dashboard. V1: noop (see 2.14). */
  showDashboardCard(title: string, body: string): void {
    // Dashboard is deferred in v1 per Phase 2.14. Keep the API for type-safety
    // but forward as a normal display on the dashboard view for now so miniapps
    // can still exercise the surface; LocalMiniappRuntime will noop it.
    this.session.sendOneShot({
      type: MiniappRequestType.DISPLAY,
      layout: "dashboard_card",
      view: "dashboard",
      title,
      body,
    })
  }

  /** Show a bitmap. Phone SGC handles conversion to glasses-native format. */
  showBitmapView(options: ShowBitmapViewOptions): void {
    this.session.sendOneShot({
      type: MiniappRequestType.DISPLAY,
      layout: "bitmap_view",
      view: options.view ?? "main",
      data: options.data,
      durationMs: options.durationMs,
    })
  }

  /** Play a sequence of bitmap frames. */
  showBitmapAnimation(options: ShowBitmapAnimationOptions): void {
    this.session.sendOneShot({
      type: MiniappRequestType.DISPLAY,
      layout: "bitmap_animation",
      view: options.view ?? "main",
      frames: options.frames,
      intervalMs: options.intervalMs,
      loopCount: options.loopCount ?? 1,
    })
  }

  /** Clear the specified view. */
  clearView(view: ViewType = "main"): void {
    this.session.sendOneShot({
      type: MiniappRequestType.DISPLAY,
      layout: "clear",
      view,
    })
  }
}
