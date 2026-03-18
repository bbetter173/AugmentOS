# Spike: Reconnection & Session Architecture

**Issue:** 048
**Related:** [SDK v3 spike](./spike.md), [client SDK spike](./client-sdk-spike.md)
**Status:** Spike
**Date:** 2026-03-17

---

## Overview

**What this doc covers:** The full reconnection, resurrection, and session identity architecture — what it is today, why it breaks, and what v3 should do instead. Also covers the multi-cloud problem, session ID identity, and the userId/email confusion.

**Why this matters:** The reconnection/resurrection system has been the single largest source of recurring bugs for nearly a year. Subscriptions disappear, sessions leak memory, apps can't distinguish fresh starts from resurrections, and multi-cloud handoffs cause ghost sessions. V3 is the one chance to fix this properly.

**Scope:** Both SDK-side and cloud-side changes. The new system must work alongside v2 SDKs (backward compat) while enabling clean behavior for v3 SDKs.

---

## Current Architecture

### The State Machine

Cloud-side `AppSession` has 7 states:

```
CONNECTING ──→ RUNNING ──→ GRACE_PERIOD ──→ RESURRECTING ──→ RUNNING (restarted)
                  │              │
                  │              ├──→ DORMANT (user not connected)
                  │              │
                  │              └──→ STOPPED (resurrection failed)
                  │
                  └──→ STOPPING ──→ STOPPED
```

**State definitions:**

| State          | Meaning                                                                                             | Duration                                  |
| -------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `CONNECTING`   | Webhook sent to app server, waiting for WebSocket connection                                        | Until SDK connects or timeout             |
| `RUNNING`      | Active WebSocket connection between SDK and cloud                                                   | Indefinite                                |
| `GRACE_PERIOD` | WebSocket disconnected, waiting for SDK to reconnect                                                | 5 seconds (`GRACE_PERIOD_MS`)             |
| `RESURRECTING` | Grace period expired, cloud is calling stop+start on the app                                        | During webhook calls                      |
| `DORMANT`      | Grace period expired but user's glasses aren't connected — can't resurrect, wait for user to return | Until user reconnects or session disposes |
| `STOPPING`     | User or system initiated stop in progress                                                           | During stop webhook                       |
| `STOPPED`      | Fully stopped, can be restarted                                                                     | Terminal                                  |

### What Happens on Disconnect (Cloud Side)

When the mini app's WebSocket disconnects, `AppSession.handleDisconnect()` runs:

1. Clear heartbeat, null out WebSocket reference
2. If state is `STOPPING` → go to `STOPPED` (expected disconnect)
3. If `ownershipReleased` → go to `DORMANT` (clean handoff to another cloud)
4. Otherwise → go to `GRACE_PERIOD`, start 5s timer

When the 5s grace timer fires (`handleAppSessionGracePeriodExpired`):

1. Check if the user's glasses WebSocket is still connected to THIS cloud
2. If user not connected → go to `DORMANT` (user probably switched clouds)
3. If user connected → attempt resurrection:
   a. Call `stopApp(packageName)` — sends stop webhook, cleans up session
   b. Call `startApp(packageName)` — sends start webhook, creates new AppSession
   c. If start fails → `STOPPED`, notify mobile
4. The app server receives stop webhook then start webhook — from its perspective, this looks identical to a fresh start

### What Happens on Disconnect (SDK Side)

When the WebSocket closes, `AppSession` close handler runs:

1. Categorize the closure:
   - Normal closure (1000, 1001, 1008) or "App stopped" → don't reconnect
   - "User session ended" → set `terminated = true`, don't reconnect ever
   - Everything else → call `handleReconnection()`

2. `handleReconnection()`:
   - Check `terminated`, `autoReconnect`, `sessionId` gates
   - Exponential backoff: `delay = baseDelay * 2^attempts` (base: 1000ms)
   - Default max attempts: 3
   - Calls `this.connect(this.sessionId)` — full reconnection flow
   - On success: reset attempts to 0
   - On final failure: emit `disconnected` with `permanent: true`

3. On successful reconnect:
   - Sends `CONNECTION_INIT` (same as a fresh start)
   - Cloud creates or reuses AppSession
   - SDK sends `SUBSCRIPTION_UPDATE` with current subscriptions
   - But: Bug 007 — first subscription update is often empty
   - Cloud has 8s `SUBSCRIPTION_GRACE_MS` to ignore empty updates after reconnect

### Subscription Ownership

Subscriptions are tracked in three places:

1. **SDK `EventManager.getRegisteredStreams()`** — derived from which handlers the developer registered. This is the "source of truth" for what the app WANTS.

2. **Cloud `AppSession._subscriptions`** — the cloud's record of what the app is subscribed to. This is the "source of truth" for what data gets routed.

3. **Cloud `SubscriptionManager`** — aggregation layer that queries across all AppSessions. No cache (removed to prevent drift), computes on demand.

On reconnect, the SDK re-derives subscriptions from handlers and sends them. If the handlers haven't changed, the subscriptions should be the same. But the `CONNECTION_INIT` → `SUBSCRIPTION_UPDATE` sequence has a window where the cloud's AppSession has zero subscriptions (the old ones were cleared, the new ones haven't arrived yet).

The `SUBSCRIPTION_GRACE_MS = 8000` hack: if an empty subscription update arrives within 8s of a reconnect, the cloud ignores it. This prevents the "subscriptions disappeared" bug but is a timing-based heuristic, not a real fix.

### Session Identity

**`sessionId` format:** `{userId}-{packageName}` (e.g., `isaiahballah@gmail.com-com.mentra.captions`)

This is NOT unique per session instance. If the same user runs the same app on a different cloud (or after a resurrection), the `sessionId` is identical. This causes:

- Cloud B creates an AppSession with the same `sessionId` as Cloud A's
- Cloud A's AppSession becomes orphaned — the WebSocket may still exist but no events flow to it
- Memory leak: the old AppSession on Cloud A is never cleaned up until the UserSession disposes

**`userId` is actually email:** Throughout the SDK and cloud, `userId` is the user's email address, not a database ID. This works today but breaks when:

- Users log in via WeChat (China launch) — no email
- Users log in via phone number / WhatsApp — no email
- Email changes — the "user ID" changes, which breaks everything that uses it as a stable identifier

---

## The Bugs This Architecture Has Caused

### 1. Subscription loss on reconnect

**Symptom:** After a network blip, the app reconnects but stops receiving transcription/notification/location data.

**Root cause:** The SDK sends `CONNECTION_INIT` (which the cloud treats as a fresh connection) followed by `SUBSCRIPTION_UPDATE`. There's a window between these two messages where the AppSession has zero subscriptions. If any data arrives during this window, it's dropped. If the subscription update is empty (Bug 007), the 8s grace hack may or may not catch it depending on timing.

**Frequency:** Has occurred repeatedly over the past year. Each occurrence is subtle — the app "works" but silently stops receiving data.

### 2. Resurrection destroys app context

**Symptom:** After a brief network blip, the app's `onSession` is called again with a fresh session. All in-memory state is lost. The developer's handlers are re-registered but any accumulated state (conversation history, user preferences loaded from DB, running timers) is gone.

**Root cause:** Resurrection calls `stopApp()` then `startApp()`. This sends stop webhook + start webhook to the app server. The app server's `onStop` fires, cleaning up the session. Then `onSession` fires with a brand new session. The app can't tell this happened because of a network blip vs. the user actually stopping and restarting the app.

**Impact:** Developers have to build their own state persistence in `onStop` and state restoration in `onSession` to survive resurrections. Most don't, and their apps break silently.

### 3. Timing race between SDK backoff and cloud grace period

**Symptom:** SDK is still trying to reconnect but the cloud has already resurrected the app.

**Root cause:** SDK uses exponential backoff (1s, 2s, 4s). Cloud grace period is 5s. The third reconnection attempt starts at t=3s (1+2) but the actual connection attempt takes time. If it takes >2s to establish, the cloud's 5s timer has fired and resurrection is in progress. The SDK's reconnect succeeds but to a session that's being torn down.

**Impact:** Race condition that's hard to reproduce and harder to debug.

### 4. Multi-cloud ghost sessions

**Symptom:** After switching clouds, the old cloud holds stale AppSessions with dead WebSockets. Memory grows, events flow nowhere.

**Root cause:** When a user switches from Cloud A to Cloud B:

- Cloud B sees `runningApps` in the shared DB, starts those apps
- Mini apps connect to Cloud B (new webhook, new WebSocket)
- Cloud A's WebSocket to the mini app dies (or is replaced silently)
- Cloud A checks glasses WebSocket — also dead (user switched)
- Cloud A marks apps as DORMANT
- But the AppSession objects on Cloud A are never cleaned up until the UserSession disposes (which may not happen for a long time if the cloud doesn't know the user left)

The `sessionId` is `email-packageName` — not unique per cloud. So Cloud B creates a session with the same ID that Cloud A has. No conflict detection.

### 5. userId is email — breaks non-email login

**Symptom:** Not a bug yet, but will be when China launches with WeChat/phone login.

**Root cause:** `userId` throughout the entire system is the user's email address. It's used as:

- The key in `UserSession.sessions` map
- Part of the `sessionId` format
- The identifier passed to the SDK in `onSession(session, sessionId, userId)`
- The identifier stored in `user.runningApps`
- The auth token subject

When a user doesn't have an email (WeChat login), the entire identity system breaks.

---

## Proposed V3 Architecture

### Core Principle: Separate Transport State from Session State

The fundamental change: **a WebSocket disconnect does NOT mean the app session is dead.** The app server process is still running. Its state is in memory. Only the transport layer dropped.

```
v2 (current):
  WebSocket drops → "app might be dead" → 5s grace → resurrection (destroy everything)

v3 (proposed):
  WebSocket drops → "transport blip" → hold session alive → SDK reconnects → resume
```

### SDK Version in CONNECTION_INIT

The SDK sends its version when connecting:

```typescript
// v3 SDK sends:
{
  type: "connection_init",
  packageName: "com.example.app",
  sessionId: "...",
  apiKey: "...",
  sdkVersion: "3.0.0"    // NEW — cloud reads this
}
```

The cloud stores `sdkVersion` on the AppSession. This is the switch:

- `sdkVersion` missing or `< 3.0.0` → legacy behavior (current resurrection model)
- `sdkVersion >= 3.0.0` → new reconnection model

v2 SDKs don't send `sdkVersion`, so the cloud defaults to legacy. Zero breaking change.

### New Connection Flow (v3 SDK)

#### First connection (fresh start)

```
SDK                                    Cloud
 │                                       │
 │──── CONNECTION_INIT ────────────────→ │
 │     { sdkVersion: "3.0.0", ... }      │
 │                                       │ Creates AppSession
 │                                       │ Stores sdkVersion
 │← ── CONNECTION_ACK ────────────────── │
 │     { sessionToken: "unique-abc" }    │  ← NEW: unique session token
 │                                       │
 │──── SUBSCRIPTION_UPDATE ────────────→ │
 │     { subscriptions: [...] }          │ Stores subscriptions
 │                                       │
 │←─── DataStream, events, etc. ───────→ │
```

**`sessionToken`** is a new concept: a unique, opaque token generated by the cloud for THIS specific session instance. It's NOT the `sessionId` (which is `email-packageName`). It's a UUID that identifies this exact connection. The SDK stores it and uses it for reconnection.

#### Reconnection (transport blip)

```
SDK                                    Cloud
 │                                       │
 │  (WebSocket drops)                    │  AppSession → TRANSPORT_DOWN
 │                                       │  (NOT grace period, NOT resurrection)
 │                                       │  Hold session alive, keep subscriptions
 │                                       │  Buffer events (optional, bounded)
 │                                       │
 │──── RECONNECT ──────────────────────→ │  ← NEW message type
 │     { sessionToken: "unique-abc" }    │
 │                                       │  Validates token
 │                                       │  Matches to existing AppSession
 │                                       │  AppSession → RUNNING
 │                                       │
 │← ── RECONNECT_ACK ─────────────────── │
 │     { subscriptions: [...],           │  Cloud tells SDK what state it has
 │       sessionToken: "unique-abc" }    │
 │                                       │
 │  SDK verifies local state matches     │
 │  If mismatch → sends SUBSCRIPTION_UPDATE
 │                                       │
 │←─── DataStream, events resume ──────→ │
```

**Key differences from v2:**

1. **New message: `RECONNECT`** — not `CONNECTION_INIT`. Tells the cloud "I'm the same app, resuming my session." Contains the `sessionToken` from the original `CONNECTION_ACK`.

2. **No resurrection.** The cloud holds the AppSession alive with all subscriptions intact. No stop+start webhook. No `onSession` called again. No state lost.

3. **`RECONNECT_ACK` includes current state.** The SDK can verify that its local subscriptions match what the cloud has. If they drifted (shouldn't happen but defensive), the SDK sends an update.

4. **No subscription gap.** Subscriptions are never cleared. The cloud kept them during the disconnect. Data resumes immediately.

5. **Immediate reconnection.** No exponential backoff. The SDK reconnects as fast as possible — try every 1-2 seconds. The cloud is holding the session alive and waiting.

#### Clean disconnect

```
SDK                                    Cloud
 │                                       │
 │──── OWNERSHIP_RELEASE ──────────────→ │  (already exists in v2)
 │     { reason: "app stopping" }        │
 │                                       │  AppSession → STOPPED
 │  (WebSocket closes)                   │  Clean up, remove from maps
 │                                       │  Do NOT hold session, do NOT resurrect
```

No change from v2 here. `OWNERSHIP_RELEASE` is already the "I'm intentionally disconnecting" signal.

### New State Machine (v3 apps)

```
CONNECTING ──→ RUNNING ──→ TRANSPORT_DOWN ──→ RUNNING (reconnected)
                  │              │
                  │              └──→ SESSION_EXPIRED (hold timeout exceeded)
                  │                         │
                  │                         └──→ STOPPED
                  │
                  └──→ STOPPING ──→ STOPPED
```

**State changes from v2:**

| v2 State       | v3 State          | Change                                                                      |
| -------------- | ----------------- | --------------------------------------------------------------------------- |
| `GRACE_PERIOD` | `TRANSPORT_DOWN`  | Renamed. No 5s timer. Session held alive indefinitely (up to hold timeout). |
| `RESURRECTING` | (removed)         | No resurrection for v3 apps.                                                |
| `DORMANT`      | (removed for v3)  | Replaced by `SESSION_EXPIRED`.                                              |
| (new)          | `TRANSPORT_DOWN`  | WebSocket dropped, session alive, waiting for `RECONNECT`.                  |
| (new)          | `SESSION_EXPIRED` | Hold timeout exceeded. Session cleaned up. App must fresh-start.            |

**Hold timeout:** How long the cloud holds a session alive after transport disconnect. This should be long — 60 seconds? 120 seconds? The app server process is still running; it just lost the WebSocket. Most network blips resolve in <10s. Even a cloud restart + DNS propagation is usually <30s.

The hold timeout is configurable per-deployment. For cloud-debug (dev), maybe 30s. For production, 120s.

### Backward Compatibility (v2 SDKs)

v2 SDKs don't send `sdkVersion` in `CONNECTION_INIT` and don't know about `RECONNECT`. They use the current `CONNECTION_INIT` + exponential backoff + `SUBSCRIPTION_UPDATE` flow.

The cloud handles this:

```typescript
// In handleAppInit:
if (!sdkVersion || semver.lt(sdkVersion, "3.0.0")) {
  // Legacy behavior: 5s grace → resurrection
  appSession.setReconnectionMode("legacy")
} else {
  // v3 behavior: hold session, wait for RECONNECT
  appSession.setReconnectionMode("hold")
}
```

When a legacy-mode AppSession disconnects, the current behavior runs unchanged: 5s grace period → resurrection. When a hold-mode AppSession disconnects, the new behavior runs: `TRANSPORT_DOWN` → hold → wait for `RECONNECT`.

Both modes coexist on the same cloud. A user can have one v2 app and one v3 app running simultaneously with different reconnection behaviors.

### Multi-Cloud

The `sessionToken` helps with multi-cloud:

- Cloud A issues `sessionToken: "abc"` to the SDK
- User switches to Cloud B
- Cloud B starts the app, issues `sessionToken: "def"` (different token)
- SDK is now connected to Cloud B with token "def"
- If Cloud A's WebSocket dies, Cloud A holds the session in `TRANSPORT_DOWN`
- The SDK does NOT try to reconnect to Cloud A (it has a new connection to Cloud B)
- Cloud A's hold timeout expires → `SESSION_EXPIRED` → cleanup

The `sessionToken` is per-cloud-instance, per-session. It's NOT stored in the shared DB. It only exists in memory on the cloud that issued it. So Cloud B can't accidentally match Cloud A's token.

For the SDK: when it receives a new `CONNECTION_ACK` (from Cloud B), it replaces its stored `sessionToken`. It will only send `RECONNECT` with the most recent token. Old tokens are forgotten.

### Session Identity — Kill sessionId, Use sessionToken

**Current `sessionId`:** `{email}-{packageName}` — not unique per session instance, reused across clouds and resurrections.

**Proposed:**

- `sessionToken` (UUID, unique per cloud per session instance) replaces `sessionId` for reconnection and identity purposes
- The concept of `sessionId` as `email-packageName` can remain for logging/debugging but is NOT used for session matching or reconnection
- If we keep `sessionId` at all, it should be a true UUID generated per session, not derived from email+package

### User Identity — userId vs email

**Current:** `session.userId === "isaiahballah@gmail.com"` (it's the email)

**Proposed for v3:**

```typescript
// v3 MentraSession
session.userId // MongoDB _id (stable, unique, never changes)
session.email // string | undefined (optional — WeChat users may not have one)
```

**Cloud-side changes needed:**

- `UserSession.sessions` map key: currently email, should be MongoDB `_id`
- `sessionId` format: currently `{email}-{packageName}`, should use `_id`
- Auth tokens: include both `_id` and `email` in the JWT payload
- Database queries: most already use `email` for lookup, need to also support `_id` lookup

**SDK-side changes:**

- `CONNECTION_ACK` includes both `userId` (the `_id`) and `email`
- `session.userId` returns the `_id`
- `session.email` returns the email (optional)
- v2 compat: `AppServer` shim still passes email as `userId` to `onSession(session, sessionId, userId)` for backward compat

**Migration path:**

- The cloud already has MongoDB `_id` on every user document
- Add `_id` to the JWT payload alongside `email`
- Cloud starts accepting both `_id` and `email` for user lookup
- v3 SDK uses `_id`, v2 SDK continues using `email`
- Eventually (v4?), deprecate email-based lookup

---

## What Changes Where

### Cloud: AppSession

- Add `sdkVersion` field (from `CONNECTION_INIT`)
- Add `reconnectionMode: "legacy" | "hold"` (derived from `sdkVersion`)
- Add `sessionToken` field (UUID, generated on creation)
- Add `TRANSPORT_DOWN` state (replaces `GRACE_PERIOD` for hold-mode sessions)
- Add `SESSION_EXPIRED` state (replaces `DORMANT` for hold-mode sessions)
- Add configurable hold timeout (replaces hardcoded 5s `GRACE_PERIOD_MS`)
- `handleDisconnect()`: check `reconnectionMode` to decide grace-period vs hold behavior
- Keep all current states and timers for legacy-mode sessions (backward compat)

### Cloud: AppManager

- Add `handleReconnect(ws, reconnectMessage)` — matches `sessionToken` to existing AppSession, resumes connection
- Modify `handleAppInit()` — read `sdkVersion`, set `reconnectionMode`, generate `sessionToken`, include in `CONNECTION_ACK`
- `handleAppSessionGracePeriodExpired()` — only runs for legacy-mode sessions (no change)
- Add hold timeout handler for hold-mode sessions — fires `SESSION_EXPIRED` after configurable duration

### Cloud: SubscriptionManager

- No changes needed for reconnection (subscriptions stay in AppSession during `TRANSPORT_DOWN`)
- Remove `SUBSCRIPTION_GRACE_MS` hack for v3 sessions (subscriptions never cleared on reconnect)
- Keep `SUBSCRIPTION_GRACE_MS` for v2 sessions (backward compat)

### Cloud: UserSession

- Store users by MongoDB `_id` in `sessions` map (not email)
- Include both `userId` (`_id`) and `email` in `CONNECTION_ACK`
- Accept both `_id` and `email` for `getById()` lookups (transition period)

### SDK: MentraSession (v3)

- Store `sessionToken` from `CONNECTION_ACK`
- On disconnect: attempt `RECONNECT` with `sessionToken` (not `CONNECTION_INIT`)
- Reconnect immediately, retry every 1-2 seconds (no exponential backoff)
- On `RECONNECT_ACK`: verify subscriptions match, update if needed
- If `RECONNECT` fails (token expired / session gone): fall back to `CONNECTION_INIT` (fresh start), emit event so AppServer/developer knows this happened
- Send `sdkVersion` in `CONNECTION_INIT`
- Expose `session.userId` (MongoDB `_id`) and `session.email` (optional string)

### SDK: AppServer / MentraApp

- `onSession` is only called on fresh starts (not reconnects)
- New event: `onReconnect(session)` — optional, called when a transport reconnect succeeds (developer can use this to verify state)
- New event: `onSessionExpired(session)` — called when the cloud's hold timeout expired and the session was cleaned up. The next connection will be a fresh `onSession`.

---

## New Message Types

### `RECONNECT` (SDK → Cloud)

```typescript
{
  type: "reconnect",
  sessionToken: string,       // the token from the original CONNECTION_ACK
  sdkVersion: string,         // redundant but useful for logging
  timestamp: string
}
```

### `RECONNECT_ACK` (Cloud → SDK)

```typescript
{
  type: "reconnect_ack",
  sessionToken: string,       // same token (confirms identity)
  subscriptions: string[],    // current subscriptions on the cloud
  timestamp: string
}
```

### `RECONNECT_REJECTED` (Cloud → SDK)

```typescript
{
  type: "reconnect_rejected",
  code: "TOKEN_EXPIRED" | "SESSION_NOT_FOUND" | "SESSION_STOPPED",
  message: string,
  timestamp: string
}
```

When the SDK receives `RECONNECT_REJECTED`, it falls back to `CONNECTION_INIT` (fresh start). This handles the case where the hold timeout expired before the SDK could reconnect.

### Modified `CONNECTION_INIT` (SDK → Cloud)

```typescript
{
  type: "connection_init",
  packageName: string,
  sessionId: string,
  apiKey: string,
  sdkVersion: string          // NEW — "3.0.0" etc.
}
```

### Modified `CONNECTION_ACK` (Cloud → SDK)

```typescript
{
  type: "connection_ack",
  sessionId: string,
  sessionToken: string,       // NEW — unique per session instance
  userId: string,             // NEW — MongoDB _id (stable identifier)
  email: string | undefined,  // NEW — optional email
  settings: AppSettings,
  mentraosSettings: object,
  capabilities: object,
  timestamp: string
}
```

---

## Open Questions

| #   | Question                                   | Notes                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Hold timeout duration**                  | How long should the cloud hold a session alive after transport disconnect? 30s? 60s? 120s? Too short = unnecessary session expirations. Too long = stale sessions consume memory. Should it be configurable per app (manifest setting)?                                                                                                      |
| 2   | **Event buffering during TRANSPORT_DOWN**  | Should the cloud buffer events (transcription, notifications, etc.) while the transport is down and replay them on reconnect? Or just drop them? Buffering adds memory pressure and complexity. Dropping is simpler but the app misses events during the blip.                                                                               |
| 3   | **Cloud restart scenario**                 | If the cloud process itself restarts (deploy, crash), all in-memory sessions are gone. The SDK's `RECONNECT` will get `SESSION_NOT_FOUND`. It falls back to `CONNECTION_INIT` (fresh start). This is equivalent to the current resurrection — is that acceptable for v3? Or should sessions be persisted (Redis?) to survive cloud restarts? |
| 4   | **Multiple RECONNECT attempts**            | If the first `RECONNECT` fails (network still down), how many times should the SDK retry before giving up and falling back to `CONNECTION_INIT`? Or should it always try `RECONNECT` first and only fall back if it gets `RECONNECT_REJECTED`?                                                                                               |
| 5   | **sessionToken storage**                   | The SDK stores `sessionToken` in memory. If the app server process restarts, the token is lost. The SDK will send `CONNECTION_INIT` instead of `RECONNECT`. Is this fine? (Probably yes — if the process restarted, all state is gone anyway, fresh start is correct.)                                                                       |
| 6   | **userId transition**                      | How do we migrate from email-based userId to MongoDB `_id`? Big bang? Gradual? Do we support both simultaneously during a transition period? What about external systems that use the email as the user identifier?                                                                                                                          |
| 7   | **Kill sessionId entirely?**               | Is there value in keeping `sessionId` (`email-packageName`) for anything? If `sessionToken` handles identity and `userId` + `packageName` handle addressing, maybe `sessionId` is just a debug label.                                                                                                                                        |
| 8   | **Subscription verification on reconnect** | When the SDK reconnects and receives `RECONNECT_ACK` with the cloud's subscription list, should the SDK always send a fresh `SUBSCRIPTION_UPDATE` to confirm? Or only if there's a mismatch? Always-send is safer but adds a message. Mismatch-only is cleaner but requires reliable comparison.                                             |
| 9   | **onReconnect vs silent reconnect**        | Should the developer even know a reconnect happened? For most apps, the answer is no — the session just keeps working. But some apps might want to know (refresh UI, re-fetch data). Is `onReconnect` opt-in?                                                                                                                                |
| 10  | **v2 resurrection improvements**           | Even though we're keeping legacy behavior for v2 SDKs, should we improve the resurrection model at all? Or just leave it as-is since v2 is being deprecated?                                                                                                                                                                                 |
