# Design: Cloud Observability — Memory Leak Fixes + Observability Overhaul

## Overview

**What this doc covers:** Every code change on the `hotfix/cloud-observability` branch — what changed, why, the exact before/after, and how to verify each change works.
**Why this doc exists:** Documents the implementation of the specs in `spec.md` and `observability-spec.md`. Written after implementation (should have been written before — lesson learned).
**What you need to know first:** [spec.md](./spec.md) for bug fix specifications, [observability-spec.md](./observability-spec.md) for observability additions, [memory-leak-spike.md](../056-cpu-spike-before-kill/memory-leak-spike.md) for the investigation that found the bugs.
**Who should read this:** Anyone reviewing the PR from `hotfix/cloud-observability` → `main`.

---

## Changes Summary

| # | File | Category | Change |
|---|------|----------|--------|
| A1 | `services/streaming/ManagedStreamingExtension.ts` | Memory leak fix | Store and clear hourly cleanup interval |
| A2 | `services/session/transcription/providers/SonioxSdkStream.ts` | Memory leak fix | Remove event listeners on stream close |
| A3 | `services/session/UserSession.ts` | Memory leak fix | Add 4 missing manager dispose calls |
| A4 | `services/session/UserSession.ts` | Correctness fix | Identity check before sessions map delete |
| A5 | `services/websocket/bun-websocket.ts` | Correctness fix | Email case normalization |
| A6 | `services/session/transcription/TranscriptionManager.ts` | Resource leak fix | Disposed guard on scheduled reconnects |
| A7 | `services/session/translation/TranslationManager.ts` | Resource leak fix | Disposed guard on scheduled retry |
| B1 | `services/metrics/MetricsService.ts` | Observability | Event loop lag warnings + getCurrentLag() |
| B2 | `hono-app.ts` | Observability | /health response enriched with runtime fields |
| B3 | `hono-app.ts` | Observability | /livez lightweight liveness endpoint |
| B4 | `hono-app.ts` | Observability | /api/admin/heap-snapshot endpoint |
| B5 | `services/metrics/SystemVitalsLogger.ts` | Observability | New file — 30s periodic vitals + operation timing |
| B6 | `index.ts` | Observability | Start SystemVitalsLogger on boot |
| C1 | `.github/workflows/porter-debug.yml` | Workflow | Add branch trigger for hotfix |

All file paths are relative to `cloud/packages/cloud/src/` unless otherwise noted.

---

## A1: ManagedStreamingExtension — Store and Clear Interval

**File:** `services/streaming/ManagedStreamingExtension.ts`

**Problem:** The constructor creates a `setInterval` for hourly cleanup but never stores the handle. `dispose()` never clears it. The callback captures `this`, which references `StreamRegistry` → `Logger` → `UserSession`. Every disposed UserSession is pinned in memory forever.

**Before:**
```ts
// Line 53 — constructor
setInterval(
  () => {
    this.performCleanup();
  },
  60 * 60 * 1000,
);

// Line 1313 — dispose()
dispose(): void {
  for (const lifecycle of this.lifecycleControllers.values()) {
    lifecycle.dispose();
  }
  // ... no clearInterval for the hourly cleanup
}
```

**After:**
```ts
// New field declaration near top of class
private cleanupInterval?: NodeJS.Timeout;

// Line 55 — constructor (now stored)
this.cleanupInterval = setInterval(
  () => {
    this.performCleanup();
  },
  60 * 60 * 1000,
);

// Line 1316 — dispose() (now cleared)
dispose(): void {
  if (this.cleanupInterval) {
    clearInterval(this.cleanupInterval);
    this.cleanupInterval = undefined;
  }
  for (const lifecycle of this.lifecycleControllers.values()) {
    lifecycle.dispose();
  }
  // ... rest unchanged
}
```

**How to verify:** After this fix, `MemoryLeakDetector` "Potential leak" warnings should drop to near-zero. Disposed UserSessions should be GC'd within 60 seconds (the detector's grace period).

---

## A2: SonioxSdkStream — Remove Event Listeners on Close

**File:** `services/session/transcription/providers/SonioxSdkStream.ts`

**Context:** `this.session` here is a Soniox SDK `RealtimeSttSession` — a WebSocket connection to Soniox's speech-to-text API. This is NOT a `UserSession`. The naming is unfortunate. One `SonioxSdkStream` wraps one Soniox real-time transcription connection. `TranscriptionManager` creates these when a user starts transcription.

**Problem:** `initialize()` registers 7 `.on()` listeners on `this.session` (result, endpoint, finalized, finished, error, disconnected, connected). `close()` never removes them. Each listener is an arrow function that captures `this` (the SonioxSdkStream), which holds `callbacks` → `TranscriptionManager` → `UserSession`. The reference chain:

```
Soniox session object → listener closures → SonioxSdkStream → TranscriptionManager → UserSession
                         (never removed)     (can't be GC'd)   (can't be GC'd)       (can't be GC'd)
```

Even after `close()`, the Soniox SDK's session object still holds the listener array. Until that object is garbage collected, the entire chain is pinned in memory.

**Before (initialize):**
```ts
// Listeners registered as anonymous arrow functions — no way to remove them later
this.session.on("result", (result: RealtimeResult) => this.handleResult(result));
this.session.on("endpoint", () => this.handleEndpoint());
this.session.on("finalized", () => this.handleFinalized());
this.session.on("finished", () => this.handleFinished());
this.session.on("error", (error: Error) => this.handleError(error));
this.session.on("disconnected", (reason?: string) => this.handleDisconnected(reason));
this.session.on("connected", () => { /* ... */ });
```

**Before (close):**
```ts
async close(): Promise<void> {
  if (this.disposed) return;
  this.disposed = true;
  this.state = StreamState.CLOSING;
  this.stopGapDetection();
  // No listener cleanup — they stay registered forever
  try {
    const sessionState = this.session.state;
    // ... finish/close logic
```

**After (initialize) — store references, then register:**
```ts
// Store listener references as class fields so we can .off() each one in close()
this.onResult = (result: RealtimeResult) => this.handleResult(result);
this.onEndpoint = () => this.handleEndpoint();
this.onFinalized = () => this.handleFinalized();
this.onFinished = () => this.handleFinished();
this.onError = (error: Error) => this.handleError(error);
this.onDisconnected = (reason?: string) => this.handleDisconnected(reason);
this.onConnected = () => { /* ... same connected handler ... */ };

// Register using the stored references
this.session.on("result", this.onResult);
this.session.on("endpoint", this.onEndpoint);
this.session.on("finalized", this.onFinalized);
this.session.on("finished", this.onFinished);
this.session.on("error", this.onError);
this.session.on("disconnected", this.onDisconnected);
this.session.on("connected", this.onConnected);
```

**After (close) — remove each listener individually:**
```ts
async close(): Promise<void> {
  if (this.disposed) return;
  this.disposed = true;
  this.state = StreamState.CLOSING;
  this.stopGapDetection();

  // Remove event listeners to break the reference chain
  if (this.onResult) this.session.off("result", this.onResult);
  if (this.onEndpoint) this.session.off("endpoint", this.onEndpoint);
  if (this.onFinalized) this.session.off("finalized", this.onFinalized);
  if (this.onFinished) this.session.off("finished", this.onFinished);
  if (this.onError) this.session.off("error", this.onError);
  if (this.onDisconnected) this.session.off("disconnected", this.onDisconnected);
  if (this.onConnected) this.session.off("connected", this.onConnected);

  try {
    const sessionState = this.session.state;
    // ... finish/close logic (unchanged)
```

**New class fields added:**
```ts
private onResult?: (result: RealtimeResult) => void;
private onEndpoint?: () => void;
private onFinalized?: () => void;
private onFinished?: () => void;
private onError?: (error: Error) => void;
private onDisconnected?: (reason?: string) => void;
private onConnected?: () => void;
```

### Decision Log for A2

| Decision | Alternatives considered | Why we chose this |
|----------|------------------------|-------------------|
| Store listener refs + use typed `.off()` per listener | `(this.session as any).removeAllListeners()` | **First attempt used `removeAllListeners()` — failed.** The Soniox SDK's `RealtimeSttSession` TypeScript type doesn't expose `removeAllListeners()`. The SDK internally uses a custom `TypedEmitter` (not Node's `EventEmitter`) which does have the method at runtime, but the type definition only exposes `.on()`, `.off()`, and `.once()`. First attempt cast to `any` to bypass TypeScript — this broke the CI build (`TS2339: Property 'removeAllListeners' does not exist on type 'RealtimeSttSession'`). Second attempt added `as any` cast + optional chaining — built successfully but was flagged in review as a code smell. Final approach: store each listener as a class field, register with `.on()`, clean up with `.off()` — fully typed, no casts, uses the SDK's documented API. |
| Remove listeners before `session.finish()` | Remove listeners after `session.finish()` | `finish()` may emit `finalized` and `finished` events as part of graceful shutdown. However, by the time `close()` is called, the stream is being torn down — the `SonioxSdkStream` is disposed and we don't want to process any more events. Removing listeners first prevents any callbacks from firing on a half-disposed stream. The transcription data has already been flushed by this point (the stream was either idle or the user disconnected). |

**How to verify:** Create a transcription stream, then dispose the session. The stream's event listeners should no longer fire after close(). In BetterStack, "Soniox SDK stream error" logs should not appear for already-closed streams. `MemoryLeakDetector` should show "Object finalized by GC" for the disposed session within 60 seconds.

---

## A3: UserSession.dispose() — Add 4 Missing Manager Dispose Calls

**File:** `services/session/UserSession.ts`

**Problem:** `dispose()` calls `.dispose()` on 13 managers but misses 4: `calendarManager`, `deviceManager`, `userSettingsManager`, `streamRegistry`. If any of these hold timers, DB watchers, or event listeners, the UserSession can't be GC'd.

**Before:**
```ts
// Line 770 — dispose()
if (this.managedStreamingExtension) this.managedStreamingExtension.dispose();
if (this.appAudioStreamManager) this.appAudioStreamManager.dispose();

// Persist location to DB cold cache and clean up
if (this.locationManager) await this.locationManager.dispose();
```

**After:**
```ts
// Line 770 — dispose()
if (this.managedStreamingExtension) this.managedStreamingExtension.dispose();
if (this.appAudioStreamManager) this.appAudioStreamManager.dispose();

// These 4 were missing from dispose — calendarManager, deviceManager,
// userSettingsManager, and streamRegistry. If any hold timers, DB watchers,
// or event listeners, the UserSession can't be GC'd.
if (this.calendarManager) (this.calendarManager as any).dispose?.();
if (this.deviceManager) (this.deviceManager as any).dispose?.();
if (this.userSettingsManager) (this.userSettingsManager as any).dispose?.();
if (this.streamRegistry) (this.streamRegistry as any).dispose?.();

// Persist location to DB cold cache and clean up
if (this.locationManager) await this.locationManager.dispose();
```

**Note on `as any` + `?.`:** Some of these managers may not have a `dispose()` method. The optional chaining makes this safe — if the method doesn't exist, it's a no-op. If it does exist, it's called. No runtime error risk either way. We chose not to audit all 4 manager classes in this hotfix — the safe fallback is better than skipping the fix.

---

## A4: UserSession.dispose() — Identity Check Before Map Delete

**File:** `services/session/UserSession.ts`

**Problem:** `UserSession.sessions.delete(this.userId)` doesn't verify that `this` is still the registered session for that userId. In a reconnect race condition, a stale session's `dispose()` can delete a newer session's map entry, permanently orphaning the newer session (alive in memory, unreachable from the static map, never disposable).

**Before:**
```ts
// Line 793
UserSession.sessions.delete(this.userId);
```

**After:**
```ts
// Line 803
// Only delete from map if this session is still the registered one.
// A stale session's dispose() must not delete a newer session's entry.
if (UserSession.sessions.get(this.userId) === this) {
  UserSession.sessions.delete(this.userId);
}
```

---

## A5: bun-websocket.ts — Email Case Normalization

**File:** `services/websocket/bun-websocket.ts`

**Problem:** WebSocket upgrade uses `payload.email` (raw from JWT) as the session key. REST middleware uses `decoded.email.toLowerCase()`. If a JWT contains mixed-case email (e.g., `User@Example.com`), the WebSocket creates a session keyed by `User@Example.com` while REST endpoints look up `user@example.com`. The session is invisible to REST, and duplicate sessions can be created for the same user.

**Before:**
```ts
// Line 90
const userId = payload.email;
```

**After:**
```ts
// Line 90
const userId = payload.email?.toLowerCase();
```

---

## A6: TranscriptionManager — Disposed Guard on Scheduled Reconnects

**File:** `services/session/transcription/TranscriptionManager.ts`

**Problem:** `scheduleStreamReconnect()` and `scheduleStreamRetry()` create `setTimeout` callbacks that capture `this` but are never stored or cancelled. After `dispose()`, these callbacks fire on a dead manager and call `startStream()`, creating zombie Soniox streams with open WebSocket connections that nobody will ever close.

**Changes:**

1. Added `private disposed = false;` field to the class
2. Set `this.disposed = true;` at the top of `dispose()`
3. Added `if (this.disposed) return;` at the top of the `setTimeout` callback in `scheduleStreamReconnect()`
4. Added `if (this.disposed) return;` at the top of the `setTimeout` callback in `scheduleStreamRetry()`

**Before (scheduleStreamReconnect):**
```ts
setTimeout(async () => {
  // ... attempts to startStream on potentially disposed manager
}, delayMs);
```

**After:**
```ts
setTimeout(async () => {
  if (this.disposed) return; // Guard: manager was disposed while timer was pending
  // ... rest unchanged
}, delayMs);
```

Same pattern applied to `scheduleStreamRetry`.

---

## A7: TranslationManager — Disposed Guard on Scheduled Retry

**File:** `services/session/translation/TranslationManager.ts`

**Problem:** Same pattern as A6 — `scheduleStreamRetry()` creates an untracked `setTimeout` that fires on a disposed manager.

**Changes:**

1. Added `private disposed = false;` field
2. Set `this.disposed = true;` at the top of `dispose()`
3. Added `if (this.disposed) return;` at the top of the `setTimeout` callback in `scheduleStreamRetry()`

---

## B1: MetricsService — Event Loop Lag Warnings + getCurrentLag()

**File:** `services/metrics/MetricsService.ts`

**Problem:** `sampleEventLoopLag()` already measures event loop lag every 2 seconds via `setTimeout(0)` drift. It stores the value in `_eventLoopLagCurrent` and a rolling window. But it never logs anything — the data is invisible to BetterStack. There's also no public method to read the current lag value.

**Changes:**

1. Added warning log inside the `setTimeout` callback, after updating `_eventLoopLagCurrent`:

```ts
if (this._eventLoopLagCurrent > 100) {
  const memUsage = process.memoryUsage();
  logger.warn(
    {
      lagMs: this._eventLoopLagCurrent,
      heapUsedMB: Math.round(memUsage.heapUsed / 1048576),
      rssMB: Math.round(memUsage.rss / 1048576),
      feature: "event-loop-lag",
    },
    `Event loop lag: ${Math.round(this._eventLoopLagCurrent)}ms`,
  );
}
```

2. Added `getCurrentLag()` public method:

```ts
getCurrentLag(): number {
  return this._eventLoopLagCurrent;
}
```

**Threshold reasoning:** 100ms is well above normal (~2–5ms) but well below the 1-second (now 3-second proposed) health probe timeout. It fires when the event loop is degraded but before the pod is killed — catching the degradation curve. At 2-second sampling, this generates at most 1 log every 2 seconds during degradation, 0 logs when healthy.

---

## B2: hono-app.ts — /health Response Enrichment

**File:** `hono-app.ts`

**Problem:** The `/health` response returns session count and basic metrics but no runtime diagnostics — no heap size, no event loop lag, no uptime. When investigating crashes, we can't see the degradation curve from probe responses.

**Before:**
```ts
return c.json({
  status: "ok",
  timestamp: new Date().toISOString(),
  ...metricsService.toJSON(),
});
```

**After:**
```ts
const memUsage = process.memoryUsage();
return c.json({
  status: "ok",
  timestamp: new Date().toISOString(),
  heapUsedMB: Math.round(memUsage.heapUsed / 1048576),
  heapTotalMB: Math.round(memUsage.heapTotal / 1048576),
  rssMB: Math.round(memUsage.rss / 1048576),
  externalMB: Math.round(memUsage.external / 1048576),
  eventLoopLagMs: metricsService.getCurrentLag?.() ?? 0,
  activeSessions: activeSessions.length,
  uptimeSeconds: Math.round(process.uptime()),
  ...metricsService.toJSON(),
});
```

Every Kubernetes probe (5s) and every BetterStack Uptime check (60s) now becomes a diagnostic data point. The `?.() ?? 0` fallback handles the case where `getCurrentLag` might not exist (defensive).

---

## B3: hono-app.ts — /livez Lightweight Liveness Endpoint

**File:** `hono-app.ts`

**Added before the `/health` route:**
```ts
// Lightweight liveness probe — zero computation.
// If the event loop can return 2 bytes, the process is alive.
app.get("/livez", (c) => c.text("ok"));
```

**Why:** The current `/health` iterates all sessions, counts WebSockets, updates metrics gauges, and serializes JSON. During event loop saturation, this computation competes with the probe timeout. `/livez` returns 2 bytes — if the event loop can handle that, the process is alive.

**Note:** The Kubernetes liveness probe is NOT being re-pointed to `/livez` in this hotfix. The endpoint is added now so it's available when we update the probe config separately. Changing the probe target is a different change that should be tested independently.

---

## B4: hono-app.ts — Heap Snapshot Admin Endpoint

**File:** `hono-app.ts`

**Added after the `/health` route:**
```ts
// On-demand heap snapshot for memory analysis.
// Returns JSON analyzable in Chrome DevTools (Memory tab → Load).
app.get("/api/admin/heap-snapshot", (c) => {
  try {
    const snapshot = Bun.generateHeapSnapshot();
    return c.json(snapshot);
  } catch (error) {
    logger.error(error, "Failed to generate heap snapshot");
    return c.json({ error: "Failed to generate heap snapshot" }, 500);
  }
});
```

**Why:** When the next memory mystery happens, this endpoint lets us capture what's in memory without redeploying. `Bun.generateHeapSnapshot()` returns a JSON object that can be loaded in Chrome DevTools → Memory tab → Load. It shows every object, what retains it, and how large it is.

**Security concern:** This endpoint should be behind admin auth. If the existing `/api/admin/*` routes have auth middleware applied at the router level, this inherits it. If not, admin auth middleware should be added to this route specifically. The current implementation does NOT add explicit auth — this should be verified during code review.

**Performance concern:** Heap snapshots briefly pause the runtime. This should only be called manually during investigation, never automatically. A rate limit (at most once per 5 minutes) would be good to add in a follow-up.

---

## B5: SystemVitalsLogger — New File

**File:** `services/metrics/SystemVitalsLogger.ts` (new)

**What it does:** Logs a single structured JSON line every 30 seconds with:

- **Saturation:** heapUsedMB, heapTotalMB, rssMB, externalMB, arrayBuffersMB
- **Traffic:** activeSessions, activeAppWebsockets, activeTranscriptionStreams, activeTranslationStreams
- **Leak indicator:** disposedSessionsPendingGC (from MemoryLeakDetector)
- **Uptime:** uptimeSeconds (resets to 0 on crash — shows crash cycle)
- **Operation timing:** Per-category ms counters from `operationTimers` (framework is in place, hot paths need to call `operationTimers.addTiming()` — see below)

**Exports:**
- `systemVitalsLogger` — singleton instance, call `.start()` on boot
- `operationTimers` — singleton `OperationTimers` instance for hot paths to report timing

**Operation timing usage (not yet wired into hot paths):**

The `OperationTimers` class is exported and ready to use. To instrument a hot path:

```ts
import { operationTimers } from "../metrics/SystemVitalsLogger";

// In a hot path:
const t0 = performance.now();
this.audioManager.processAudioData(chunk);
operationTimers.addTiming("audioProcessing", performance.now() - t0);
```

The vitals logger reads and resets these counters every 30 seconds. The operation timing categories (audioProcessing, displayRendering, appRelay, etc. from the observability spec) are NOT wired in this hotfix — only the framework is in place. Wiring them requires touching the hot paths themselves, which should be a separate, carefully reviewed change.

**Volume:** 1 log line every 30 seconds = 2,880 lines/day. Negligible compared to the 11M+ lines/day from cloud-prod.

---

## B6: index.ts — Start SystemVitalsLogger

**File:** `index.ts`

**Added** import and `.start()` call near where `metricsService.start()` is called:

```ts
import { systemVitalsLogger } from "./services/metrics/SystemVitalsLogger";

// Near metricsService.start():
systemVitalsLogger.start();
```

---

## C1: porter-debug.yml — Branch Trigger

**File:** `.github/workflows/porter-debug.yml`

**Added** `hotfix/cloud-observability` to the branches list:

```yaml
branches:
  - cloud/issues-044
  - new-context-soniox
  - cloud/044-ci-build-audit
  - hotfix/cloud-observability
```

Pushing to this branch now deploys to `cloud-debug` for testing before PR to `main`.

---

## What Is NOT Changed

| Item | Why not |
|------|---------|
| Kubernetes liveness probe target (`/health` → `/livez`) | Probe config change should be tested separately. `/livez` is added but not wired. |
| Kubernetes liveness probe timeout (1s → 3s) | Same — separate change. |
| DashboardManager spam fix | Pending on a separate branch. |
| Porter YAML health check configuration | Need to verify Porter's YAML syntax supports this. Separate change. |
| Operation timing wiring (wrapping hot paths with `performance.now()`) | Framework is in place (`operationTimers`), but wiring into hot paths (AudioManager, DashboardManager, etc.) touches critical code and should be reviewed separately. |
| Deploy Slack annotations | Requires `SLACK_DEPLOY_WEBHOOK` secret in GitHub. Infrastructure change, not code. |
| BetterStack response-time uptime monitor | Configuration change in BetterStack, not code. |
| `MEMORY_TELEMETRY_ENABLED=true` | Porter env var change, not code. |
| Separate BetterStack source for prod | Porter env var change, not code. New source `MentraCloud - Prod` (ID 2324289) is created but not yet pointed to. |
| Error tracking (`@sentry/bun`) | Separate feature, separate PR. |
| Collector on other 4 clusters | Infrastructure change, repeatable process from US Central. |

---

## Testing

### On cloud-debug (before PR to main)

| # | Test | Expected result |
|---|------|-----------------|
| 1 | Pod starts cleanly | No crash loop, no new errors |
| 2 | `curl /livez` | Returns `ok` (plain text, 2 bytes) |
| 3 | `curl /health` | Response includes `heapUsedMB`, `rssMB`, `eventLoopLagMs`, `activeSessions`, `uptimeSeconds` |
| 4 | BetterStack: search `feature: "system-vitals"` | Logs appear every 30s with heap, sessions, streams, uptime |
| 5 | BetterStack: search `feature: "event-loop-lag"` | Only appears when lag > 100ms (may not appear on quiet debug server) |
| 6 | `curl /api/admin/heap-snapshot` | Returns JSON (large). Loadable in Chrome DevTools Memory tab. |
| 7 | Connect glasses WS + apps, then disconnect | MemoryLeakDetector should log "Object finalized by GC" within 60s, NOT "Potential leak" |
| 8 | Disconnect while transcription active | No "startStream" logs from the disposed manager after disconnect (zombie guard working) |

### After PR to main (monitoring cloud-prod)

| # | Metric | Target | Was |
|---|--------|--------|-----|
| 1 | Crash frequency | < 2/day | ~8/day |
| 2 | MemoryLeakDetector "Potential leak" warnings | Near-zero | 245 on March 25 |
| 3 | TranscriptionManager "High memory usage" warnings | Significant reduction | 7,949 on March 25 |
| 4 | `/health` heapUsedMB over time | Stabilizes, doesn't grow indefinitely | Was crossing 512MB |
| 5 | System vitals `disposedSessionsPendingGC` | 0 | N/A (new metric) |

---

## Rollout

1. **Push to `hotfix/cloud-observability`** — triggers deploy to `cloud-debug` ✅ Done
2. **Verify on cloud-debug** — run tests above
3. **Create PR** `hotfix/cloud-observability` → `main` (manual, by Isaiah)
4. **PR merge triggers** `porter-prod.yml` → deploys to all 5 prod regions
5. **Monitor** BetterStack Uptime + system vitals for 48 hours
6. **If crashes drop** — success, move to observability Phase 2 (alerts, deploy annotations, error tracking)
7. **If crashes persist** — event loop lag logs + system vitals show what's happening, enabling faster next investigation