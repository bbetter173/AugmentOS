/**
 * DashboardManager
 *
 * Cloud-internal service that owns all dashboard data and drives its own
 * render cycle. The external Dashboard mini-app has been removed — all
 * data that app used to provide now lives here directly.
 *
 * Data sources:
 *  - Phone notifications  → NotificationService (LLM-ranked)
 *  - Weather              → weatherService singleton
 *  - Calendar events      → onCalendarUpdate() called from CalendarManager
 *  - Third-party widgets  → handleDashboardContentUpdate() from MiniApps
 *
 * Render cycle:
 *  - scheduleUpdate() debounces calls, fires render() after ≥500 ms
 *  - heartbeatTimer fires scheduleUpdate() every 60 s to keep clock token fresh
 */

import { Logger } from "pino";
import { DateTime } from "luxon";

import {
  AppToCloudMessageType,
  CalendarEvent,
  DashboardContentUpdate,
  DashboardMode,
  DisplayRequest,
  Layout,
  LayoutType,
  AppToCloudMessage,
  ViewType,
} from "@mentra/sdk";
import { ColumnComposer, G1_PROFILE } from "@mentra/display-utils";

// Internal package name for OS-generated display requests.
// Matches OS_PACKAGE_NAME in DisplayManager6.1.ts — both must stay in sync.
const OS_PACKAGE_NAME = "com.mentra.os" as const;
import { weatherService } from "../../core/WeatherService";
import UserSession from "../UserSession";
import { NotificationService, PhoneNotification } from "./NotificationService";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Dashboard widget content from a third-party MiniApp.
 */
interface DashboardWidget {
  packageName: string;
  content: string | Layout;
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// DashboardManager
// ---------------------------------------------------------------------------

export class DashboardManager {
  // ------------------------------------------------------------------
  // Third-party widget state
  // ------------------------------------------------------------------

  /** One entry per MiniApp package name — last-write wins. */
  private mainWidgets: Map<string, DashboardWidget> = new Map();

  /** Circular-queue index for cycling through widgets on heads-up. */
  private widgetRotationIndex = 0;

  // ------------------------------------------------------------------
  // Cloud-owned data
  // ------------------------------------------------------------------

  private weatherText: string | null = null;
  private calendarText: string | null = null;
  private notificationService: NotificationService;

  // ------------------------------------------------------------------
  // Timers
  // ------------------------------------------------------------------

  /** 60-second heartbeat — keeps the clock/battery tokens visually fresh. */
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /**
   * Debounce timer — ensures we don't spam the display pipeline with
   * back-to-back renders when multiple data sources update at once.
   */
  private updateTimer: NodeJS.Timeout | null = null;

  // ------------------------------------------------------------------
  // Infrastructure
  // ------------------------------------------------------------------

  private readonly userSession: UserSession;
  private readonly logger: Logger;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({
      service: "DashboardManager",
      sessionId: userSession.sessionId,
    });
    this.notificationService = new NotificationService(this.logger);

    // Heartbeat — fires scheduleUpdate() every 60 s to keep clock token fresh.
    this.heartbeatTimer = setInterval(() => this.scheduleUpdate(), 60_000);

    this.logger.info({ userId: userSession.userId }, "DashboardManager initialized");
  }

  // ---------------------------------------------------------------------------
  // Public message routing
  // ---------------------------------------------------------------------------

  /**
   * Route an incoming AppToCloudMessage to the appropriate handler.
   * Returns true if the message was a recognised dashboard message.
   */
  public handleMiniAppMessage(message: AppToCloudMessage): boolean {
    this.logger.debug({ type: message.type }, `Received MiniApp message of type ${message.type}`);

    try {
      switch (message.type) {
        case AppToCloudMessageType.DASHBOARD_CONTENT_UPDATE:
          this.handleDashboardContentUpdate(message as DashboardContentUpdate);
          return true;

        default:
          return false; // Not a dashboard message
      }
    } catch (error) {
      this.logger.error(
        { error, messageType: message.type },
        `Error handling dashboard message of type ${message.type}`,
      );
      return false;
    }
  }

  /**
   * Legacy alias kept for callers that haven't been migrated yet.
   * @deprecated Use handleMiniAppMessage()
   */
  public handleAppMessage(message: AppToCloudMessage): boolean {
    return this.handleMiniAppMessage(message);
  }

  // ---------------------------------------------------------------------------
  // Public lifecycle hooks — called by peer managers
  // ---------------------------------------------------------------------------

  /**
   * Called when a MiniApp disconnects. Removes its widget and re-renders.
   */
  public handleMiniAppDisconnected(packageName: string): void {
    this.cleanupWidgets(packageName);
    this.logger.info({ packageName }, `Cleaned up dashboard widgets for disconnected MiniApp: ${packageName}`);
  }

  /**
   * Legacy alias kept for callers that haven't been migrated yet.
   * @deprecated Use handleMiniAppDisconnected()
   */
  public handleAppDisconnected(packageName: string): void {
    return this.handleMiniAppDisconnected(packageName);
  }

  // ---------------------------------------------------------------------------
  // Public data hooks — called from API / manager handlers
  // ---------------------------------------------------------------------------

  /**
   * Called when the phone delivers a new notification.
   */
  onNotification(notification: PhoneNotification): void {
    this.logger.info({ uuid: notification.uuid, title: notification.title }, "onNotification called");
    this.notificationService.add(notification);
    this.scheduleUpdate();
  }

  /**
   * Called when the user dismisses a notification on their phone.
   */
  onNotificationDismissed(notificationId: string): void {
    this.notificationService.dismiss(notificationId);
    this.scheduleUpdate();
  }

  /**
   * Called when a fresh GPS fix arrives. Fetches weather, then re-renders.
   */
  async onLocationUpdate(lat: number, lng: number): Promise<void> {
    this.logger.info({ lat, lng }, "onLocationUpdate called");
    try {
      const summary = await weatherService.getWeather(this.userSession.userId, lat, lng);

      if (summary) {
        const isMetric = this.userSession.userSettingsManager.getSnapshot()?.metric_system === true;
        const temp = isMetric ? `${summary.tempC}°C` : `${summary.tempF}°F`;
        this.weatherText = `${summary.condition}, ${temp}`;
        this.logger.debug({ weatherText: this.weatherText }, "Weather updated");
      } else {
        this.logger.debug({ lat, lng }, "Weather fetch returned null — keeping previous value");
      }
    } catch (err) {
      this.logger.warn({ err, lat, lng }, "onLocationUpdate: weather fetch failed");
    }

    this.scheduleUpdate();
  }

  /**
   * Called when the calendar syncs. Finds the next upcoming event within
   * 7 days and formats it for the header right slot.
   */
  onCalendarUpdate(events: CalendarEvent[]): void {
    this.logger.info({ eventCount: events.length }, "onCalendarUpdate called");

    // User's IANA timezone — all comparisons are made from the user's perspective.
    const tz = this.userSession.userTimezone || "UTC";
    const nowDt = DateTime.now().setZone(tz);

    // Find the first relevant event in the user's timezone:
    //   • starts in the future, OR started < 1 hour ago and hasn't ended yet
    //   • within the next 7 days
    // Helper: detect all-day events. Expo sets allDay on the raw event; after
    // normalization we also detect it by checking UTC midnight boundaries
    // (dtStart at 00:00Z and dtEnd exactly 24h/48h/… multiples later).
    const isEventAllDay = (event: CalendarEvent): boolean => {
      if ((event as any).allDay === true) return true;
      const s = DateTime.fromISO(event.dtStart, { zone: "UTC" });
      const e = event.dtEnd ? DateTime.fromISO(event.dtEnd, { zone: "UTC" }) : null;
      if (!s.isValid || !e || !e.isValid) return false;
      const bothMidnight =
        s.hour === 0 && s.minute === 0 && s.second === 0 && e.hour === 0 && e.minute === 0 && e.second === 0;
      const spansDays = e.diff(s, "days").days >= 1;
      return bothMidnight && spansDays;
    };

    // Helper: for all-day events, the "calendar date" is the UTC date of dtStart
    // (not shifted to user TZ, since 2026-03-18T00:00Z means "March 18" regardless
    // of the user being in Pacific where that's 5pm on the 17th).
    // For timed events, the calendar date is in the user's timezone.
    const eventCalendarDate = (event: CalendarEvent, allDay: boolean): DateTime => {
      if (allDay) {
        // Interpret dtStart in UTC to get the intended calendar date,
        // then strip the time so hasSame("day") works against user's "today".
        const utcDt = DateTime.fromISO(event.dtStart, { zone: "UTC" });
        // Re-create as a date-only in the user's timezone so hasSame comparisons work.
        return DateTime.fromObject({ year: utcDt.year, month: utcDt.month, day: utcDt.day }, { zone: tz });
      }
      return DateTime.fromISO(event.dtStart, { zone: tz });
    };

    // Relevance check: event starts in the future or started recently and hasn't ended.
    const isRelevant = (event: CalendarEvent): boolean => {
      const allDay = isEventAllDay(event);
      const calDt = eventCalendarDate(event, allDay);
      if (!calDt.isValid) return false;

      if (allDay) {
        // All-day events are relevant if their calendar date is today or in the future,
        // up to 7 days out.
        return calDt >= nowDt.startOf("day") && calDt <= nowDt.plus({ days: 7 }).endOf("day");
      }

      const startDt = DateTime.fromISO(event.dtStart, { zone: tz });
      const endDt = event.dtEnd ? DateTime.fromISO(event.dtEnd, { zone: tz }) : startDt.plus({ hours: 1 });
      const startsInFuture = startDt > nowDt;
      const startedRecently = startDt <= nowDt && nowDt.diff(startDt, "hours").hours < 1 && endDt > nowDt;
      const withinWindow = startDt <= nowDt.plus({ days: 7 });
      return (startsInFuture || startedRecently) && withinWindow;
    };

    // Prefer timed events today over all-day events. Strategy:
    //   1. Find the first relevant timed event.
    //   2. Find the first relevant all-day event.
    //   3. If we have a timed event that is today, prefer it. Otherwise fall back
    //      to whichever is soonest.
    const firstTimedEvent = events.find((e) => !isEventAllDay(e) && isRelevant(e));
    const firstAllDayEvent = events.find((e) => isEventAllDay(e) && isRelevant(e));

    let upcoming: CalendarEvent | undefined;
    if (firstTimedEvent) {
      const timedDt = DateTime.fromISO(firstTimedEvent.dtStart, { zone: tz });
      if (timedDt.hasSame(nowDt, "day")) {
        // A timed event today always wins over an all-day event.
        upcoming = firstTimedEvent;
      } else if (firstAllDayEvent) {
        // Both are future — pick whichever calendar date comes first.
        const allDayCalDt = eventCalendarDate(firstAllDayEvent, true);
        upcoming = timedDt <= allDayCalDt ? firstTimedEvent : firstAllDayEvent;
      } else {
        upcoming = firstTimedEvent;
      }
    } else {
      upcoming = firstAllDayEvent;
    }

    if (!upcoming) {
      this.calendarText = null;
      this.scheduleUpdate();
      return;
    }

    const title = upcoming.title || "Event";
    const allDay = isEventAllDay(upcoming);
    const calDt = eventCalendarDate(upcoming, allDay);

    // DST-safe day comparisons using Luxon — server timezone is irrelevant.
    const isToday = calDt.hasSame(nowDt, "day");
    const isTomorrow = calDt.hasSame(nowDt.plus({ days: 1 }), "day");

    if (allDay) {
      // All-day: no time — just context label
      if (isToday) {
        this.calendarText = `${title} Today`;
      } else if (isTomorrow) {
        this.calendarText = `${title} tmr`;
      } else {
        this.calendarText = `${title} ${calDt.toFormat("M/d")}`;
      }
    } else {
      // Timed event: format as "4pm" or "4:30pm"
      const timeStr = calDt.toFormat(calDt.minute === 0 ? "ha" : "h:mma").toLowerCase();

      if (isToday) {
        this.calendarText = `${title} @ ${timeStr}`;
      } else if (isTomorrow) {
        this.calendarText = `tmr: ${title} @ ${timeStr}`;
      } else {
        this.calendarText = `${calDt.toFormat("M/d")}: ${title} @ ${timeStr}`;
      }
    }

    this.logger.debug({ calendarText: this.calendarText, allDay, isToday, isTomorrow }, "Calendar updated");
    this.scheduleUpdate();
  }

  // ---------------------------------------------------------------------------
  // MiniApp widget content handling
  // ---------------------------------------------------------------------------

  /**
   * Store the latest widget content from a MiniApp.
   */
  public handleDashboardContentUpdate(message: DashboardContentUpdate): void {
    const { packageName, content, modes, timestamp } = message;

    this.logger.debug(
      { packageName, modes, timestamp },
      `Dashboard content update from ${packageName} for modes [${modes.join(", ")}]`,
    );

    // We only track MAIN mode now; other modes are ignored.
    if (modes.includes(DashboardMode.MAIN)) {
      this.mainWidgets.set(packageName, {
        packageName,
        content,
        timestamp: timestamp instanceof Date ? timestamp : new Date(timestamp),
      });
    }

    this.scheduleUpdate();
  }

  // ---------------------------------------------------------------------------
  // Gesture handler
  // ---------------------------------------------------------------------------

  /**
   * Called when the user performs a heads-up gesture. Cycles through widget
   * rotation and re-renders.
   */
  public onHeadsUp(): void {
    if (this.mainWidgets.size <= 1) {
      this.logger.debug({ widgetCount: this.mainWidgets.size }, "Heads-up gesture — not enough widgets to cycle");
      // Still re-render so the display stays fresh.
      this.render();
      return;
    }

    this.widgetRotationIndex = (this.widgetRotationIndex + 1) % this.mainWidgets.size;

    this.logger.info(
      {
        newIndex: this.widgetRotationIndex,
        totalWidgets: this.mainWidgets.size,
        sessionId: this.userSession.sessionId,
      },
      "Heads-up gesture — cycling to next widget",
    );

    this.render();
  }

  // ---------------------------------------------------------------------------
  // Widget cleanup
  // ---------------------------------------------------------------------------

  /**
   * Remove all widget entries for the given MiniApp package and re-render.
   * (Renamed from cleanupAppContent.)
   */
  public cleanupWidgets(packageName: string): void {
    const hadWidget = this.mainWidgets.has(packageName);
    const sizeBefore = this.mainWidgets.size;

    this.mainWidgets.delete(packageName);

    // Adjust rotation index so it stays within bounds.
    if (hadWidget && sizeBefore > 1) {
      const newSize = this.mainWidgets.size;
      if (newSize > 0 && this.widgetRotationIndex >= newSize) {
        this.widgetRotationIndex = 0;
        this.logger.debug({ packageName, newSize }, "Reset widgetRotationIndex after widget removal");
      } else if (newSize === 0) {
        this.widgetRotationIndex = 0;
      }
    } else {
      this.widgetRotationIndex = 0;
    }

    this.logger.info(
      {
        packageName,
        hadWidget,
        remainingWidgets: Array.from(this.mainWidgets.keys()),
      },
      `Dashboard widgets cleaned up for: ${packageName}`,
    );

    this.scheduleUpdate();
  }

  /**
   * Legacy alias.
   * @deprecated Use cleanupWidgets()
   */
  public cleanupAppContent(packageName: string): void {
    return this.cleanupWidgets(packageName);
  }

  // ---------------------------------------------------------------------------
  // Render cycle
  // ---------------------------------------------------------------------------

  /**
   * Debounced render trigger.
   *
   * If a render is already queued, this is a no-op — let the existing timer
   * fire. Otherwise, schedule a render after at least 500 ms (or delayMs,
   * whichever is larger).
   */
  private scheduleUpdate(delayMs = 0): void {
    if (this.updateTimer !== null) {
      // A render is already queued; nothing to do.
      return;
    }

    this.updateTimer = setTimeout(
      () => {
        this.updateTimer = null;
        this.render();
      },
      Math.max(delayMs, 500),
    );
  }

  /**
   * Generate the current layout and push it to DisplayManager.
   * (Renamed from updateDashboard.)
   */
  private render(): void {
    try {
      const layout = this.generateLayout();

      const displayRequest: DisplayRequest = {
        type: AppToCloudMessageType.DISPLAY_REQUEST,
        packageName: OS_PACKAGE_NAME,
        view: ViewType.DASHBOARD,
        layout,
        timestamp: new Date(),
      };

      const sent = this.userSession.displayManager.handleDisplayRequest(displayRequest);

      if (!sent) {
        this.logger.warn(
          { userId: this.userSession.userId },
          "Dashboard display request was not sent — DisplayManager not ready",
        );
      } else {
        this.logger.debug(
          { userId: this.userSession.userId, layoutType: layout.layoutType },
          "Dashboard rendered successfully",
        );
      }
    } catch (error) {
      this.logger.error({ error, userId: this.userSession.userId }, "Error rendering dashboard");
    }
  }

  // ---------------------------------------------------------------------------
  // Layout generation
  // ---------------------------------------------------------------------------

  /**
   * Build the full dashboard Layout.
   *
   * Structure:
   *   Row 1: column-split header  →  "◌ $DATE$, $GBATT$" | weather
   *   Row 2: calendar event (full width — not truncated by column split)
   *   Rows 3-4: full-width body   →  notifications (may be multi-line) + widget
   *
   * (Renamed from generateMainLayout.)
   */
  private generateLayout(): Layout {
    const headerLeft = this.formatHeaderLeft();
    const weatherRight = this.weatherText ?? "";

    // Row 1: pixel-accurate column-split header via ColumnComposer (1 line only).
    // Left: time + battery token. Right: weather (always visible when available).
    const composer = new ColumnComposer(G1_PROFILE, "character-no-hyphen");
    const composedHeader = weatherRight
      ? composer.composeDoubleTextWall(headerLeft, weatherRight, { columnConfig: { maxLines: 1 } }).composedText
      : headerLeft;

    // Row 2: calendar event (full width — long titles like
    // "Mentra Financials + Equity - Overview + Discuss @ 5pm" need the space).
    const calendarLine = this.calendarText ?? "";

    // Rows 3-4: notifications + widgets.
    const notificationLines = this.notificationService.getDisplayText(); // may be empty
    const widgetLine = this.getNextWidget(); // may be empty

    const bodyParts = [calendarLine, notificationLines, widgetLine].filter((s) => s.trim().length > 0);
    const body = bodyParts.join("\n");

    const text = body ? `${composedHeader}\n${body}` : composedHeader;

    return {
      layoutType: LayoutType.TEXT_WALL,
      text,
    };
  }

  // ---------------------------------------------------------------------------
  // Header formatters
  // ---------------------------------------------------------------------------

  /**
   * Left side of the header row.
   * Tokens ($DATE$, $GBATT$) are resolved by the native layer at display time —
   * we do NOT compute time server-side.
   *
   * (Renamed from formatSystemLeftSection.)
   */
  private formatHeaderLeft(): string {
    return "◌ $DATE$, $TIME12$, $GBATT$";
  }

  // ---------------------------------------------------------------------------
  // Widget rotation
  // ---------------------------------------------------------------------------

  /**
   * Return the text for the currently-selected widget slot, rotating through
   * all registered MiniApp widgets.
   * (Renamed from getNextMainAppContent.)
   */
  private getNextWidget(): string {
    const widgets = Array.from(this.mainWidgets.values());

    if (widgets.length === 0) {
      return "";
    }

    if (widgets.length === 1) {
      return this.extractText(widgets[0].content);
    }

    // Sort by timestamp descending for consistent ordering.
    widgets.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const index = this.widgetRotationIndex % widgets.length;
    const selected = widgets[index];

    this.logger.debug(
      {
        index,
        total: widgets.length,
        selectedPackage: selected.packageName,
      },
      `Widget rotation: showing ${selected.packageName} (${index + 1}/${widgets.length})`,
    );

    return this.extractText(selected.content);
  }

  // ---------------------------------------------------------------------------
  // Content extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract a plain string from either a raw string or a Layout object.
   * (Renamed from extractTextFromContent.)
   */
  private extractText(content: string | Layout): string {
    if (typeof content === "string") {
      return content;
    }

    switch (content.layoutType) {
      case LayoutType.TEXT_WALL:
        return content.text || "";

      case LayoutType.DOUBLE_TEXT_WALL:
        return [content.topText, content.bottomText].filter(Boolean).join("\n");

      case LayoutType.DASHBOARD_CARD:
        return [content.leftText, content.rightText].filter(Boolean).join(" | ");

      case LayoutType.REFERENCE_CARD:
        return `${content.title}\n${content.text}`;

      default:
        return "";
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Clean up all timers and state. Called when the UserSession is torn down.
   */
  public dispose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    this.mainWidgets.clear();
    this.notificationService.dispose();

    this.logger.info({}, "DashboardManager disposed");
  }
}

export default DashboardManager;
