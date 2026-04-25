/**
 * @fileoverview InputModule — physical control events on the glasses.
 *
 * Combines button + touch surfaces. Future input modes (gesture, voice
 * command, eye tracking) will extend this module rather than spawning new
 * top-level modules.
 */

import {MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {ButtonPressData, TouchData, UnsubscribeFn} from "./events"

export class InputModule {
  constructor(private readonly session: MiniappSession) {}

  onButtonPress(handler: (data: ButtonPressData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.BUTTON_PRESS, handler as (data: unknown) => void)
  }

  onTouch(handler: (data: TouchData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.TOUCH_EVENT, handler as (data: unknown) => void)
  }
}
