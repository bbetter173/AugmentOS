/**
 * LedManager — v3 SDK LED Control API
 *
 * Thin wrapper around the existing LedModule patterns. Provides a simplified
 * API for controlling RGB LEDs on connected smart glasses.
 *
 * Wire format is identical to v2:
 * ```json
 * {
 *   "type": "rgb_led_control",
 *   "packageName": "<packageName>",
 *   "sessionId": "<sessionId>",
 *   "requestId": "<requestId>",
 *   "action": "on" | "off",
 *   "color": "<LedColor>",
 *   "ontime": <ms>
 * }
 * ```
 *
 * @module
 */

import { AppToCloudMessageType } from "../../types";
import type { LedColor } from "../../types";

// ─── Internal Types ─────────────────────────────────────────────────────────

/**
 * Dependencies injected by MentraSession.
 *
 * Structural type — no concrete imports so the manager stays unit-testable
 * with plain stubs.
 */
export interface LedManagerDeps {
  /** DataStreamRouter — register for DATA_STREAM messages by streamType key. */
  router: {
    on(key: string, handler: (streamType: string, data: any, message: any) => void): () => void;
  };
  /** MessageHandlerRegistry — register for top-level message types. */
  messageHandlers: {
    register(type: string, handler: (msg: any) => void): () => void;
  };
  /** Add a subscription string (triggers SUBSCRIPTION_UPDATE to cloud). */
  addSubscription: (stream: string) => void;
  /** Remove a subscription string. */
  removeSubscription: (stream: string) => void;
  /** Send an arbitrary JSON message over the WebSocket. */
  sendMessage: (message: any) => void;
  /** Structured logger. */
  logger: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  /** Package name for outgoing messages. */
  getPackageName: () => string;
  /** Current session ID. */
  getSessionId: () => string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a unique request ID for LED control requests.
 * Uses `crypto.randomUUID()` when available, falls back to timestamp + random.
 */
function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `led_req_${crypto.randomUUID()}`;
  }
  return `led_req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// ─── Manager ────────────────────────────────────────────────────────────────

/**
 * Controls RGB LEDs on connected smart glasses.
 *
 * LED commands are fire-and-forget — the methods return immediately after
 * sending the control message to the cloud. No response is awaited.
 *
 * @example
 * ```ts
 * const session = await mentra.connect();
 *
 * // Solid green LED for 2 seconds
 * session.led.setColor("green", 2000);
 *
 * // Turn LED off
 * session.led.off();
 * ```
 */
export class LedManager {
  private readonly deps: LedManagerDeps;

  constructor(deps: LedManagerDeps) {
    this.deps = deps;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Set the LED to a specific colour.
   *
   * Sends an `rgb_led_control` message with `action: "on"` to the cloud.
   * The LED will remain on for `onTimeMs` milliseconds (defaults to 1000ms)
   * then turn off automatically on the device.
   *
   * @param color - LED colour name. One of `"red"`, `"green"`, `"blue"`, `"orange"`, `"white"`.
   * @param onTimeMs - Duration in milliseconds the LED stays on. Defaults to `1000`.
   *
   * @example
   * ```ts
   * // Red LED for 500ms
   * session.led.setColor("red", 500);
   *
   * // White LED for the default 1s
   * session.led.setColor("white");
   * ```
   */
  setColor(color: string, onTimeMs?: number): void {
    const requestId = generateRequestId();

    const message = {
      type: AppToCloudMessageType.RGB_LED_CONTROL,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      requestId,
      timestamp: new Date(),
      action: "on" as const,
      color: color as LedColor,
      ontime: onTimeMs ?? 1000,
      offtime: 0,
      count: 1,
    };

    this.deps.sendMessage(message);

    this.deps.logger.debug({ requestId, color, ontime: message.ontime }, "💡 LED setColor request sent");
  }

  /**
   * Turn the LED off.
   *
   * Sends an `rgb_led_control` message with `action: "off"` to the cloud.
   *
   * @example
   * ```ts
   * session.led.off();
   * ```
   */
  off(): void {
    const requestId = generateRequestId();

    const message = {
      type: AppToCloudMessageType.RGB_LED_CONTROL,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      requestId,
      timestamp: new Date(),
      action: "off" as const,
    };

    this.deps.sendMessage(message);

    this.deps.logger.debug({ requestId }, "💡 LED off request sent");
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  /**
   * Clean up resources.
   *
   * Called by MentraSession during disconnect/cleanup. LED commands are
   * fire-and-forget so there is no pending state to drain.
   *
   * @internal
   */
  destroy(): void {
    this.deps.logger.debug("[LedManager] Destroyed.");
  }
}
