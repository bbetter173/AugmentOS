# Spike: MongoDB Latency & Query Audit

## Overview

**What this doc covers:** Full audit of every MongoDB call in the cloud server, investigation into MongoDB query latency as a crash contributor, and a framework for proving whether MongoDB is a primary crash cause.

**Why this doc exists:** The 061 crash diagnostics revealed `apps.find` and `apps.findOne` queries taking 200–750ms from international regions. France's event loop was blocked by MongoDB for 162 seconds out of 1800 seconds (9% of total time). We need to determine if this is THE crash cause or just one factor.

**Depends on:** [061-crash-investigation](../061-crash-investigation/), [057-cloud-observability](../057-cloud-observability/)

**Who should read this:** Anyone working on cloud stability or database performance.

## Background

- Cloud server runs on Bun's single-threaded event loop — any awaited operation >50ms blocks everything
- K8s liveness probe: `/health` every 5s, 1s timeout, 15 failures = SIGKILL
- MongoDB cluster is in one region (likely US East), all pods pay network RTT
- The `apps` collection has a unique index on `packageName` — queries are fast (0ms server execution), latency is pure network RTT

## Findings

### 1. Slow Query Logs (from 061 diagnostics)

**France (22 sessions):**

- 1,381 slow queries in 30 minutes (46/min exceeding 100ms)
- Average latency: 118ms
- Max latency: 521ms
- Total event loop blocking: 162,721ms in 30 min = **2.7 minutes of blocking out of 30 = 9% of event loop time**

**East Asia (1 session):**

- `apps.find`: 750ms
- `apps.findOne`: 370ms

### 2. Direct MongoDB Investigation (via mongosh)

The `packageName` index exists (unique, 0ms server execution, `EXPRESS_IXSCAN`). The latency is entirely network RTT:

| Operation                          | SF      | France | East Asia |
| ---------------------------------- | ------- | ------ | --------- |
| Ping                               | 153ms   | ~200ms | ~350ms    |
| `findOne` by indexed `packageName` | 63–80ms | ~215ms | ~370ms    |
| `find()` all 1,314 docs            | 639ms   | —      | 750ms     |

Collection stats:

- 1,314 docs, 2 MB total, avg 1.5 KB per doc
- Largest docs: 97 KB (`com.augmentos.livecaptions`), 58 KB, 54 KB

**The latency is NETWORK RTT, not query execution.**

### 3. GC Probe Results (concurrent with slow query logs)

- France GC: 54ms avg, max 59ms — moderate but NOT the primary crash cause
- GC freed: 0 MB every time — nothing to collect
- East Asia GC: 37–40ms

GC is not the smoking gun.

### 4. Full Database Call Audit

**Summary:**

- Total collections: 11 (`App`, `User`, `Organization`, `UserSettings`, `Incident`, `SimpleStorage`, `CLIKey`, `AppUptime`, `TempToken`, `GalleryPhoto`, `Feedback`)
- Total DB operations: ~262 call sites across the codebase
- Only ~44 of ~250+ reads use `.lean()` (18%)

#### Hot path calls (every session or every message)

These are the crash-relevant ones:

**App collection:**

- `AppManager.ts`: `App.find()` on every `startApp` — no lean, no cache
- `SubscriptionManager.ts`: `App.findOne()` on every subscription update — no lean, no cache
- `app-message-handler.ts`: `App.findOne()` on every camera permission check — no lean, no cache
- `sdk.auth.service.ts`: `App.findOne().lean()` on every SDK API call — has lean, no cache

**User collection:**

- `user.model.ts`: `User.save()` on `setLocation`, `addRunningApp`, `removeRunningApp`, `updateAppSettings` — full document writes instead of atomic `$set`
- `LocationManager.ts`: `User.findOne()` on session start (seed location) — no lean
- `location.service.ts`: `User.findOne()` + `.save()` on every device location update — no lean, full save

**UserSettings collection:**

- `UserSettingsManager.ts`: `UserSettings.findOne()` on session start — no lean, no cache

#### Warm path calls (per-app-open, per-SDK-call)

- `system-app.api.ts`: 5 different `App.find`/`findOne` calls for SDK operations — no lean
- `SimpleStorage`: 8 operations per SDK storage call — partially lean
- `LocationManager` dispose: `User.findOne()` + `.save()` — no lean

#### Cold path calls

~220+ operations in admin routes, developer console, organization management. Many missing `.lean()` but low impact since they're infrequent.

## What We Have Proven

1. MongoDB queries from France block the event loop for **9% of total time** (162s out of 1800s)
2. The latency is network RTT, not query execution (indexes work, 0ms on server)
3. GC is NOT the primary crash cause (54ms pauses, 0 MB freed)
4. Hot-path code does redundant DB lookups without caching or `.lean()`

## What We Have NOT Proven

1. That a specific crash was directly caused by MongoDB blocking the health check
2. Cumulative blocking during reconnect storms (when all users reconnect after a crash)
3. Total blocking across regions at crash time
4. US Central hasn't redeployed with diagnostics yet — no data from the busiest region

## How to Prove Causation

### Step 1: Add cumulative MongoDB blocking to system vitals

Add `mongoQueryCount`, `mongoTotalBlockingMs`, `mongoMaxQueryMs` to the 30s vitals tick. The slow query plugin already times queries — extend it to accumulate per-window totals.

**Why this proves it:** If `mongoTotalBlockingMs` is 5,000ms in a 30-second window, MongoDB blocked 17% of event loop time. Correlate with event loop lag — if they track together, MongoDB is the cause.

### Step 2: Add event loop gap detector

A 1-second `setInterval` that checks "has it been >2 seconds since I last ran?" If yes, the event loop was blocked. Log the gap duration and timestamp. Then correlate with slow-query timestamps.

**Why this proves it:** If a slow query starts at T and an event loop gap appears at T+0.1s lasting 400ms, that query caused the gap. This is the definitive link between "MongoDB query was slow" and "event loop was blocked."

### Step 3: Measure reconnect storm query volume

After a pod restart, all users reconnect. Each triggers session setup queries. Log total query count and blocking time in the first 60 seconds after restart.

**Why this proves it:** If the storm generates 300+ queries at 80ms each = 24 seconds of blocking in 60 seconds, the crash → restart → crash loop is self-reinforcing.

### Step 4: Test with in-memory app cache on debug

Cache the apps collection in memory (~2 MB). Serve all `findOne({packageName})` from cache. Measure event loop lag with vs without cache.

**Why this proves it:** If lag drops significantly with cache, MongoDB was the bottleneck. If not, something else is.

## Potential Fixes (after proving causation)

### Quick wins (minimal code changes)

1. **In-memory app cache** — load all 1,314 docs at boot (~2 MB), refresh every 5 min. Eliminates ALL apps collection RTT. Risk: 5 min staleness for new apps.
2. **`.lean()` on all read-only queries** — find/replace across codebase. Reduces Mongoose hydration CPU ~50%. Risk: can't call `.save()` on lean docs.
3. **Atomic updates instead of `.save()`** — replace `User.save()` with `User.updateOne({$set: ...})` on hot paths. Eliminates full document writes and `VersionError` risks.

### Medium effort

4. **MongoDB read replicas per region** (Atlas config) — reduces RTT for all collections. Cost increase.
5. **Move DB to US Central** — halves RTT for busiest region. Migration risk.

## Key Numbers

| Metric                                                  | Value                                       |
| ------------------------------------------------------- | ------------------------------------------- |
| `apps` collection size                                  | 1,314 docs, 2 MB, avg 1.5 KB, largest 97 KB |
| Ping to DB from SF                                      | 153ms                                       |
| Ping to DB from France                                  | ~200ms                                      |
| Ping to DB from East Asia                               | ~350ms                                      |
| `findOne` by indexed field (SF)                         | 63–80ms                                     |
| `findOne` by indexed field (France)                     | ~215ms                                      |
| `findOne` by indexed field (East Asia)                  | ~370ms                                      |
| `find()` all 1,314 docs (SF)                            | 639ms                                       |
| Total event loop blocking from MongoDB (France, 30 min) | 162s out of 1800s (9%)                      |
| Hot path DB call sites                                  | ~18                                         |
| Warm path DB call sites                                 | ~16                                         |
| Total DB call sites                                     | ~262                                        |
| Queries using `.lean()`                                 | 44 out of 250+ reads (18%)                  |

## Next Steps

1. Add cumulative MongoDB metrics to system vitals (code change)
2. Add event loop gap detector (code change)
3. Redeploy US Central with existing 061 diagnostics
4. Wait one crash cycle, correlate all data
5. If MongoDB correlates → write spec for app cache + `.lean()` cleanup
6. If not → investigate next suspect with same rigor
