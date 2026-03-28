# Spec: MongoDB Latency — Event Loop Gap Detector, Cumulative Metrics, App Cache

## Overview

**What this doc covers:** Three changes to prove MongoDB is the crash cause and fix the worst of it — an event loop gap detector that catches blocking events in real-time, cumulative MongoDB blocking metrics in system vitals, and an in-memory cache for the `apps` collection that eliminates 18 hot-path DB round-trips per session.
**Why this doc exists:** The 062 spike found that France's event loop is blocked by MongoDB for 9% of total time (162s out of 1800s). 18 hot-path DB calls hit the network on every session connect, app start, and subscription update. GC is confirmed NOT the primary cause (54ms probes, 0MB freed). But we haven't proven the final link: that MongoDB blocking is what causes the health check to fail and the pod to die. The first two changes prove it. The third fixes it.
**What you need to know first:** [062 spike](./spike.md) for full audit and data, [061 spec](../061-crash-investigation/spec.md) for existing diagnostics.
**Who should read this:** Anyone reviewing the PR.

## The Problem in 30 Seconds

Every `App.findOne({ packageName })` on a hot path blocks the event loop for 80ms (US Central) to 370ms (East Asia) of pure network round-trip time. The query is indexed and executes in 0ms on the server — it's the network that's slow. With 65 sessions, each triggering multiple app lookups during connect/reconnect, the cumulative blocking can reach seconds per minute. When it coincides with a health check, the probe times out, and after 15 consecutive failures (75 seconds), Kubernetes kills the pod.

We have the aggregate number (9% blocking on France) but not the per-second correlation. This spec adds the instrumentation to get that correlation, and the cache to eliminate the problem.

## Spec

### B1. Event Loop Gap Detector

**File:** `packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

**What:** A `setInterval(1000)` that records `Date.now()` each tick. If the interval between ticks exceeds 2000ms (double the expected 1000ms), something blocked the event loop for the excess duration. Log the gap.

**Why:** This is the missing link. Right now we know "MongoDB query took 520ms" and "the pod crashed at 16:08." We DON'T know "the event loop was blocked for 520ms at 16:08:03 and the health check arrived during that gap." The gap detector provides that.

**Implementation:**

```typescript
private gapDetectorInterval?: NodeJS.Timeout;
private lastGapTick: number = Date.now();

private startGapDetector(): void {
  this.lastGapTick = Date.now();
  this.gapDetectorInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = now - this.lastGapTick;
    this.lastGapTick = now;

    // If more than 2x the expected 1s interval, the event loop was blocked
    if (elapsed > 2000) {
      const gapMs = elapsed - 1000; // subtract the expected 1s
      logger.warn(
        {
          feature: "event-loop-gap",
          gapMs,
          expectedMs: 1000,
          actualMs: elapsed,
          rssMB: Math.round(process.memoryUsage().rss / 1048576),
          activeSessions: UserSession.getAllSessions().length,
        },
        `Event loop gap: ${gapMs}ms (expected 1000ms, actual ${elapsed}ms)`,
      );
    }
  }, 1000);
}
```

**Call in `start()`**, store handle, clear in `stop()`. Same lifecycle pattern as the GC probe.

**Log format:**

```json
{
  "feature": "event-loop-gap",
  "level": "warn",
  "gapMs": 520,
  "expectedMs": 1000,
  "actualMs": 1520,
  "rssMB": 612,
  "activeSessions": 22
}
```

**How to use:** Query BetterStack for `feature: "event-loop-gap"` in the 5 minutes before a crash. If gaps appear and their timestamps match slow-query timestamps, MongoDB caused the gap. If gaps appear but no slow queries are nearby, something else caused them.

**Volume:** Only logs when the gap exceeds 1 second. Under normal operation: 0 logs. During degradation: a few per minute at most.

**Performance impact:** One `Date.now()` call per second. Negligible.

### B2. Cumulative MongoDB Blocking Metric

**File:** `packages/cloud/src/connections/mongodb.connection.ts` (extend existing slow-query plugin)
**File:** `packages/cloud/src/services/metrics/SystemVitalsLogger.ts` (consume the metric)

**What:** The slow-query plugin already times every query exceeding the threshold. Extend it to accumulate three counters that reset every 30 seconds when the vitals logger reads them:

- `mongoQueryCount` — number of queries exceeding threshold in this window
- `mongoTotalBlockingMs` — sum of all slow query durations in this window
- `mongoMaxQueryMs` — slowest single query in this window

**Implementation in mongodb.connection.ts:**

```typescript
// Exported accumulator — SystemVitalsLogger reads and resets every 30s
class MongoQueryStats {
  count = 0
  totalMs = 0
  maxMs = 0

  record(durationMs: number): void {
    this.count++
    this.totalMs += durationMs
    if (durationMs > this.maxMs) this.maxMs = durationMs
  }

  getAndReset(): {count: number; totalMs: number; maxMs: number} {
    const snapshot = {count: this.count, totalMs: this.totalMs, maxMs: this.maxMs}
    this.count = 0
    this.totalMs = 0
    this.maxMs = 0
    return snapshot
  }
}

export const mongoQueryStats = new MongoQueryStats()
```

In the existing `slowQueryPlugin` post hook, after logging the warning, add:

```typescript
mongoQueryStats.record(durationMs)
```

**Note:** Record ALL queries that exceed the threshold, not just the ones we log. The logging has its own threshold (`MONGOOSE_SLOW_QUERY_MS`), but the stats should use the same threshold for consistency.

**Implementation in SystemVitalsLogger.ts:**

Import `mongoQueryStats` and add to the existing vitals log:

```typescript
import { mongoQueryStats } from "../../connections/mongodb.connection";

// Inside logVitals(), before the logger.info call:
const mongoStats = mongoQueryStats.getAndReset();

// Add to the existing logger.info object:
{
  // ... existing fields ...
  mongoQueryCount: mongoStats.count,
  mongoTotalBlockingMs: Math.round(mongoStats.totalMs),
  mongoMaxQueryMs: Math.round(mongoStats.maxMs * 10) / 10,
}
```

**Additional fields in existing `system-vitals` log:**

```json
{
  "feature": "system-vitals",
  "mongoQueryCount": 46,
  "mongoTotalBlockingMs": 5428,
  "mongoMaxQueryMs": 521.3
}
```

**How to use:** If `mongoTotalBlockingMs` is 5,000ms in a 30-second window, MongoDB blocked the event loop for 17% of the time. If this number is consistently high in the minutes before a crash and drops after a restart (reconnect storm settles), MongoDB is the cause.

**Performance impact:** One integer addition per query. Negligible.

### B3. In-Memory App Cache

**File:** `packages/cloud/src/services/core/app-cache.service.ts` (new)

**What:** A singleton cache that loads all `App` documents at boot and serves `getByPackageName()` from memory. Refreshes every 30 seconds. All 18+ hot-path `App.findOne({ packageName })` calls switch to use the cache instead of hitting MongoDB.

**Why:** The `apps` collection is 1,314 documents, 2 MB total. It changes rarely (new apps are published maybe once a day). Every hot-path query against it pays 80-370ms of network RTT for data that's effectively static. Caching it in memory eliminates all of that RTT.

**Implementation:**

```typescript
import {App} from "../../models/app.model"
import type {AppI} from "../../models/app.model"
import {logger as rootLogger} from "../logging/pino-logger"

const logger = rootLogger.child({service: "AppCache"})

const REFRESH_INTERVAL_MS = 30_000 // 30 seconds

class AppCacheService {
  private cache: Map<string, AppI> = new Map()
  private allApps: AppI[] = []
  private refreshInterval?: NodeJS.Timeout
  private loaded = false
  private lastRefresh: number = 0

  async initialize(): Promise<void> {
    await this.refresh()
    this.refreshInterval = setInterval(() => {
      this.refresh().catch((err) => logger.error(err, "App cache refresh failed"))
    }, REFRESH_INTERVAL_MS)
    logger.info({count: this.cache.size, refreshMs: REFRESH_INTERVAL_MS}, "App cache initialized")
  }

  async refresh(): Promise<void> {
    const t0 = performance.now()
    const apps = await App.find({}).lean<AppI[]>()
    const elapsed = performance.now() - t0

    this.cache.clear()
    for (const app of apps) {
      if (app.packageName) {
        this.cache.set(app.packageName, app)
      }
    }
    this.allApps = apps
    this.loaded = true
    this.lastRefresh = Date.now()

    logger.info(
      {count: apps.length, refreshMs: Math.round(elapsed), feature: "app-cache"},
      `App cache refreshed: ${apps.length} apps in ${Math.round(elapsed)}ms`,
    )
  }

  getByPackageName(packageName: string): AppI | null {
    if (!this.loaded) {
      logger.warn("App cache not loaded yet — falling back to DB")
      return null // caller should fall back to DB query
    }
    return this.cache.get(packageName) ?? null
  }

  getAll(): AppI[] {
    return this.allApps
  }

  getByPackageNames(packageNames: string[]): AppI[] {
    return packageNames.map((name) => this.cache.get(name)).filter((app): app is AppI => app !== undefined)
  }

  // Force refresh after a write (app created/updated/deleted)
  async invalidate(): Promise<void> {
    await this.refresh()
  }

  isLoaded(): boolean {
    return this.loaded
  }

  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = undefined
    }
  }
}

export const appCache = new AppCacheService()
```

**Initialization:** Call `appCache.initialize()` in `index.ts` after MongoDB connects, before the server starts accepting connections. This ensures the cache is warm before any sessions connect.

**Hot-path migration pattern:** Each call site changes from:

```typescript
// Before — blocks event loop for 80-370ms
const app = await App.findOne({packageName})
```

to:

```typescript
// After — instant memory lookup, 0ms
const app = appCache.getByPackageName(packageName)
if (!app) {
  // Cache miss (shouldn't happen for valid apps). Fall back to DB.
  const dbApp = await App.findOne({packageName}).lean()
  // Optionally trigger a cache refresh
}
```

**Call sites to migrate (hot paths only in this spec):**

| #   | File                          | Current Call                                | Notes                                       |
| --- | ----------------------------- | ------------------------------------------- | ------------------------------------------- |
| 1   | `AppManager.ts:L612`          | `App.find()`                                | Change to `appCache.getByPackageNames(...)` |
| 2   | `SubscriptionManager.ts:L269` | `App.findOne({ packageName })`              | Change to `appCache.getByPackageName(...)`  |
| 3   | `app-message-handler.ts:L672` | `App.findOne({ packageName })`              | Change to `appCache.getByPackageName(...)`  |
| 4   | `sdk.auth.service.ts:L108`    | `App.findOne({ packageName }).lean()`       | Change to `appCache.getByPackageName(...)`  |
| 5   | `system-app.api.ts:L143`      | `App.find({ packageName: { $in: [...] } })` | Change to `appCache.getByPackageNames(...)` |
| 6   | `system-app.api.ts:L364`      | `App.find()` + filter                       | Change to `appCache.getAll()` + filter      |
| 7   | `system-app.api.ts:L411`      | `App.findOne({ packageName })`              | Change to `appCache.getByPackageName(...)`  |
| 8   | `system-app.api.ts:L457`      | `App.findOne({ packageName })`              | Change to `appCache.getByPackageName(...)`  |
| 9   | `system-app.api.ts:L561`      | `App.findOne({ packageName })`              | Change to `appCache.getByPackageName(...)`  |

**Cold-path call sites (admin, developer console, store):** Leave as-is for now. They're infrequent and don't contribute to crashes. Migrate in a follow-up if desired.

**Write-through invalidation:** When an app is created, updated, or deleted, call `appCache.invalidate()` after the DB write. This ensures the LOCAL pod's cache reflects the change immediately.

**Critical: write-through only works on the pod that handled the write.** We have 5 pods across 5 regions sharing the same MongoDB. If a developer updates their app's `publicUrl` via the dev console (which hits US Central), US Central's cache invalidates immediately. But France, East Asia, US West, and US East still have the old URL until their next refresh.

**Refresh interval: 30 seconds (not 5 minutes).** The collection is 2MB. One `find({}).lean()` is ~100ms from US Central, ~700ms from East Asia. Every 30 seconds is acceptable — the query is async and doesn't block the event loop meaningfully. Worst-case staleness = 30 seconds across all pods.

**Write paths that MUST call `invalidate()` (16 total across 5 files):**

| File                                        | Operation          | Critical field changed                                            |
| ------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| `console.apps.service.ts:updateApp`         | `findOneAndUpdate` | 🔴 `publicUrl`, `name`, `tools`, `settings` — app breaks if stale |
| `console.apps.service.ts:createApp`         | `App.create()`     | New app invisible until refresh                                   |
| `console.apps.service.ts:deleteApp`         | `App.deleteOne()`  | Deleted app still callable until refresh                          |
| `console.apps.service.ts:publishApp`        | `.save()`          | Status change                                                     |
| `console.apps.service.ts:regenerateApiKey`  | `.save()`          | 🔴 `hashedApiKey` — app can't authenticate if stale               |
| `console.apps.service.ts:updatePermissions` | `.save()`          | 🔴 `permissions` — security issue if stale                        |
| `app.service.ts:createApp`                  | `App.create()`     | New app invisible                                                 |
| `app.service.ts:updateApp`                  | `findOneAndUpdate` | 🔴 Same as console                                                |
| `app.service.ts:publishApp`                 | `findOneAndUpdate` | Status change                                                     |
| `app.service.ts:deleteApp`                  | `findOneAndDelete` | Deleted app still cached                                          |
| `app.service.ts:regenerateApiKey`           | `findOneAndUpdate` | 🔴 `hashedApiKey`                                                 |
| `developer.service.ts:createApp`            | `App.create()`     | New app invisible                                                 |
| `developer.service.ts:regenerateApiKey`     | `findOneAndUpdate` | 🔴 `hashedApiKey`                                                 |
| `developer.routes.ts:publishApp`            | `findOneAndUpdate` | Status change                                                     |
| `permissions.routes.ts:updatePermissions`   | `findOneAndUpdate` | 🔴 `permissions`                                                  |
| `admin.routes.ts:approveApp/rejectApp`      | `.save()`          | Status change                                                     |

### Cache staleness edge cases — what breaks and for how long

| Scenario                               | What breaks                                                                           | Max staleness          | Severity                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Developer updates `publicUrl`          | Webhook calls go to old URL. App appears broken to ALL users on OTHER regions.        | 30s (refresh interval) | 🔴 High — but 30s is acceptable. Current behavior without cache is instant because there's no cache to be stale. |
| Developer regenerates API key          | App can't authenticate on pods with old cached hash. Every SDK API call fails.        | 30s                    | 🔴 High — but key regeneration is rare (manual action) and 30s recovery is acceptable.                           |
| Developer updates `permissions`        | Camera/mic permission checks use stale data. Could grant revoked permissions for 30s. | 30s                    | 🔴 High — but permissions changes are rare and 30s window is small.                                              |
| New app created                        | App invisible to glasses users on other regions for up to 30s.                        | 30s                    | 🟡 Medium — acceptable.                                                                                          |
| App deleted                            | Deleted app still appears available, webhook calls go to dead URL.                    | 30s                    | 🟡 Medium — acceptable.                                                                                          |
| App tools/settings updated             | Old tool schemas served for up to 30s.                                                | 30s                    | 🟡 Medium — acceptable.                                                                                          |
| Direct DB edit (migration, manual fix) | Cache doesn't know about it. Only refreshes on timer.                                 | 30s                    | 🟢 Low — rare, and 30s is fine.                                                                                  |

**Key insight:** Every one of these staleness scenarios is bounded to 30 seconds. Without the cache, the same operations are instant — but the event loop pays 80-370ms per query, thousands of times per minute. The tradeoff is 30 seconds of possible staleness vs 9%+ event loop blocking.

**Refresh failure detection:** The cache logs a warning if `Date.now() - lastRefresh > 90_000` (3 missed refresh cycles). This catches cases where the refresh query itself fails (DB unreachable, timeout).

**Memory cost:** 1,314 docs × ~1.5 KB avg = ~2 MB. Negligible compared to the 200-600 MB RSS baseline.

### Future: MongoDB Atlas Read Replicas (eliminates the problem at the DB level)

The app cache solves the `apps` collection specifically. But `User`, `UserSettings`, and `Organization` queries also pay the same RTT penalty. The long-term fix is Atlas read replicas in each region — every pod reads from a local replica, writes go to the primary.

**What Atlas provides:**

- Read-only replica set members in additional regions
- Automatic replication from the primary via oplog
- `readPreference=nearest` in the connection string routes reads to the closest replica
- Read replicas don't participate in elections — they're purely for read performance

**Steps to enable (Atlas UI):**

1. Go to Atlas Dashboard → your cluster → **Configuration** tab
2. Click **"Multi-Cloud, Multi-Region & Workload Isolation"** toggle → On
3. Under **"Read-only Replicas"**, click **"+ Add a read-only node"**
4. Select the cloud provider (Azure, since Porter uses AKS) and region:
   - `westus2` or `westus3` — for US West pod
   - `eastus2` — for US East pod
   - `francecentral` — for France pod
   - `eastasia` or `southeastasia` — for East Asia pod
5. Select instance tier (can be smaller than primary — M10 is fine for read replicas)
6. Click **"Review Changes"** → **"Apply Changes"**
7. Atlas provisions the replicas (takes 10-30 minutes)

**Application change (one line in Mongoose connect):**

```typescript
// Before — all reads go to primary (US East)
await mongoose.connect(MONGO_URL + "/prod")

// After — reads go to nearest replica
await mongoose.connect(MONGO_URL + "/prod", {
  readPreference: "nearest",
})
```

**Cost consideration:** Each read replica is a separate Atlas node billed at its tier. M10 is ~$57/month per node. 4 replicas = ~$228/month. Compare with the engineering time spent on caching and crash investigation.

**Replication lag:** Typically <1 second for Atlas within the same cloud provider. Writes to the primary in US East are replicated to all read replicas nearly instantly. Much better than a 30-second cache refresh.

**When to do this:** After the app cache ships and we've proven MongoDB RTT is a crash contributor. If crashes stop with just the app cache, read replicas can wait. If other collections (`User`, `UserSettings`) also show high blocking, read replicas become the priority.

**This is NOT in scope for this spec** — it's an infrastructure change that needs its own spike (Atlas pricing, replication lag testing, connection string migration). Documented here for context.

### B4. Hot Path Operation Timing

**Files:**

- `packages/cloud/src/services/udp/UdpAudioServer.ts` — UDP packet handling
- `packages/cloud/src/services/session/AudioManager.ts` — audio processing
- `packages/cloud/src/services/session/handlers/glasses-message-handler.ts` — glasses WS messages
- `packages/cloud/src/services/session/handlers/app-message-handler.ts` — app WS messages
- `packages/cloud/src/services/layout/DisplayManager6.1.ts` — display rendering

**What:** Wire the existing `operationTimers` framework (from 057, already in SystemVitalsLogger) to the actual hot paths. Wrap each hot-path entry point in `performance.now()` and call `operationTimers.addTiming(category, ms)`. The vitals logger already reads and resets these every 30 seconds.

**Why:** We know the event loop is being blocked (pods crash from health check timeouts). We know GC isn't the primary cause (10-59ms). We suspect MongoDB is less than we thought (async I/O). The remaining suspects are synchronous CPU work: audio processing (3,250 ops/sec across 65 sessions), display rendering, and message relay. We have zero data on how much CPU time these consume. This fixes that.

**The operationTimers framework already exists** — it was added in 057 but never wired to hot paths because it touches critical code. This spec wires it.

**Categories to instrument:**

| Category           | Where                                                                                                                       | What it measures                                         | Expected volume                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| `audioProcessing`  | `UdpAudioServer.handlePacket()` — wraps the `for` loop that calls `session.audioManager.processAudioData()` for each packet | Total CPU time spent processing UDP audio per 30s window | 65 sessions × 50 chunks/sec = 3,250 calls/sec |
| `glassesMessage`   | `bun-websocket.ts:handleGlassesMessage()` — wraps the entire handler                                                        | Total CPU time routing glasses WS messages               | ~5-10 messages/sec across all sessions        |
| `appMessage`       | `bun-websocket.ts:handleAppMessage()` — wraps the entire handler                                                            | Total CPU time routing app WS messages                   | ~10-20 messages/sec across all sessions       |
| `displayRendering` | `DisplayManager.handleDisplayRequest()` or the main render entry point                                                      | Total CPU time building and sending display updates      | ~2-5 renders/sec across all sessions          |

**Implementation pattern (same for each):**

```typescript
import {operationTimers} from "../metrics/SystemVitalsLogger"

// In the hot path:
const t0 = performance.now()
// ... existing code ...
operationTimers.addTiming("audioProcessing", performance.now() - t0)
```

**What this produces in the existing `system-vitals` log:**

```json
{
  "feature": "system-vitals",
  "op_audioProcessing_ms": 4200,
  "op_glassesMessage_ms": 320,
  "op_appMessage_ms": 580,
  "op_displayRendering_ms": 150,
  "opTotalMs": 5250,
  "opBudgetUsedPct": 18
}
```

This tells us: in the last 30 seconds, audio processing consumed 4.2 seconds of event loop time (14% of the 30s budget), message handling consumed 900ms (3%), display 150ms (<1%). Combined: 18% of the event loop is consumed by application code.

**If `opBudgetUsedPct` is consistently >50%** before crashes, synchronous CPU work is the primary event loop blocker — not MongoDB, not GC. The breakdown by category tells us exactly which hot path to optimize.

**If `opBudgetUsedPct` is <20%** before crashes, application CPU work is NOT the bottleneck. Combined with low GC pauses and the async nature of MongoDB, the blocker must be Bun runtime internals (bmalloc stalls, JSC GC pauses below our measurement layer).

**Performance impact of the instrumentation itself:** `performance.now()` takes ~0.01ms per call. At 3,250 audio calls/sec, that's 0.033ms/sec of overhead — unmeasurable. The `operationTimers.addTiming()` method does one addition. Negligible.

**Important:** Only wrap the outermost entry points, not inner functions. We want "total time spent in audio processing" not "time per individual buffer copy." One timing pair per hot-path entry point.

## What This Does NOT Include

| Explicitly out of scope                                | Why                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `.lean()` on all read queries                          | Good cleanup but not crash-critical. Track in tech-debt.md (TD-1).                                        |
| Atomic `$set` instead of `.save()` on User hot paths   | Good fix but needs careful audit of each call site. Track in tech-debt.md (TD-2).                         |
| N+1 query fixes                                        | Cold paths only. Track in tech-debt.md (TD-3).                                                            |
| MongoDB Atlas read replicas                            | Infrastructure change. Needs its own spike for pricing, testing, migration. Documented above for context. |
| Caching User or UserSettings collections               | More complex (per-user data, frequent writes). Evaluate after app cache ships.                            |
| Cross-pod cache invalidation (pub/sub, Change Streams) | Over-engineered for a 30-second refresh interval. Evaluate only if 30s staleness is unacceptable.         |

## Decision Log

| Decision                                               | Alternatives considered                      | Why we chose this                                                                                                                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 30-second refresh interval                             | 5 min, 1 min, event-driven only              | 30s bounds worst-case staleness for critical fields (publicUrl, hashedApiKey, permissions) while keeping DB load trivial (~2MB query). 5 min is too long for API key regeneration. Event-driven only doesn't work across pods. |
| Cache returns lean-equivalent objects                  | Cache full Mongoose Documents                | Lean objects use ~50% less memory and CPU. The cache serves read-only lookups — no one needs `.save()` on a cached app.                                                                                                        |
| Fallback to DB on cache miss                           | Throw error, return null                     | Graceful degradation. If the cache isn't loaded yet (boot race) or a brand-new app isn't cached, the DB query still works. Just slower.                                                                                        |
| Hot paths only in this spec                            | All 262 call sites                           | 18 hot-path calls cause crashes. 220+ cold-path calls don't. Fix what matters, measure the impact, then decide on the rest.                                                                                                    |
| Gap detector threshold at 2000ms                       | 1500ms, 3000ms, 5000ms                       | The interval is 1000ms. 2000ms means the event loop was blocked for at least 1 full second — that's already past the health check timeout. Lower thresholds would catch more events but increase noise.                        |
| Record all slow queries in stats, not just logged ones | Only record queries above a higher threshold | Consistency — the threshold for recording matches the threshold for logging (`MONGOOSE_SLOW_QUERY_MS`). If you want to tune them separately, add a second env var later.                                                       |

## Testing Plan

### On cloud-debug (before PR to main)

1. **Gap detector fires during forced delay** — add a temporary `Bun.sleepSync(2000)` in a test route, hit it, verify `feature: "event-loop-gap"` appears in BetterStack with `gapMs` ~2000.
2. **MongoDB stats appear in vitals** — check `feature: "system-vitals"` logs for `mongoQueryCount`, `mongoTotalBlockingMs`, `mongoMaxQueryMs` fields.
3. **App cache loads** — check BetterStack for `feature: "app-cache"` log at boot showing count and refresh time.
4. **App cache serves hot paths** — connect glasses, start an app. Verify no `slow-query` logs from `apps.findOne({ packageName })` for cached apps.
5. **Cache fallback works** — if cache somehow misses (e.g., brand new app), the DB query still works. Test by querying a packageName that exists in DB but force a cache miss.
6. **Write-through invalidation** — publish a test app via developer console, verify it appears in glasses within seconds (not 5 minutes).
7. **Operation timers appear in vitals** — connect glasses with mic on. Check `feature: "system-vitals"` for `op_audioProcessing_ms`, `op_glassesMessage_ms`, `op_appMessage_ms`, `opTotalMs`, `opBudgetUsedPct`. Values should be >0 with an active session.

### After PR to main (monitoring cloud-prod)

7. **Correlate gaps with crashes** — query BetterStack: do `event-loop-gap` warnings appear in the 5 minutes before each crash? If yes, what caused them? Cross-reference with `slow-query` timestamps.
8. **MongoDB blocking metric** — does `mongoTotalBlockingMs` drop after the app cache is active? On France, it was 162s/1800s (5,428ms per 30s window). After cache, hot-path queries should be eliminated, dropping this number significantly.
9. **Crash frequency** — does crash rate decrease? Target: France goes from crashing every ~3 hours to stable. US Central goes from ~6-7 crashes/day to <2.
10. **Cache boot time** — how long does the initial `App.find({}).lean()` take? On US Central it should be ~100ms. On East Asia ~700ms. This blocks server startup, not the event loop during operation.
11. **Operation budget before crash** — in the 5 minutes before a crash, what is `opBudgetUsedPct`? If it climbs from 20% → 50% → 80% → crash, synchronous CPU work is the bottleneck. The category breakdown (`op_audioProcessing_ms` vs `op_glassesMessage_ms` etc.) tells us which hot path to optimize.
12. **Operation budget vs session count** — does `opBudgetUsedPct` scale linearly with sessions? If 30 sessions = 20% and 60 sessions = 55%, we can predict the crash threshold and calculate the max sessions per pod.

### What "success" looks like

- `event-loop-gap` warnings correlate with crash timing → we now know what blocks the event loop before each crash.
- `mongoTotalBlockingMs` drops 80%+ on hot paths after cache → app queries were the dominant blocker.
- `opBudgetUsedPct` shows which hot path consumes the most CPU → we know exactly where to optimize.
- Crash frequency drops meaningfully → the combination of cache + visibility into hot paths lets us fix the right thing.

If crash frequency doesn't change after the cache: the operation timers tell us if synchronous CPU work is the bottleneck (high `opBudgetUsedPct`) or if it's something below our measurement layer (low budget + gaps still appearing = Bun runtime issue). Either outcome gives us actionable data.

## Rollout

1. **Implement on `cloud/062-mongodb-audit` branch** — all three changes.
2. **Deploy to cloud-debug** — test all 6 items above.
3. **PR to main** — deploys to all prod regions.
4. **Monitor** — one full crash cycle (~3 hours for France, ~2-4 hours for US Central).
5. **If crashes drop** — success. Move to tech debt cleanup (lean, atomic updates).
6. **If crashes persist** — event loop gap detector tells us what's actually blocking. Investigate that.
