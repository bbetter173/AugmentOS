/**
 * Shared shutdown state — used across index.ts, hono-app.ts, and bun-websocket.ts
 * to coordinate graceful shutdown on SIGTERM/SIGINT.
 *
 * See: cloud/issues/063-graceful-shutdown/spec.md
 */

let _isShuttingDown = false;

export function isShuttingDown(): boolean {
  return _isShuttingDown;
}

export function setShuttingDown(): void {
  _isShuttingDown = true;
}
