# Spec: Graceful Shutdown on SIGTERM

## Overview

**What this doc covers:** Adding a SIGTERM handler to the cloud server that cleanly closes all WebSocket connections before the process exits, reducing deploy-caused user disruption from ~30-60 seconds to <2 seconds.
**Why this doc exists:** The cloud server does NOT handle SIGTERM. During deploys, Kubernetes sends SIGTERM, nobody handles it, K8s waits 30s, then SIGKILL. All WebSocket connections die without close frames — identical to a crash. Users see "disconnected" for 30-60s until their phone detects the dead connection via ping timeout. This is the #1 cause of deploy-related bug reports (#2318, #2323, #2332).
**What you need to know first:** [062 spike](../062-mongodb-latency/spike.md) for crash investigation, [061 spike](../061-crash-investigation/spike.md) for the crash chain.
**Who should read this:** Anyone reviewing the hotfix PR.

## The Problem in 30 Seconds

When Kubernetes deploys a new pod (rolling update), it sends SIGTERM to the old pod. Our server ignores it. After 30 seconds, Kubernetes sends SIGKILL. All ~65 WebSocket connections (glasses + apps + Soniox) are severed without close frames. The phone has no idea the server is gone — it waits for a ping timeout (30-60s) before reconnecting. During that window, REST requests hit the new pod which has no session → 503 "session not found." Users see "disconnected," "can't connect to app," and "retry" banners.

With a SIGTERM handler, the server sends WebSocket close frames to every connected client in <1 second. The phone detects the disconnect immediately and reconnects to the new pod. Deploy transition drops from 30-60s to <2s.

## Spec

### A1. SIGTERM Handler

**File:** `packages/cloud/src/index.ts`

**What:** Register a `process.on("SIGTERM", ...)` handler that:

1. Logs that shutdown has started
2. Marks the server as draining (stop accepting new WebSocket upgrades)
3. Sends WebSocket close frame (code 1001 "Going Away") to every connected glasses and app WebSocket
4. Stops all timers (app cache, vitals logger, GC probe, metrics)
5. Closes MongoDB connection
6. Exits with code 0

**Implementation:**

```typescript
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return; // prevent double-shutdown
  isShuttingDown = true;

  logger.info({ signal }, `${signal} received — starting graceful shutdown`);

  // 1. Close all glasses WebSocket connections
  const sessions = UserSession.getAllSessions();
  let closedGlasses = 0;
  let closedApps = 0;

  for (const session of sessions) {
    try {
      // Close glasses WebSocket with "Going Away" code
      if (session.websocket) {
        session.websocket.close(1001, "Server shutting down");
        closedGlasses++;
      }
      // Close all app WebSockets for this session
      if (session.appWebsockets) {
        for (const [, appWs] of session.appWebsockets) {
          try {
            appWs.close(1001, "Server shutting down");
            closedApps++;
          } catch {
            // Swallow — WebSocket might already be closed
          }
        }
      }
    } catch (error) {
      logger.warn({ error, userId: session.userId }, "Error closing WebSocket during shutdown");
    }
  }

  logger.info(
    { closedGlasses, closedApps, totalSessions: sessions.length },
    `Closed ${closedGlasses} glasses + ${closedApps} app WebSockets`,
  );

  // 2. Stop timers and services
  try {
    systemVitalsLogger.stop();
    appCache.stop();
    metricsService.stop();
  } catch {
    // Swallow — timers might already be stopped
  }

  // 3. Close MongoDB
  try {
    const mongoose = await import("mongoose");
    await mongoose.default.connection.close();
    logger.info("MongoDB connection closed");
  } catch {
    // Swallow — connection might already be closed
  }

  logger.info("Graceful shutdown complete — exiting");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT")); // for local dev (Ctrl+C)
```

**Why code 1001:** RFC 6455 defines 1001 as "Going Away" — "an endpoint is going away, such as a server going down." This is the semantically correct code for a server shutdown. The mobile client should already handle this — it's a standard WebSocket close code.

### A2. Drain Mode for Health Check

**File:** `packages/cloud/src/hono-app.ts`

**What:** When `isShuttingDown` is true, the `/health` endpoint returns HTTP 503 instead of 200. This tells Kubernetes (and the load balancer) to stop sending new requests to this pod immediately.

**Implementation:**

Export `isShuttingDown` from index.ts (or a shared module) and check it at the top of the `/health` handler:

```typescript
if (isShuttingDown) {
  return c.json({ status: "draining", message: "Server is shutting down" }, 503);
}
```

**Why:** Without this, the load balancer keeps routing new REST requests to the dying pod during the shutdown window. With it, the LB detects 503 within one health check interval (5s) and stops routing.

### A3. Reject New WebSocket Upgrades During Drain

**File:** `packages/cloud/src/services/websocket/bun-websocket.ts`

**What:** When `isShuttingDown` is true, reject new WebSocket upgrade requests with HTTP 503.

**Implementation:**

In `handleUpgrade()`, add at the top:

```typescript
if (isShuttingDown) {
  return new Response("Server is shutting down", { status: 503 });
}
```

**Why:** Prevents new sessions from being created on a pod that's about to die. The client will retry and hit the new pod.

## What This Does NOT Include

| Explicitly out of scope                    | Why                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session persistence / handoff to new pod   | Requires shared session store — major architecture change. Track separately.                                                                                                   |
| Mobile client reconnect improvements       | Mobile change, not cloud. Should detect 503 as reconnect signal — separate issue.                                                                                              |
| Soniox stream graceful close               | Sessions already dispose Soniox streams in their dispose() method. The WebSocket close triggers the phone to reconnect, which creates a new session with fresh Soniox streams. |
| Saving session state to DB before shutdown | Sessions are ephemeral by design. Users reconnect and state is rebuilt.                                                                                                        |

## Decision Log

| Decision                                          | Alternatives considered                            | Why we chose this                                                                                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Close all WebSockets synchronously in the handler | Dispose sessions (call session.dispose() for each) | dispose() is async and does a lot of cleanup (DB writes, Soniox close, etc.). In a shutdown, we just need to send close frames fast. The process is exiting — cleanup is unnecessary. |
| Code 1001 "Going Away"                            | 1000 "Normal", 1012 "Service Restart", custom code | 1001 is the RFC-defined code for server shutdown. Most WebSocket clients handle it natively. 1012 is not universally supported.                                                       |
| Handle both SIGTERM and SIGINT                    | SIGTERM only                                       | SIGINT is Ctrl+C during local development. Same handler avoids code duplication and gives developers the same clean shutdown experience.                                              |
| Don't call session.dispose()                      | Call dispose() for each session                    | dispose() triggers DB writes (location persist, posthog events, etc.) that could take seconds. During shutdown, speed matters. The close frame is all the phone needs to reconnect.   |
| Export isShuttingDown as a module-level flag      | Use an event emitter, use a shared state service   | A simple boolean is the simplest correct solution. No over-engineering needed.                                                                                                        |
| Close MongoDB after WebSockets                    | Close MongoDB first                                | WebSocket close is the time-critical operation (user-facing). MongoDB close is cleanup. Do the user-facing thing first.                                                               |

## Testing Plan

### On cloud-debug (before PR to main)

1. **Deploy triggers graceful shutdown** — deploy a new version to cloud-debug. Check logs for "SIGTERM received — starting graceful shutdown" and "Closed N glasses + M app WebSockets."
2. **WebSocket close frames sent** — connect glasses to debug, then redeploy. The phone should detect disconnect immediately (<2s) and show reconnecting, not "disconnected for 30 minutes."
3. **Health check returns 503 during drain** — after SIGTERM, curl the health endpoint. Should return 503, not 200.
4. **New WebSocket upgrades rejected** — try to connect glasses during the shutdown window. Should get 503, not upgrade.
5. **Process exits cleanly** — check that the pod exits with code 0, not SIGKILL (137).

### After PR to main (monitoring cloud-prod)

6. **Zero-downtime deploys** — deploy to prod and check: do users report disconnections? Check BetterStack for "session not found" errors in the 60 seconds around a deploy. Should be near-zero.
7. **Bug report frequency** — issues like #2318, #2323, #2332 should stop appearing after deploys.

### What "success" looks like

- Deploy-caused disconnections drop from 30-60s to <2s
- "Disconnected and retry" bug reports during deploy windows stop
- Pod logs show clean shutdown with close frame counts
- Pod exits with code 0, not 137 (SIGKILL)

## Rollout

1. Implement on `hotfix/graceful-shutdown` branch
2. Deploy to cloud-debug — test items 1-5
3. PR to main — deploys to all prod regions
4. Monitor next deploy for clean shutdown logs

## Key Numbers

| Metric                             | Before                            | After                |
| ---------------------------------- | --------------------------------- | -------------------- |
| Deploy disconnect duration         | 30-60s                            | <2s                  |
| WebSocket close frame on deploy    | None (SIGKILL)                    | 1001 "Going Away"    |
| User-visible disruption per deploy | "Disconnected" banner, retry loop | Brief reconnect, <2s |
| Shutdown time (SIGTERM → exit)     | 30s (grace period → SIGKILL)      | <1s                  |

<!-- Test deploy: 2026-03-28T19:40:00Z -->
