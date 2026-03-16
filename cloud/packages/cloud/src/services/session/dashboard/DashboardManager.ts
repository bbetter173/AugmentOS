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
import { ColumnComposer } from "@mentra/display-utils";
import { G1_PROFILE } from "@mentra/display-utils/src/profiles/g1";

import { SYSTEM_DASHBOARD_PACKAGE_NAME } from "../../core/app.service";
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
    try {
      const summary = await weatherService.getWeather(this.userSession.userId, lat, lng);

      if (summary) {
        // Respect user's measurement preference when available.
        // UserSession doesn't expose an isMetric flag yet, so we default
        // to Fahrenheit (the more common preference among current users).
        // TODO: plumb userSession.isMetric once that field exists.
        const temp = `${summary.tempF}°F`;
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
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const oneHourMs = 60 * 60 * 1000;

    // Find the first relevant event:
    //   • starts in the future, OR started < 1 hour ago and hasn't ended yet
    //   • within the next 7 days from now
    const upcoming = events.find((event) => {
      const startMs = Date.parse(event.dtStart);
      const endMs = event.dtEnd ? Date.parse(event.dtEnd) : startMs + oneHourMs;

      if (isNaN(startMs)) return false;

      const startsInFuture = startMs > now;
      const startedRecently = startMs <= now && now - startMs < oneHourMs && endMs > now;
      const withinWindow = startMs <= now + sevenDaysMs;

      return (startsInFuture || startedRecently) && withinWindow;
    });

    if (!upcoming) {
      this.calendarText = null;
      this.scheduleUpdate();
      return;
    }

    const startMs = Date.parse(upcoming.dtStart);
    const startDate = new Date(startMs);

    // Determine user's timezone for display; fall back to UTC.
    const tz = this.userSession.userTimezone || "UTC";

    // Figure out whether the event is today or tomorrow in the user's timezone.
    const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
    const startInTz = new Date(startDate.toLocaleString("en-US", { timeZone: tz }));

    const todayMidnight = new Date(nowInTz);
    todayMidnight.setHours(0, 0, 0, 0);

    const tomorrowMidnight = new Date(todayMidnight);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);

    const dayAfterTomorrowMidnight = new Date(tomorrowMidnight);
    dayAfterTomorrowMidnight.setDate(dayAfterTomorrowMidnight.getDate() + 1);

    const isToday = startInTz >= todayMidnight && startInTz < tomorrowMidnight;
    const isTomorrow = startInTz >= tomorrowMidnight && startInTz < dayAfterTomorrowMidnight;

    // Format time as "4pm" or "4:30pm".
    const hours24 = startInTz.getHours();
    const minutes = startInTz.getMinutes();
    const hours12 = hours24 % 12 || 12;
    const ampm = hours24 < 12 ? "am" : "pm";
    const timeStr = minutes === 0 ? `${hours12}${ampm}` : `${hours12}:${minutes.toString().padStart(2, "0")}${ampm}`;

    const title = upcoming.title || "Event";

    if (isToday) {
      this.calendarText = `${title} @ ${timeStr}`;
    } else if (isTomorrow) {
      this.calendarText = `tmr: ${title} @ ${timeStr}`;
    } else {
      // Within 7 days but not today/tomorrow — show abbreviated date.
      const month = startInTz.getMonth() + 1;
      const day = startInTz.getDate();
      this.calendarText = `${month}/${day}: ${title} @ ${timeStr}`;
    }

    this.logger.debug({ calendarText: this.calendarText }, "Calendar updated");
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
        packageName: SYSTEM_DASHBOARD_PACKAGE_NAME,
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
   *   Row 1: column-split header  →  "◌ $DATE$, $GBATT$" | weather/calendar
   *   Rows 2-4: full-width body   →  notifications (may be multi-line) + widget
   *
   * (Renamed from generateMainLayout.)
   */
  private generateLayout(): Layout {
    const headerLeft = this.formatHeaderLeft();
    const headerRight = this.formatHeaderRight();

    // Row 1: pixel-accurate column-split header via ColumnComposer (1 line only).
    // Left: time + battery token. Right: calendar or weather. Short predictable
    // content on both sides means near-zero overflow risk (see spec §4b for the
    // overflow fix that was also applied to ColumnComposer.calculateSpacesForAlignment).
    const composer = new ColumnComposer(G1_PROFILE, "character-no-hyphen");
    const composedHeader = headerRight
      ? composer.composeDoubleTextWall(headerLeft, headerRight, { columnConfig: { maxLines: 1 } }).composedText
      : headerLeft;

    // Rows 2-4: full-width body.
    const notificationLines = this.notificationService.getDisplayText(); // may be empty
    const widgetLine = this.getNextWidget(); // may be empty

    const bodyParts = [notificationLines, widgetLine].filter((s) => s.trim().length > 0);
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
    return "◌ $DATE$, $GBATT$";
  }

  /**
   * Right side of the header row.
   * Shows the most time-sensitive data available:
   *   1. Upcoming calendar event (if any)
   *   2. Weather (if available)
   *   3. Empty string
   *
   * (Renamed from formatSystemRightSection.)
   */
  private formatHeaderRight(): string {
    return this.calendarText ?? this.weatherText ?? "";
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
