/**
 * @fileoverview LedModule — glasses RGB LED control.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export type LedAction = "set" | "blink" | "pulse" | "off"

export interface LedColor {
  r: number
  g: number
  b: number
}

export interface LedOptions {
  ontimeMs?: number
  offtimeMs?: number
  count?: number
}

export class LedModule {
  constructor(private readonly session: MiniappSession) {}

  setColor(action: LedAction, color: LedColor, options: LedOptions = {}): void {
    this.session.sendOneShot({
      type: MiniappRequestType.RGB_LED,
      action,
      color,
      ontimeMs: options.ontimeMs,
      offtimeMs: options.offtimeMs,
      count: options.count,
    })
  }

  off(): void {
    this.setColor("off", {r: 0, g: 0, b: 0})
  }
}
