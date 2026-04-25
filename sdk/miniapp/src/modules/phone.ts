/**
 * @fileoverview PhoneModule — phone device-state events.
 *
 * Houses event subscriptions tied to the phone the user is carrying:
 * notifications, calendar, battery. Imperative phone-OS calls (share,
 * openUrl, copyToClipboard, download) live on `session.system` — different
 * shape (one-shot calls vs. event subscriptions) so we don't conflate them.
 *
 * READ_NOTIFICATIONS / CALENDAR permissions must be declared in miniapp.json
 * for the corresponding subscribe to succeed; the phone runtime rejects with
 * PERMISSION_NOT_DECLARED otherwise.
 */

import {MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {BatteryData, CalendarEventData, PhoneNotificationData, UnsubscribeFn} from "./events"

export class PhoneModule {
  constructor(private readonly session: MiniappSession) {}

  onNotification(handler: (data: PhoneNotificationData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.PHONE_NOTIFICATION, handler as (data: unknown) => void)
  }

  onCalendarEvent(handler: (data: CalendarEventData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.CALENDAR_EVENT, handler as (data: unknown) => void)
  }

  onBattery(handler: (data: BatteryData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.PHONE_BATTERY, handler as (data: unknown) => void)
  }
}
