# Spike: Open Investigations — Master Tracking

## Overview

**What this doc covers:** Every untracked finding from the March 27-28 crash investigation and infrastructure work. This is a living checklist so nothing falls through the cracks.
**Why this doc exists:** We discovered 10+ issues during the investigation that don't have their own issues yet. Some are confirmed problems, some are suspects that need proof, some are improvement opportunities. All need to be tracked.
**Who should read this:** Anyone working on cloud stability, infrastructure, or SRE.

**Related issues:**

- [057-cloud-observability](../057-cloud-observability/) — memory leak fixes + observability (shipped)
- [058-multi-region-scaling](../058-multi-region-scaling/) — Doppler migration, multi-region (shipped)
- [059-env-var-cleanup](../059-env-var-cleanup/) — env var audit (spike written)
- [060-betterstack-collectors](../060-betterstack-collectors/) — collector install (shipped)
- [061-crash-investigation](../061-crash-investigation/) — crash diagnostics (shipped)
- [062-mongodb-latency](../062-mongodb-latency/) — app cache, operation timing, gap detector (shipped)
- [063-graceful-shutdown](../063-graceful-shutdown/) — SIGTERM handler (shipped)
- [064-bstack-cli](../064-bstack-cli/) — BetterStack CLI tool (built)

---

## Confirmed Issues (need fixes)

### 1. Cloudflare Load Balancer — Wrong Domain

**Status:** ❌ Not fixed
**Severity:** 🔴 High — all traffic goes to US Central, US West/East are empty

The mobile app uses `api.mentra.glass` which has a different Cloudflare LB config than `api.mentraglass.com`. The proximity steering, session affinity removal, and US West/East pool additions were done on `mentraglass.com`. The app needs to be updated to use the correct domain, or the LB config needs to be duplicated to the `mentra.glass` domain.

**Evidence:** US Central has 82 sessions, US West and US East have 0, even though proximity steering is configured.

**Findings from investigation:**

- Session affinity was `ip_cookie` with 23-hour TTL — disabled (was pinning users to wrong continent after travel)
- `failover_across_pools` was `false` — enabled
- Proximity steering is configured with GPS coordinates for all 5 pools
- US East pool has no health monitor
- There's a `uscentral_glass` pool that appears separate from `uscentral`

**What needs to happen:**

- [ ] Investigate the two LB configs (mentra.glass vs mentraglass.com)
- [ ] Either update the mobile app to use mentraglass.com or copy the LB config to mentra.glass
- [ ] Add health monitor to US East pool
- [ ] Verify proximity steering works from different locations

**Tools available:** Cloudflare API token in `.env`

---

### 2. France and East Asia — Stale Porter Env Vars

**Status:** ✅ Fixed (manual vars deleted March 28)
**Severity:** Was blocking — France/East Asia had manual Porter vars overriding Doppler, including old BetterStack source token.

**What was done:** Deleted all manual Porter env vars from France (4696) and East Asia (4754). They now use Doppler exclusively. BUT they need a redeploy to pick up the new Doppler values (including new BetterStack source token).

**Remaining:**

- [ ] Redeploy France and East Asia to pick up new Doppler config
- [ ] Verify logs flow to MentraCloud-Prod source (ID 2324289) after redeploy

---

### 3. MongoDB `users.findOne` — 3.4 Second Spike

**Status:** ❌ Under investigation
**Severity:** 🔴 High — directly caused a 3.4-second event loop gap on US Central

**Evidence (definitive):**

- Event loop gap at 21:40:27 (3,378ms) coincided exactly with `users.findOne` taking 3,409ms
- Second gap at 21:42:33 (1,048ms) coincided with `apps.findOne` and `users.findOne` both taking 1,759ms
- `users.findOne` is the #1 slow query: 176 queries in 30 min, avg 150ms, max 3,409ms

**What we DON'T know:**

- Why a normally 80ms query spiked to 3.4 seconds — was it MongoDB Atlas maintenance, connection pool exhaustion, or network glitch?
- Whether this is a recurring pattern or a one-time event
- Whether connection pool tuning would prevent it

**What needs to happen:**

- [ ] Check MongoDB Atlas for maintenance events around 21:40 UTC March 28
- [ ] Check Atlas Performance Advisor for recommendations
- [ ] Check connection pool utilization — are we hitting the 100-connection default?
- [ ] Consider adding query timeouts (`socketTimeoutMS: 2000`) so a single slow query can't block for 3+ seconds
- [ ] Consider caching frequently-accessed User data (more complex than apps — per-user, frequent writes)

**Tools available:** MongoDB Atlas API key in `.env`, `mongosh` installed

---

### 4. SDK Auth Still Hits Database

**Status:** ❌ Known tradeoff
**Severity:** 🟡 Medium — 64 slow `apps.findOne` queries in 30 min from SDK auth

We intentionally reverted SDK auth to always use DB (not the app cache) for credential validation because stale hashed API keys are a security hole. But this means every SDK API call from every app still does a MongoDB round-trip.

**Options to investigate:**

- [ ] Short-TTL cache specifically for SDK auth (30 seconds? with immediate invalidation on key rotation)
- [ ] Or accept the latency and focus on reducing User query frequency instead

---

## Suspects (need proof)

### 5. Bun Runtime Memory Issues

**Status:** ❌ Not actionable yet
**Severity:** 🟡 Medium — RSS still grows even with app cache, just slower

**Evidence:**

- Multiple open Bun GitHub issues about RSS growing monotonically (bmalloc slabs never returned, JSC GC leaks)
- RSS grows from 260MB to 800MB+ over 1-2 hours with 80 sessions
- GC probes show 0 MB freed — GC can't collect anything because it's all live objects OR bmalloc retains the pages
- Claude Code and other Bun users report identical symptoms

**What we DON'T know:**

- How much of the RSS growth is Bun runtime overhead vs actual application objects
- Whether upgrading Bun would help (we're on latest 1.3.11)
- Whether `Bun.gc(true)` probes are making things worse or helping

**What needs to happen:**

- [ ] Monitor RSS growth rate over multiple crash cycles with the new diagnostics
- [ ] Compare RSS growth with and without the GC probe (could disable via env var)
- [ ] Watch for Bun 1.4+ releases with memory fixes

---

### 6. MongoDB Callback Storms

**Status:** ❌ Theory, not proven
**Severity:** 🟡 Medium

**Theory:** When MongoDB is slow for a few seconds and then responds to many queued queries simultaneously, their callbacks execute back-to-back synchronously, creating a mini event loop freeze.

**Evidence:** The 3.4s gap had multiple slow queries resolving at the same timestamp (21:40:27.970 and 21:40:27.991 — 21ms apart). But this could also just be coincidence.

**What needs to happen:**

- [ ] Monitor for more event loop gaps and correlate with slow query clusters
- [ ] The bstack CLI makes this easy: `bstack gaps` + `bstack sql` for cross-referencing

---

## Infrastructure Improvements (not blocking, but valuable)

### 7. Per-Region Uptime Monitors

**Status:** ❌ Not set up
**Severity:** 🟢 Low — would improve visibility

Currently only `prod.augmentos.cloud/health` is monitored (goes through Cloudflare LB to one region). If France crashes but US Central is up, we don't get an alert.

**What needs to happen:**

- [ ] Add BetterStack uptime monitors for each region's direct health URL
- [ ] Alert thresholds: keyword "status":"ok", 60s interval, 10s confirmation

---

### 8. BetterStack Dashboard Alerts

**Status:** ❌ Not set up
**Severity:** 🟡 Medium — proactive alerting instead of reactive investigation

**What needs to happen:**

- [ ] Alert when container RSS > 800MB (from collector metrics)
- [ ] Alert when `container_restarts_total` increases (crash, not deploy)
- [ ] Alert when `event-loop-gap` log count > 0 in a 5-minute window
- [ ] Alert when `opBudgetUsedPct` > 50 sustained for 5 minutes

---

### 9. SRE Dashboards for All Regions

**Status:** ❌ Only US Central has a dashboard
**Severity:** 🟢 Low — collector data is flowing, just no charts

**What needs to happen:**

- [ ] Build dashboards for France (source 2326580), East Asia (2326583), US West (2326586), US East (2326589)
- [ ] Same chart layout as US Central (973977): RSS, CPU, restarts, OOM, HTTP, TCP

---

### 10. Mobile Client Reconnect Improvements

**Status:** ❌ Not started
**Severity:** 🟡 Medium — users experience 5-30s disconnections

**What needs to happen:**

- [ ] Detect REST 503 ("session not found") as a signal to reconnect WebSocket immediately
- [ ] Shorter application-level ping interval (currently 30s? could be 10s)
- [ ] Reconnect to region-specific URL instead of going through LB

---

### 11. `MEMORY_TELEMETRY_ENABLED` Still Not Flipped

**Status:** ❌ Outstanding since 057
**Severity:** 🟢 Low — would show per-session memory breakdown every 10 min

**What needs to happen:**

- [ ] Set `MEMORY_TELEMETRY_ENABLED=true` in Doppler prod base config
- [ ] Zero code change — just the env var

---

### 12. Cherry-Pick Hotfixes into Dev

**Status:** ❌ Dev branch is behind main
**Severity:** 🟡 Medium — dev will diverge further

**What needs to happen:**

- [ ] Cherry-pick or merge main into dev to get 061, 062, 063 hotfixes
- [ ] PR #2327 already merged 057+058 into dev, but 062 and 063 are not there

---

## Tools & Access Inventory

Available for investigation in the next session:

| Tool                       | Access                                       | What it enables                                                             |
| -------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| BetterStack SQL API        | ClickHouse credentials in `.env`             | Query all logs and metrics                                                  |
| BetterStack Management API | API token in `.env`                          | Uptime monitors, sources, dashboards                                        |
| MongoDB Atlas API          | Atlas API keys in `.env`                     | Cluster health, slow query logs, Performance Advisor, connection pool stats |
| Cloudflare API             | LB API token in `.env`                       | Load balancer config, pool health, DNS                                      |
| Doppler CLI                | Authenticated                                | Env var management across all regions                                       |
| Porter CLI                 | Authenticated                                | Cluster/pod management                                                      |
| GitHub CLI                 | Authenticated                                | PRs, issues, deployments                                                    |
| `mongosh`                  | Installed, connection string in Doppler      | Direct MongoDB queries, explain plans                                       |
| `bstack` CLI               | Built at `cloud/tools/bstack/`               | Pre-built SRE queries against BetterStack                                   |
| `analyze-heap.ts`          | Built at `cloud/packages/cloud/src/scripts/` | Live memory tracking, snapshot analysis                                     |

---

## Priority Order

| #   | Item                                        | Effort                 | Impact                                                                 |
| --- | ------------------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| 1   | Cloudflare LB domain fix (#1)               | Small (config)         | 🔴 Distributes traffic, reduces US Central load from 82 → ~30 sessions |
| 2   | MongoDB Atlas investigation (#3)            | Small (API queries)    | 🔴 Understand why queries spike to 3.4s                                |
| 3   | France/East Asia redeploy (#2)              | Tiny                   | 🟡 Gets them on correct BetterStack source                             |
| 4   | Query timeout + connection pool tuning (#3) | Small (config)         | 🟡 Prevents 3+ second query blocks                                     |
| 5   | Per-region uptime monitors (#7)             | Small                  | 🟡 Catches regional outages                                            |
| 6   | Dashboard alerts (#8)                       | Medium                 | 🟡 Proactive crash detection                                           |
| 7   | Cherry-pick to dev (#12)                    | Small                  | 🟡 Keeps branches in sync                                              |
| 8   | Memory telemetry (#11)                      | Tiny                   | 🟢 Better memory diagnostics                                           |
| 9   | Multi-region dashboards (#9)                | Medium                 | 🟢 Visual monitoring for all regions                                   |
| 10  | Mobile reconnect (#10)                      | Medium (mobile change) | 🟡 User experience                                                     |
| 11  | SDK auth caching (#4)                       | Medium                 | 🟡 Reduces DB round-trips                                              |
| 12  | Bun runtime monitoring (#5)                 | Ongoing                | 🟢 Long-term tracking                                                  |

---

## What We Shipped (March 27-28)

For reference — everything that was implemented and deployed:

| Issue | What                                                                    | Status     |
| ----- | ----------------------------------------------------------------------- | ---------- |
| 058   | Doppler migration — all 8 apps on 5 clusters                            | ✅ Shipped |
| 058   | BetterStack Collectors on all 5 clusters                                | ✅ Shipped |
| 058   | REGION env var on all Doppler configs                                   | ✅ Shipped |
| 058   | UDP_HOST changed to DNS hostnames                                       | ✅ Shipped |
| 058   | BetterStack prod log source switched in Doppler                         | ✅ Shipped |
| 058   | Cloudflare session affinity disabled (23hr cookie)                      | ✅ Shipped |
| 058   | Cloudflare failover_across_pools enabled                                | ✅ Shipped |
| 061   | GC probe (60s forced GC with timing)                                    | ✅ Shipped |
| 061   | Health check timing (warn >50ms)                                        | ✅ Shipped |
| 061   | Soniox send timing (warn >50ms)                                         | ✅ Shipped |
| 061   | Connection counting in vitals                                           | ✅ Shipped |
| 061   | MongoDB slow query plugin                                               | ✅ Shipped |
| 061   | GC on session disconnect (rate-limited)                                 | ✅ Shipped |
| 062   | Event loop gap detector                                                 | ✅ Shipped |
| 062   | Cumulative MongoDB blocking metric                                      | ✅ Shipped |
| 062   | In-memory app cache (30s refresh, 9 hot paths)                          | ✅ Shipped |
| 062   | Write-through cache invalidation (18 write paths)                       | ✅ Shipped |
| 062   | Hot path operation timing (audio, messages, display)                    | ✅ Shipped |
| 063   | Graceful shutdown on SIGTERM                                            | ✅ Shipped |
| 063   | WebSocket close frames on deploy (1001 Going Away)                      | ✅ Shipped |
| 063   | Global drain middleware (503 during shutdown)                           | ✅ Shipped |
| 063   | 2s drain delay for close frame flush                                    | ✅ Shipped |
| 064   | bstack CLI tool                                                         | ✅ Built   |
| 064   | BetterStack config.ts (complete resource inventory)                     | ✅ Built   |
| —     | SRE Dashboard for US Central (10 charts)                                | ✅ Built   |
| —     | Stale env var fixes (ADMIN_EMAILS, ADDITIONAL_PRE_INSTALLED_APPS, etc.) | ✅ Shipped |
| —     | OPEN_WEATHER_API_KEY added to all Doppler configs                       | ✅ Shipped |
| —     | R2\_\* vars added to all Doppler configs                                | ✅ Shipped |

## Next Session

1. Use MongoDB Atlas API to investigate the 3.4s query spike
2. Use Cloudflare API to audit both LB configs (mentra.glass vs mentraglass.com)
3. Use bstack CLI for ongoing prod monitoring
4. Create individual issues for top-priority items
5. Write runbooks based on incidents we've handled
