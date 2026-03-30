# Spike: Observability Hygiene — Weekly Error Audit SOP, Log Noise Reduction, Error Classification

## Overview

**What this doc covers:** A standard operating procedure for maintaining observability health — weekly error audits, log noise reduction, error/warn classification standards, and alerting for critical errors. This isn't just about what we measure; it's about what we don't measure, what we measure too much of, and how we turn observability data into actionable improvements.
**Why this doc exists:** We literally crashed our servers by producing too many logs (issue 067 — the `@logtail/pino` transport couldn't keep up with 6,000-10,000 logs/minute). Even after fixing the transport, the volume itself is a problem: BetterStack costs, query performance, and most importantly — signal drowns in noise. When everything is an error, nothing is an error. When we investigated crashes, we had to wade through thousands of "expected" errors (503s, "session not found", "DisplayManager not ready") to find the one that mattered (ResourceTracker throw, Soniox timeout). Every noisy log is a tax on incident response time.
**Who should read this:** Everyone on the cloud team. This is a team practice, not a one-time fix.

---

## Background

### What we learned the hard way

| Issue | What happened                      | Root cause                                                                                                   |
| ----- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 067   | Server crashes every 30-45 minutes | `@logtail/pino` transport couldn't drain 100-170 logs/sec → unbounded heap growth                            |
| 068   | Exit-code-1 cascading crashes      | `ResourceTracker.track()` threw an unhandled error — buried under thousands of "expected" errors in the logs |
| 070   | Exit-code-1 crash after 3h45m      | Soniox WebSocket timeout rejection unhandled — one error in a sea of noise                                   |

In every case, the signal (the actual crash cause) was hidden by noise (thousands of expected-edge-case errors logged at `error` level).

### The current state of our logs

From a 30-minute window on US Central with 80 sessions (sampled March 29):

| Log level | Volume     | What's in it                                                                                          |
| --------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| `info`    | ~5,000/min | Display updates, audio stats, device state, HTTP 200s, vitals, pings                                  |
| `warn`    | ~200/min   | "DisplayManager not ready", "session not found", DashboardManager spam                                |
| `error`   | ~50/min    | HTTP 503s (expected during reconnect), "User session not found for app message", Soniox stream errors |

The `error` level logs are mostly NOT errors — they're expected edge cases during the normal disconnect/reconnect cycle. A real error (unhandled rejection, crash-causing bug) looks identical to the "expected" ones.

---

## The Three Problems

### Problem 1: No alerting on critical errors

The global `unhandledRejection` handler (issue 070) logs with `feature: "unhandled-rejection"`. But nobody gets notified. It sits in BetterStack until someone manually searches for it. Same for any new crash pattern — we only find out when users complain or BetterStack Uptime fires.

**What we need:** BetterStack alerts for:

- `feature="unhandled-rejection"` → immediate Slack notification (this would have crashed the server without the handler)
- Container restart count increasing → pod crashed and restarted
- `feature="event-loop-gap"` → event loop blocked >1 second

### Problem 2: Error/warn levels are meaningless

Everything is `error`. A genuine bug and an expected edge case look the same:

```
ERROR: HTTP 503 POST /api/client/location [0ms]     ← expected: client sent REST before WS connected
ERROR: User session not found for app message         ← expected: app reconnecting after session dispose
ERROR: Cannot track resources on a disposed tracker   ← BUG: crashes the process
```

**What we need:** A classification standard:

- `error` = **unexpected, actionable, needs investigation.** If you log at error, you're saying "something is broken and someone should look at this." Every error should either be fixed or downgraded.
- `warn` = **expected edge case, handled gracefully, but indicates an architectural gap.** A 503 during reconnect is a warn — it's handled, the client retries, but it hints that the client and server aren't coordinated about session state.
- `info` = **normal operation.** Display updates, successful requests, system vitals.
- `debug` = **detailed troubleshooting data.** Only enabled when investigating a specific issue.

### Problem 3: Log noise costs money and hides signal

6,000-10,000 logs per minute from US Central alone. At 80 sessions, that's 75-125 logs/session/minute. Many of these are:

- DashboardManager sending display requests to sessions that aren't ready (multiple per second per session)
- AudioManager UDP stats every 10 seconds per session
- HTTP request logs for every REST call (location updates every second per user)
- Device state updates on every BLE event

Each of these is individually useful for debugging. But in aggregate, they make it impossible to find the logs that matter.

**What we need:**

- Identify the top 10 noisiest log sources by volume
- For each: is this useful? How often? Can it be rate-limited, sampled, or moved to debug level?
- Set a target: reduce log volume by 50% without losing diagnostic capability

---

## Weekly Error Audit SOP

### When

Every Monday morning (or after every major deploy). Takes 15-30 minutes.

### How

#### Step 1: Check unhandled rejections (30 seconds)

```bash
bstack sql "SELECT dt, JSONExtract(raw, 'message', 'Nullable(String)') as message FROM remote(t373499_mentracloud_prod_logs) WHERE dt >= now() - INTERVAL 7 DAY AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'unhandled-rejection' ORDER BY dt DESC LIMIT 20"
```

**Any results = a bug to fix.** File an issue immediately.

#### Step 2: Top errors by count (2 minutes)

```bash
bstack sql "SELECT JSONExtract(raw, 'service', 'Nullable(String)') as service, JSONExtract(raw, 'level', 'Nullable(String)') as level, substring(JSONExtract(raw, 'message', 'Nullable(String)'), 1, 80) as message, count() as total FROM remote(t373499_mentracloud_prod_logs) WHERE dt >= now() - INTERVAL 7 DAY AND JSONExtract(raw, 'level', 'Nullable(String)') IN ('error', 'fatal') AND JSONExtract(raw, 'region', 'Nullable(String)') = 'us-central' GROUP BY service, level, message ORDER BY total DESC LIMIT 20"
```

For each entry, ask:

- **Is this a real error?** If yes, is there an issue for it?
- **Is this an expected edge case?** If yes, downgrade to `warn` and file a PR.
- **Is this new since last week?** If yes, investigate — new errors after a deploy often indicate a regression.

#### Step 3: Top warnings by count (2 minutes)

Same query but for `warn` level. Look for:

- Anything with >10,000 occurrences per week — that's noise, consider rate-limiting or downgrading to `debug`
- New warning patterns that weren't there last week

#### Step 4: Log volume by service (2 minutes)

```bash
bstack sql "SELECT JSONExtract(raw, 'service', 'Nullable(String)') as service, count() as total FROM remote(t373499_mentracloud_prod_logs) WHERE dt >= now() - INTERVAL 1 DAY AND JSONExtract(raw, 'region', 'Nullable(String)') = 'us-central' GROUP BY service ORDER BY total DESC LIMIT 20"
```

Which services are producing the most logs? Are they all useful? The top 3 services probably account for 80% of log volume.

#### Step 5: Check crash frequency (1 minute)

```bash
bstack incidents --limit 20
```

Compare to last week. Is the crash rate going up or down? Any new patterns?

#### Step 6: Check connection churn (1 minute)

```bash
bstack sql "SELECT toStartOfHour(dt) as hour, sum(JSONExtract(raw, 'wsDisconnects', 'Nullable(Int32)')) as disconnects, sum(JSONExtract(raw, 'wsReconnects', 'Nullable(Int32)')) as reconnects FROM remote(t373499_mentracloud_prod_logs) WHERE dt >= now() - INTERVAL 7 DAY AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals' AND JSONExtract(raw, 'region', 'Nullable(String)') = 'us-central' GROUP BY hour ORDER BY hour DESC LIMIT 48"
```

Is churn getting better or worse? Does it correlate with time of day (peak hours)?

### Output

A short summary posted in Slack (or wherever the team communicates):

```
Weekly Error Audit — March 29, 2026

Unhandled rejections: 0 ✅ (was 2 last week, fixed in 068/070)
Top error: "HTTP 503 POST /api/client/location" — 2,400/week
  → Expected during reconnect. Should be downgraded to warn. PR: #XXXX
New errors: None ✅
Log volume: 8.2M logs/day from US Central
  → Top: DisplayManager (3.1M), hono-http (2.4M), AudioManager (1.2M)
  → DisplayManager is 38% of all logs. Rate-limit candidate.
Crashes: 1 this week (down from 7/day last week) ✅
Churn: ~3 disconnects/min steady, all 1006 (client-side)
```

---

## Immediate Actions

### 1. Set up BetterStack alert for `unhandled-rejection`

Create a BetterStack alert that fires when any log with `feature="unhandled-rejection"` appears. Route to Slack. This is the highest-priority alert — it means a bug that would have crashed the server.

### 2. Downgrade expected-edge-case errors to warn

These are currently `error` but should be `warn`:

| Current error                                                                          | Why it's expected                          | Fix                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------- |
| HTTP 503 on `/api/client/location`, `/api/client/calendar`, `/api/client/device/state` | Client sends REST before WS session exists | Downgrade to `warn` in hono middleware    |
| "User session not found for app message"                                               | App WebSocket reconnects before glasses WS | Downgrade to `warn` in bun-websocket      |
| Soniox SDK stream error (recoverable)                                                  | Soniox API hiccups, retry handles it       | Downgrade to `warn` if retry is scheduled |

### 3. Identify and reduce the noisiest logs

Run the volume-by-service query and target the top 3 for reduction:

- **DashboardManager** — rate-limit "DisplayManager not ready" to once per session per minute instead of every update
- **AudioManager** — UDP audio stats every 10 seconds per session might be too frequent. Consider 30 seconds or 60 seconds.
- **hono-http** — every single HTTP request is logged at `info`. Consider only logging errors and slow requests (>100ms).

### 4. Add a `bstack audit` command

Add a command to the bstack CLI that runs steps 1-6 automatically and produces the summary. Makes the weekly audit a one-command operation:

```bash
bstack audit --duration 7d --region us-central
```

---

## What This Is NOT

This is not a one-time cleanup. It's a practice. Logs accumulate, new features add new log lines, edge cases multiply as the user base grows. Without regular hygiene:

- Signal drowns in noise
- Costs grow linearly with users
- Incident response gets slower
- Real bugs hide behind "expected" errors

The weekly audit is 15-30 minutes. The ROI is: when the next crash happens, you find the cause in the logs in 5 minutes instead of 5 hours.

---

## Conclusions

| Problem                        | Solution                                              | Priority                             |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------ |
| No alerting on critical errors | BetterStack alert for `unhandled-rejection`           | 🔴 High — do this now                |
| Error/warn levels meaningless  | Classification standard + downgrade expected errors   | 🟡 Medium — file PRs this week       |
| Log noise hides signal         | Identify top 3 noisy sources, rate-limit or downgrade | 🟡 Medium — part of weekly audit     |
| No regular audit practice      | Weekly SOP with bstack CLI support                    | 🟢 Ongoing — start this Monday       |
| No `bstack audit` command      | Add to bstack CLI                                     | 🟢 Low — manual queries work for now |
