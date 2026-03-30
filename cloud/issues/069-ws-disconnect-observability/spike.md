# Spike: WebSocket Disconnect Observability — Proving Client-Side Issues with Data

## Overview

**What this doc covers:** Specification for adding diagnostic instrumentation to the cloud server that definitively proves whether WebSocket disconnects are client-initiated or server-initiated. Five new fields on UserSession, three new structured log events (`ws-close`, `ws-reconnect`, `ws-dispose`), and connection churn counters in SystemVitalsLogger. This is the implementation of the observability from issue 066 spec (A1–A8) that was never shipped.
**Why this doc exists:** The team has been told repeatedly that the disconnect churn is a client-side issue. The evidence supports this — 100% of glasses disconnects are code 1006 (client dropped without close frame), some users disconnect 30 times in 42 minutes while others are stable for hours on the same server, and one user has an exact 5-minute disconnect cycle. But we can't prove it definitively because the cloud doesn't log what was happening at the moment of disconnect — was the client silent for 30 seconds before dying, or was it actively communicating? This instrumentation answers that question.
**Who should read this:** Cloud engineers, mobile engineers, anyone investigating connection stability.

**Depends on:**

- [066-ws-disconnect-churn](../066-ws-disconnect-churn/) — original investigation, client audit, BetterStack evidence
- [034-ws-liveness](../034-ws-liveness/) — server app-level pings, client liveness detection (commented out on mobile)
- [035-nginx-ws-timeout](../035-nginx-ws-timeout/) — nginx/Cloudflare timeout fixes

---

## Background

### What we know

From the 066 investigation and today's production data:

1. **100% of glasses WebSocket closes are code 1006** (abnormal — no close frame from client). The server never produces 1006 — it always sends close frames (1000 or 1001).
2. **Some users are extremely unstable** — `kddyqfr5hq@` disconnected 30 times in 42 minutes, all code 1006, session lifetimes of 5-90 seconds.
3. **Some users are perfectly stable** — same server, same code, same region, hours of uptime. The instability is user/device/network-specific.
4. **One user has an exact 5-minute disconnect cycle** — `nikita@` disconnects every 300 seconds with code 1000 (clean close), reconnects 5 seconds later. Something on the client side is deliberately closing the connection.
5. **The client-side liveness monitor is commented out** — the mobile app can't detect dead connections for 30-120 seconds (OS TCP keepalive).
6. **The server sends app-level pings every 2 seconds** — but nobody tracks whether the client responds.

### What we can't prove yet

- Was the client silent (no messages, no pong responses) before each 1006 close?
- How long was the downtime between disconnect and reconnect?
- How many times did each session reconnect during its lifetime?
- What was the previous close code when a session reconnects?
- Does the disconnect rate correlate with any server-side metric (GC, event loop, session count)?

---

## The Evidence Gap

When a glasses WebSocket closes, we currently log:

```json
{"message": "Glasses WebSocket closed", "code": 1006, "reason": "", "userId": "user@example.com"}
```

That tells us WHAT happened (code 1006) but not WHY. We need:

```json
{
  "feature": "ws-close",
  "code": 1006,
  "reason": "",
  "sessionDurationSeconds": 142,
  "reconnectCount": 3,
  "timeSinceLastClientMessage": 34500,
  "timeSinceLastPong": 120000,
  "timeSinceLastAppPong": 34200,
  "message": "Glasses connection closed: code=1006, silent=34500ms, session=142s, reconnects=3"
}
```

If `timeSinceLastClientMessage` is 34,500ms (34 seconds) on a 1006 close, that's proof: **the CLIENT went silent 34 seconds before the connection died.** The server was sending pings every 2 seconds the entire time. The client stopped responding. The connection eventually died from Bun's idle timeout or the OS detecting the dead socket.

If `timeSinceLastClientMessage` were <2 seconds, that would mean the client was actively communicating right before the close — which would point to a server-side issue. But based on everything we've seen, we expect it to be large.

---

## Spec

### A1. New fields on UserSession

**File:** `cloud/packages/cloud/src/services/session/UserSession.ts`

Add alongside existing heartbeat fields:

| Field                   | Type                  | Updated by               | Purpose                                             |
| ----------------------- | --------------------- | ------------------------ | --------------------------------------------------- |
| `reconnectCount`        | `number` (init 0)     | `createOrReconnect()`    | Total reconnections since session creation          |
| `lastCloseCode`         | `number \| undefined` | `handleGlassesClose()`   | Close code from the most recent disconnect          |
| `lastCloseReason`       | `string \| undefined` | `handleGlassesClose()`   | Close reason from the most recent disconnect        |
| `lastClientMessageTime` | `number \| undefined` | `handleGlassesMessage()` | `Date.now()` on every message FROM the client       |
| `lastAppLevelPongTime`  | `number \| undefined` | `handleGlassesMessage()` | `Date.now()` when client responds `{"type":"pong"}` |

### A2. Track `lastClientMessageTime` on every glasses message

**File:** `cloud/packages/cloud/src/services/websocket/bun-websocket.ts`, in `handleGlassesMessage()`

After the `if (!userSession)` guard, before the try block:

```typescript
userSession.lastClientMessageTime = Date.now()
```

Runs on every message — text, binary (audio), ping responses. Single assignment, negligible overhead.

### A3. Track `lastAppLevelPongTime` on client pong

**File:** `cloud/packages/cloud/src/services/websocket/bun-websocket.ts`, in `handleGlassesMessage()`

In the existing `if (parsed.type === "pong")` early-return block:

```typescript
userSession.lastAppLevelPongTime = Date.now()
```

### A4. Structured `ws-close` log event

**File:** `cloud/packages/cloud/src/services/websocket/bun-websocket.ts`, in `handleGlassesClose()`

Replace the existing close log with a structured event that captures connection health at death:

```json
{
  "feature": "ws-close",
  "level": "warn",
  "code": 1006,
  "reason": "",
  "sessionDurationSeconds": 142,
  "reconnectCount": 3,
  "timeSinceLastClientMessage": 34500,
  "timeSinceLastPong": 120000,
  "timeSinceLastAppPong": 34200,
  "message": "Glasses connection closed: code=1006, silent=34500ms, session=142s, reconnects=3"
}
```

Also stash `lastCloseCode` and `lastCloseReason` on the session for the reconnect log.

### A5. Structured `ws-reconnect` log event

**File:** `cloud/packages/cloud/src/services/session/UserSession.ts`, in `createOrReconnect()`

**Before** clearing `disconnectedAt`, compute the downtime and log:

```json
{
  "feature": "ws-reconnect",
  "level": "info",
  "reconnectCount": 4,
  "downtimeMs": 7200,
  "sessionAgeSeconds": 3400,
  "lastCloseCode": 1006,
  "timeSinceLastClientMessage": 41700,
  "timeSinceLastAppPong": 41400,
  "message": "Glasses reconnect #4: downtime=7200ms, lastClose=1006"
}
```

### A6. Structured `ws-dispose` log event

**File:** `cloud/packages/cloud/src/services/session/UserSession.ts`, in `dispose()`

The session lifecycle summary — fires when the grace period expires and the client never came back:

```json
{
  "feature": "ws-dispose",
  "level": "info",
  "sessionDurationSeconds": 142,
  "reconnectCount": 3,
  "lastCloseCode": 1006,
  "timeSinceLastClientMessage": 94500,
  "timeSinceLastAppPong": 94200,
  "disposalReason": "grace_period_timeout",
  "message": "Session disposed: duration=142s, reconnects=3, lastClose=1006, silent=94500ms"
}
```

### A7. Connection churn counters in SystemVitalsLogger

**File:** `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

Add a `ConnectionChurnTracker` class (same pattern as `OperationTimers`):

- `recordDisconnect(closeCode)` — called from `handleGlassesClose()`
- `recordReconnect(downtimeMs)` — called from `createOrReconnect()`
- `getAndReset()` — read every 30s in vitals

New fields in `system-vitals`:

| Field             | Type     | Meaning                                                      |
| ----------------- | -------- | ------------------------------------------------------------ |
| `wsDisconnects`   | `number` | Glasses WS disconnects in the last 30s                       |
| `wsReconnects`    | `number` | Glasses WS reconnects in the last 30s                        |
| `wsAvgDowntimeMs` | `number` | Average downtime between disconnect and reconnect            |
| `wsCloseCodeDist` | `string` | JSON of close code distribution (e.g. `{"1006":5,"1000":2}`) |

---

## How This Proves Client-Side Issues

### Query 1: Show that clients go silent before dying

```sql
SELECT
  dt,
  JSONExtract(raw, 'code', 'Nullable(Int32)') AS code,
  JSONExtract(raw, 'timeSinceLastClientMessage', 'Nullable(Int64)') AS silent_ms,
  JSONExtract(raw, 'timeSinceLastAppPong', 'Nullable(Int64)') AS pong_stale_ms,
  JSONExtract(raw, 'sessionDurationSeconds', 'Nullable(Int32)') AS session_s,
  JSONExtract(raw, 'reconnectCount', 'Nullable(Int32)') AS reconnects
FROM remote(t373499_mentracloud_prod_logs)
WHERE dt >= now() - INTERVAL 1 HOUR
  AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'ws-close'
  AND JSONExtract(raw, 'code', 'Nullable(Int32)') = 1006
ORDER BY silent_ms DESC
LIMIT 50
```

**Expected:** `silent_ms` will be 10,000-120,000ms (10 seconds to 2 minutes) on every 1006 close. The client stopped sending messages AND stopped responding to our pings long before the connection died. The server was actively sending pings the whole time.

**If client-side:** `silent_ms > 10000` and `pong_stale_ms > 10000`
**If server-side:** `silent_ms < 2000` and `pong_stale_ms < 4000`

### Query 2: Show the churn rate over time

```sql
SELECT
  toStartOfFiveMinutes(dt) AS period,
  max(JSONExtract(raw, 'wsDisconnects', 'Nullable(Int32)')) AS disconnects,
  max(JSONExtract(raw, 'wsReconnects', 'Nullable(Int32)')) AS reconnects,
  max(JSONExtract(raw, 'wsCloseCodeDist', 'Nullable(String)')) AS close_codes,
  max(JSONExtract(raw, 'activeSessions', 'Nullable(Int32)')) AS sessions
FROM remote(t373499_mentracloud_prod_logs)
WHERE dt >= now() - INTERVAL 6 HOUR
  AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals'
  AND JSONExtract(raw, 'region', 'Nullable(String)') = 'us-central'
ORDER BY period DESC
```

### Query 3: Identify the worst churners

```sql
SELECT
  JSONExtract(raw, 'userId', 'Nullable(String)') AS userId,
  count() AS disconnects,
  avg(JSONExtract(raw, 'timeSinceLastClientMessage', 'Nullable(Int64)')) AS avg_silent_ms,
  avg(JSONExtract(raw, 'sessionDurationSeconds', 'Nullable(Int32)')) AS avg_session_s
FROM remote(t373499_mentracloud_prod_logs)
WHERE dt >= now() - INTERVAL 1 HOUR
  AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'ws-close'
GROUP BY userId
ORDER BY disconnects DESC
LIMIT 20
```

### Query 4: Show stable vs unstable users on the same server

```sql
-- Stable users: sessions > 30 minutes, 0 reconnects
SELECT userId, sessionDurationSeconds, reconnectCount
WHERE feature = 'ws-dispose' AND sessionDurationSeconds > 1800 AND reconnectCount = 0

-- Unstable users: sessions < 2 minutes, 5+ reconnects
SELECT userId, sessionDurationSeconds, reconnectCount
WHERE feature = 'ws-dispose' AND sessionDurationSeconds < 120 AND reconnectCount > 5
```

Same server, same code, same time window. The difference is the client/network, not the server.

---

## What This Does NOT Include

| Out of scope                             | Why                                                      |
| ---------------------------------------- | -------------------------------------------------------- |
| Enabling the client liveness monitor     | Mobile release — separate issue                          |
| Adding exponential backoff to the client | Mobile release — separate issue                          |
| Changing any timeout values              | Behavioral change — needs its own spec                   |
| Fixing the disconnect root cause         | This is diagnostic only — we need data before we can fix |

---

## Conclusions

| What we have today               | What this adds                                                             |
| -------------------------------- | -------------------------------------------------------------------------- |
| Close code (1006 vs 1000)        | How long the client was silent before the close                            |
| That disconnects happen          | How many reconnects per session lifetime                                   |
| That some users churn            | The exact downtime gap between disconnect and reconnect                    |
| That the server reconnects users | Whether the client was responding to pings before dying                    |
| Nothing at dispose time          | Full session lifecycle summary (duration, reconnects, last close, silence) |
| Current session count in vitals  | Disconnect/reconnect RATE per 30s window with close code distribution      |

With this instrumentation deployed, every `ws-close` event becomes an undeniable record: "The server sent pings every 2 seconds. The client's last message was 34 seconds ago. The client's last pong was 34 seconds ago. The connection died with code 1006 (no close frame from client). This is a client-side network failure."

---

## Next Steps

1. Implement A1–A7 on this branch
2. Deploy to cloud-debug, verify logs appear with correct fields
3. Deploy to all regions via hotfix to main
4. Collect 24 hours of data
5. Build the evidence report showing `timeSinceLastClientMessage` distribution for 1006 closes
6. Present to the team with BetterStack queries
