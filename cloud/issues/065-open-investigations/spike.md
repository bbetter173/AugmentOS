# Spike: Open Investigations — Master Tracking

## Overview

**What this doc covers:** Every finding from the March 27-28 crash investigation, what we proved, what we didn't, and a complete context handoff for the next session. This is the single document to read before continuing any cloud stability work.
**Why this doc exists:** We discovered 15+ issues during a multi-day investigation spanning issues 057-064. Some are confirmed with definitive proof, some are strong suspects, some are infrastructure improvements. All need to be tracked so nothing falls through the cracks.
**Who should read this:** Anyone working on cloud stability, infrastructure, or SRE. Start here.

**Related issues (read these for deep context):**

- [057-cloud-observability](../057-cloud-observability/) — memory leak fixes + observability (shipped)
- [058-multi-region-scaling](../058-multi-region-scaling/) — Doppler migration, multi-region, CONTEXT.md has full operational notes
- [059-env-var-cleanup](../059-env-var-cleanup/) — env var audit (spike written, not implemented)
- [060-betterstack-collectors](../060-betterstack-collectors/) — collector install on all 5 clusters (shipped)
- [061-crash-investigation](../061-crash-investigation/) — crash diagnostics: GC probe, health timing, Soniox timing, connection counting (shipped)
- [062-mongodb-latency](../062-mongodb-latency/) — app cache, operation timing, event loop gap detector, MongoDB audit with 262 call sites, tech-debt.md (shipped)
- [063-graceful-shutdown](../063-graceful-shutdown/) — SIGTERM handler, WebSocket close frames, drain middleware (shipped)
- [064-bstack-cli](../064-bstack-cli/) — BetterStack CLI tool for SRE queries (built, on dev branch)

**Key branches:**

- `main` — has all hotfixes (061, 062, 063) deployed to all 5 prod regions
- `cloud/064-bstack-cli` — bstack CLI tool + this tracking issue (on dev)
- `cloud/058-multi-region-scaling` — merged to dev, has CONTEXT.md with full operational notes

---

## THE TWO INTERLOCKING ROOT CAUSES

We identified two problems that individually might be survivable but together create the crash cycle:

### Root Cause 1: Bun's Automatic GC Freezes the Event Loop

**Status:** ✅ PROVEN with definitive evidence

**What happens:**

1. With 80 sessions, the JS heap is ~500MB of live, in-use objects (sessions, audio buffers, Soniox connections, display state)
2. JSC's garbage collector periodically triggers a full mark-and-sweep collection
3. The GC scans every object in the 500MB heap, finds everything is reachable, frees nothing
4. The scan itself takes 3+ seconds — a synchronous stop-the-world pause
5. During those 3+ seconds, the event loop is completely frozen
6. Health checks, WebSocket messages, audio processing — all frozen

**Definitive evidence (March 28, 21:40 UTC, US Central):**

- Event loop gap detector recorded a **3,378ms gap** at 21:40:27.970
- "Object finalized by GC" messages appeared at 21:40:27.978 (right when the event loop unfroze)
- MongoDB Atlas API confirmed: `OP_EXECUTION_TIME_READS = 0.0` at that exact time — the server was NOT slow
- MongoDB `TICKETS_AVAILABLE_READS = 7` — server was NOT saturated
- No Atlas maintenance events at that time
- A `users.findOne` callback that was logged as "3,409ms" was actually a VICTIM — the callback was queued waiting for the frozen event loop, not causing the freeze
- The pod's uptime went from 4664s at 21:49:35 to **30s at 21:50:35** — confirming the pod crashed (SIGKILL) ~10 minutes after the first gap

**What our forced GC probes show vs what the runtime does:**

- Our probes (`Bun.gc(true)` every 60s): 82-142ms, freed 0MB — these are incremental collections
- The runtime's automatic full collection: 3,378ms — this is a full mark-and-sweep we can't control
- The GC freed 0MB because ALL 500MB is live objects — there's nothing to collect
- The GC is doing completely wasted work: scanning 500MB, finding nothing, freezing the event loop for 3+ seconds

**JSC GC tuning options discovered (environment variables via `BUN_JSC_` prefix):**

- `BUN_JSC_largeHeapGrowthFactor` — default 1.24, controls when full GC triggers (at 1.24x growth). Setting to 2.0 would halve GC frequency.
- `BUN_JSC_criticalGCMemoryThreshold` — default 0.8, GC becomes "much more aggressive" above 80% memory usage.
- `BUN_JSC_gcPauseScale` — default 0.3, controls max pause time relative to heap size.
- `BUN_JSC_concurrentGCPeriodMS` — default 2ms, how often concurrent GC checks.
- `BUN_JSC_largeHeapSize` — default 32MB (!). Our 500MB heap is 15x the "large" threshold.

These are Doppler env vars — zero code changes needed. NOT YET TESTED.

### Root Cause 2: Massive Client WebSocket Churn (Ping/Pong Issue)

**Status:** ⚠️ DISCOVERED, needs investigation

**What we found:**

Even BEFORE the GC freeze at 21:40, users were rapidly disconnecting and reconnecting:

- `doorstoprocks@yahoo.com`: 4 disconnect/reconnect cycles in 1 minute (9-24 second session lifetimes)
- `zzjdcjmdjd@privaterelay.appleid.com`: 5-8 second session lifetimes
- Multiple users showing the same pattern simultaneously

**The ping/pong mechanism (from `UserSession.ts`):**

```
Server sends:
  - Protocol-level pings every 10 seconds (HEARTBEAT_INTERVAL = 10000)
  - App-level pings every 2 seconds (APP_LEVEL_PING_INTERVAL = 2000)

Server-side pong timeout: DISABLED (PONG_TIMEOUT_ENABLED = false)
  Reason: "Cloudflare absorbs protocol-level ping/pong at the edge,
  so pongs from the mobile client never reach Bun"
```

**What we observed for `doorstoprocks@yahoo.com`:**

1. Connected at 21:38:13
2. Server sent app-level pings at 21:38:15, 21:38:17, 21:38:19 (every 2s)
3. WebSocket closed at 21:38:22 — only 9 seconds after connecting
4. Server-side pong timeout is DISABLED, so the server didn't kill it
5. Either the CLIENT killed it (its own liveness detection) or CLOUDFLARE killed it

**Why this matters for crashes:**

Each reconnect cycle means:
- New UserSession created (allocates managers, buffers, Soniox connection)
- Old session enters grace period, then disposes (cleanup, our forced GC)
- Apps restart, display reinitializes, transcription streams recreate

With 80 sessions and many churning, this creates massive object allocation/deallocation churn that drives memory pressure and GC frequency. The GC has MORE objects to scan each cycle.

**The two problems feed each other:**

```
Client churn → more objects → higher memory → GC triggers full collection
→ 3+ second freeze → more clients disconnect (ping timeout)
→ reconnect storm → even more objects → even higher memory → repeat
```

**What we DON'T know:**

- Is the client killing the WebSocket? If so, what's its timeout? Is it the app-level ping/pong or something else?
- Is Cloudflare killing idle connections? The connection isn't idle (pings every 2s), but Cloudflare might have its own rules.
- How many of the 80 sessions are "stable" vs "churning"? Is it 5 bad clients causing all the churn or is everyone churning?
- Do the mobile client logs show why the disconnect happens?

**How to investigate:**

- Use `scripts/fetch-incident-logs.sh` to get mobile client logs for users who are churning
- Check the mobile client's WebSocket liveness detection code — what timeout does it use?
- Check if the app-level ping messages are being received by the client (they should be — they're regular WebSocket text messages, not protocol-level pings)
- Check Cloudflare's WebSocket timeout settings for the load balancer

---

## ADDITIONAL CONFIRMED ISSUES

### 3. Cloudflare Load Balancer — Wrong Domain

**Status:** ❌ Not fixed
**Severity:** 🔴 High — all traffic goes to US Central, US West/East are empty

The mobile app uses `api.mentra.glass` which has a different Cloudflare LB config than `api.mentraglass.com`. Proximity steering, session affinity removal, and US West/East pools were configured on `mentraglass.com`. The app needs updating or the LB config needs duplicating.

**Evidence:** US Central has 82 sessions, US West and US East have 0.

**Investigation done:**

- Cloudflare API access confirmed working (token in `.env` as `CLOUDFLARE_LB_API_TOKEN`)
- 6 pools visible: asiaeast, france, uscentral, uscentral_glass, us-east, us-west
- Session affinity was `ip_cookie` with 23hr TTL — **disabled** (was pinning users to wrong continent)
- `failover_across_pools` was `false` — **enabled**
- US East pool has no health monitor

**What needs to happen:**

- [ ] Investigate the two LB configs (`api.mentra.glass` vs `api.mentraglass.com`) using Cloudflare API
- [ ] Either update mobile app domain or copy LB config
- [ ] Add health monitor to US East pool
- [ ] This alone would reduce US Central from 82 sessions to ~30, which would dramatically reduce GC pressure

### 4. France and East Asia — Manual Porter Env Vars Deleted

**Status:** ✅ Fixed (manual vars deleted March 28, need redeploy)

All manual Porter env vars deleted from France (4696) and East Asia (4754). They now use Doppler exclusively. BUT they need a redeploy to pick up the new Doppler values including the new BetterStack source token.

- [ ] Redeploy France and East Asia
- [ ] Verify logs flow to MentraCloud-Prod source (ID 2324289)

### 5. Our Forced GC Is Making Crashes Worse

**Status:** ⚠️ Confirmed, needs hotfix

The `gc-after-disconnect` feature (added in 061) calls `Bun.gc(true)` after each session disconnect with a 10-second rate limit. During a disconnect storm (20 users disconnecting after a GC freeze), this fires every 10 seconds, each taking 120-148ms. Combined with the 60-second GC probe, we're adding ~250ms of unnecessary event loop blocking per minute during the exact moment the pod needs every millisecond to handle reconnections.

**Evidence:** Between 21:40 and 21:50 (the 10-minute crash window), there were 20 `gc-after-disconnect` calls averaging 125ms each = 2.5 seconds of forced GC blocking. Plus 10 gc-probe calls at ~120ms = 1.2 seconds. Total: ~3.7 seconds of SELF-INFLICTED event loop blocking during a crash cascade.

**What needs to happen:**

- [ ] Remove `gc-after-disconnect` from UserSession.ts — diagnostic purpose served, now harmful
- [ ] Consider making gc-probe opt-in via env var (or remove it too)
- [ ] Or at minimum, skip forced GC when RSS > 700MB (the pod is already in trouble)

### 6. MongoDB `users.findOne` Latency

**Status:** ✅ Proven NOT the cause (was a victim)

The 3,409ms `users.findOne` that appeared to cause the event loop gap was actually a callback WAITING for the frozen event loop to process it. MongoDB Atlas API confirmed:

- Server execution time: 0ms (queries are indexed and fast)
- Read tickets available: 7 (server not saturated)
- No maintenance events at that time

The MongoDB query was sent, MongoDB responded in ~80ms, but the response sat in the network buffer for 3.3 seconds because the event loop was frozen by GC.

**However:** MongoDB round-trip latency is still a performance issue (80ms US Central, 215ms France, 370ms East Asia). The app cache (062) eliminated hot-path app lookups. `users.findOne` (176 queries in 30 min at 150ms avg) is the next candidate for caching or optimization.

### 7. SDK Auth Still Hits Database

**Status:** ❌ Known tradeoff

Intentionally reverted to DB-only for credential validation (security). 64 slow `apps.findOne` queries in 30 min from SDK auth. Consider short-TTL auth-specific cache in future.

---

## INFRASTRUCTURE IMPROVEMENTS (not blocking, but valuable)

### 8. Per-Region Uptime Monitors — ❌ Not set up

Only `prod.augmentos.cloud/health` is monitored. If France crashes but US Central is up, no alert.

### 9. BetterStack Dashboard Alerts — ❌ Not set up

Need alerts on: RSS > 800MB, container restarts, event-loop-gap count > 0, opBudgetUsedPct > 50.

### 10. SRE Dashboards for All Regions — ❌ Only US Central

Collectors running on all 5 clusters. Need dashboards for France, East Asia, US West, US East.

### 11. Mobile Client Reconnect Improvements — ❌ Not started

Detect REST 503 as reconnect signal. Investigate the rapid disconnect/reconnect pattern.

### 12. `MEMORY_TELEMETRY_ENABLED` — ❌ Still not flipped

Set `MEMORY_TELEMETRY_ENABLED=true` in Doppler prod base. Shows per-session memory breakdown every 10 min. Zero code change.

### 13. Cherry-Pick Hotfixes into Dev — ❌ Dev behind main

062 and 063 hotfixes are on main but not dev. Need merge or cherry-pick.

### 14. BetterStack Log Source Split Incomplete

US Central, US West, US East → new MentraCloud-Prod source (working).
France, East Asia → still on old AugmentOS source (need redeploy).
Debug, dev, local → old AugmentOS source (correct).

---

## TOOLS & ACCESS INVENTORY

Available for the next session:

| Tool | Access | Purpose |
|------|--------|---------|
| `bstack` CLI | `cloud/tools/bstack/bstack.ts` | Pre-built SRE queries against BetterStack. Run: `cd cloud/tools/bstack && bun run bstack.ts health` |
| BetterStack SQL API | ClickHouse creds in `.env` (`BETTERSTACK_USERNAME`, `BETTERSTACK_PASSWORD`) | Direct ClickHouse queries. Endpoint: `https://eu-nbg-2-connect.betterstackdata.com` |
| BetterStack Management API | `BETTERSTACK_API_TOKEN` in `.env` | Uptime monitors, sources, dashboards |
| MongoDB Atlas API | `MONGODB_ATLAS_PUBLIC_KEY` / `MONGODB_ATLAS_PRIVATE_KEY` in `.env` | Cluster health, connection pools, slow query logs, Performance Advisor. Use digest auth. Project ID: `67aeb2349c20fd24351c5392`. Cluster: `AugmentOS` (Azure US North Central, M10). |
| Cloudflare API | `CLOUDFLARE_LB_API_TOKEN` in `.env` | Load balancer config, pool health, DNS. Account: `3c764e987404b8a1199ce5fdc3544a94`. |
| Doppler CLI | Authenticated | Env var management. Project: `mentraos-cloud`. |
| Porter CLI | Authenticated, cluster configs in 058 CONTEXT.md | Cluster/pod management. |
| GitHub CLI | Authenticated | PRs, issues, deployments. |
| `mongosh` | Installed, connection string in Doppler `MONGO_URL` | Direct MongoDB queries. |
| `analyze-heap.ts` | `cloud/packages/cloud/src/scripts/analyze-heap.ts` | Live memory tracking, needs `MENTRA_ADMIN_JWT` env var. |
| Incident logs | `scripts/fetch-incident-logs.sh` | Fetch mobile client logs for bug reports. Needs `MENTRA_AGENT_API_KEY`. |

### Key BetterStack Sources

| Source | ID | Table (recent) | What's in it |
|--------|-----|-----------------|-------------|
| MentraCloud-Prod | 2324289 | `remote(t373499_mentracloud_prod_logs)` | US Central, US West, US East prod + staging |
| AugmentOS (legacy) | 1311181 | `remote(t373499_augmentos_logs)` | France, East Asia prod + dev/local/debug |
| US Central collector | 2321796 | `remote(t373499_mentra_us_central_metrics)` | Container CPU, memory, restarts |
| France collector | 2326580 | `remote(t373499_mentra_france_metrics)` | Container metrics |
| East Asia collector | 2326583 | `remote(t373499_mentra_east_asia_metrics)` | Container metrics |
| US West collector | 2326586 | `remote(t373499_mentra_us_west_metrics)` | Container metrics |
| US East collector | 2326589 | `remote(t373499_mentra_us_east_metrics)` | Container metrics |

For historical logs, use `s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1`.

### Diagnostic Log Features (what our instrumentation emits)

| Feature | What it shows | Shipped in |
|---------|--------------|------------|
| `gc-probe` | Forced GC duration, heap before/after, freed MB (every 60s) | 061 |
| `gc-after-disconnect` | Forced GC after session dispose (rate-limited 10s) | 061 |
| `event-loop-gap` | Detected >2s event loop freeze (the KEY diagnostic) | 062 |
| `system-vitals` | RSS, heap, sessions, connections, mongoQueryCount, mongoTotalBlockingMs, op_audioProcessing_ms, op_appMessage_ms, opBudgetUsedPct (every 30s) | 061+062 |
| `slow-query` | MongoDB queries exceeding `MONGOOSE_SLOW_QUERY_MS` (100ms) | 061 |
| `app-cache` | Cache refresh count, apps cached, refresh time (every 30s) | 062 |
| `health-timing` | /health endpoint slow (>50ms) | 061 |
| `soniox-timing` | Soniox sendAudio slow (>50ms, rate-limited) | 061 |

### Porter Cluster IDs

| Region | Cluster ID | Doppler Config |
|--------|-----------|----------------|
| US Central | 4689 | prod_central-us |
| France | 4696 | prod_france |
| East Asia | 4754 | prod_east-asia |
| US West | 4965 | prod_us-west |
| US East | 4977 | prod_us-east |

---

## PRIORITY ORDER FOR NEXT SESSION

| # | Item | Type | Impact |
|---|------|------|--------|
| 1 | **Investigate client WebSocket churn** — why are clients disconnecting every 5-24 seconds? Check mobile client ping/pong code, Cloudflare WS settings. Use incident logs for mobile-side data. | Investigation | 🔴 Root cause #2 — reducing churn reduces memory pressure |
| 2 | **Fix Cloudflare LB domain** — mobile uses `api.mentra.glass`, LB configured on `api.mentraglass.com`. Distribute traffic to reduce US Central from 82 → ~30 sessions. | Config fix | 🔴 Halves session count → halves GC pressure |
| 3 | **Remove gc-after-disconnect** — it's making crash cascades worse. Hotfix to main. | Code fix | 🔴 Removes 2.5s of self-inflicted blocking during crashes |
| 4 | **Test JSC GC tuning** — `BUN_JSC_largeHeapGrowthFactor=2.0` in Doppler. Could halve GC frequency. Zero code change. | Config test | 🟡 Might extend crash-free window significantly |
| 5 | **Redeploy France/East Asia** — pick up new Doppler config (BetterStack source, cleaned env vars) | Deploy | 🟡 Gets all regions on same log source |
| 6 | **Set up per-region uptime monitors** | Config | 🟡 Detect regional outages |
| 7 | **Set up dashboard alerts** (RSS > 800MB, restarts, gaps) | Config | 🟡 Proactive crash detection |
| 8 | **Write runbooks** for the bstack CLI tool | Docs | 🟢 Enables any engineer to diagnose |
| 9 | **Flip MEMORY_TELEMETRY_ENABLED** | Config | 🟢 Per-session memory breakdown |
| 10 | **Cherry-pick hotfixes to dev** | Git | 🟢 Keep branches in sync |

---

## WHAT WE SHIPPED (March 27-28)

For reference — everything implemented and deployed to production:

| What | Issue | Status |
|------|-------|--------|
| Doppler migration — all 8 apps on 5 clusters | 058 | ✅ Shipped |
| BetterStack Collectors on all 5 clusters | 060 | ✅ Shipped |
| REGION env var on all Doppler configs | 058 | ✅ Shipped |
| UDP_HOST changed to DNS hostnames | 058 | ✅ Shipped |
| BetterStack prod log source switched in Doppler | 058 | ✅ Shipped |
| Cloudflare session affinity disabled (23hr cookie) | 058 | ✅ Shipped |
| Cloudflare failover_across_pools enabled | 058 | ✅ Shipped |
| GC probe (60s forced GC with timing) | 061 | ✅ Shipped |
| GC on session disconnect (rate-limited) | 061 | ✅ Shipped (should be removed — see #5 above) |
| Health check timing (warn >50ms) | 061 | ✅ Shipped |
| Soniox send timing (warn >50ms) | 061 | ✅ Shipped |
| Connection counting in vitals | 061 | ✅ Shipped |
| MongoDB slow query plugin | 061 | ✅ Shipped |
| Event loop gap detector | 062 | ✅ Shipped |
| Cumulative MongoDB blocking metric | 062 | ✅ Shipped |
| In-memory app cache (30s refresh, 9 hot paths, 18 write-path invalidations) | 062 | ✅ Shipped |
| Hot path operation timing (audio, messages, display) | 062 | ✅ Shipped |
| Graceful shutdown on SIGTERM | 063 | ✅ Shipped |
| WebSocket close frames on deploy (1001 Going Away) | 063 | ✅ Shipped |
| Global drain middleware (503 during shutdown) | 063 | ✅ Shipped |
| 2s drain delay for close frame flush | 063 | ✅ Shipped |
| SRE Dashboard for US Central (10 charts) | — | ✅ Built (ID 973977) |
| bstack CLI tool | 064 | ✅ Built (on dev branch) |
| Stale env var fixes (ADMIN_EMAILS, apps list, etc.) | 058 | ✅ Shipped |
| R2 vars, OPEN_WEATHER_API_KEY added to Doppler | 058 | ✅ Shipped |

---

## KEY NUMBERS (as of March 28 ~22:00 UTC)

| Metric | Value |
|--------|-------|
| Crash rate (before investigation) | ~7/day |
| Crash rate (after 062 deploy) | 1 observed crash in ~4 hours |
| US Central sessions | 80-84 |
| US Central RSS at crash | ~850MB |
| Heap at crash | ~500MB |
| GC probe (forced, our code) | 82-142ms |
| GC full collection (runtime, automatic) | 3,378ms (observed) |
| Event loop gaps detected | 2 (3,378ms and 1,048ms) |
| Time from first gap to crash | ~10 minutes |
| MongoDB server execution time | 0ms (queries are fast, latency is network) |
| MongoDB RTT: US Central | ~80ms |
| MongoDB RTT: France | ~215ms |
| MongoDB RTT: East Asia | ~370ms |
| App cache: apps cached | 1,318 |
| App cache: refresh time (US Central) | 130-160ms |
| Operation budget at 80 sessions | 6-8% (healthy) |
| Sessions with rapid churn (5-24s lifetimes) | Multiple observed before crash |
| Deploy reconnect time (with graceful shutdown) | ~5 seconds |
| Deploy reconnect time (before graceful shutdown) | 30-60 seconds |