# Spike: Mini App Reconnection & Session Architecture

**Issue:** 048
**Related:** [SDK v3 spike](./spike.md), [client SDK spike](./client-sdk-spike.md)
**Status:** Spike
**Date:** 2026-03-17
**Updated:** 2026-03-17 — complete rewrite from brainstorm session

---

## Overview

**What this doc covers:** The full mini app reconnection, resurrection, session identity, and state synchronization architecture — what it is today, every bug it's caused, and the complete v3 replacement design. Covers both SDK-side and cloud-side changes, multi-cloud scenarios, the userId/email problem, and backward compatibility with v2 SDKs.

**Why this matters:** The reconnection/resurrection system has been the single largest source of recurring bugs for nearly a year. Subscriptions disappear, sessions leak memory, apps can't distinguish fresh starts from resurrections, and multi-cloud handoffs cause ghost sessions. V3 is the one chance to fix this properly — the reconnection system was an afterthought in v1/v2 and has never been properly architected.

**Key principle:** The SDK's registered event handlers are the **single source of truth** for what subscriptions an app wants. Everything else is derived from that. The cloud's job is to match what the SDK says. The sync protocol ensures they never drift.

---

## Current Architecture (v2)

### The State Machine (Cloud-Side AppSession)

```
CONNECTING ──→ RUNNING ──→ GRACE_PERIOD ──→ RESURRECTING ──→ RUNNING (new session)
                  │              │
                  │              ├──→ DORMANT (user not connected)
                  │              │
                  │              └──→ STOPPED (resurrection failed)
                  │
                  └──→ STOPPING ──→ STOPPED
```

**State definitions:**

| State          | Meaning                                                                        | Duration                                      | What triggers it                                          |
| -------------- | ------------------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------- |
| `CONNECTING`   | Webhook sent to app server, waiting for WebSocket                              | Until SDK connects or timeout                 | `startApp()` called                                       |
| `RUNNING`      | Active WebSocket between SDK and cloud                                         | Indefinite                                    | SDK sends `CONNECTION_INIT`, cloud sends `CONNECTION_ACK` |
| `GRACE_PERIOD` | WebSocket died, waiting for SDK to reconnect                                   | 5 seconds (`GRACE_PERIOD_MS`)                 | WebSocket close event (unexpected)                        |
| `RESURRECTING` | Grace expired, cloud calling stop+start webhooks                               | During webhook calls                          | 5s timer fires with no reconnect                          |
| `DORMANT`      | Grace expired but user's glasses not connected to this cloud — can't resurrect | Until user reconnects or UserSession disposes | Grace timer fires + no glasses WebSocket                  |
| `STOPPING`     | User or system initiated stop in progress                                      | During stop webhook                           | `stopApp()` called                                        |
| `STOPPED`      | Fully stopped                                                                  | Terminal                                      | Stop completes, or resurrection fails                     |

### What Happens on Disconnect (Cloud Side)

When the mini app's WebSocket disconnects, `AppSession.handleDisconnect()`:

1. Clears heartbeat, nulls WebSocket reference
2. If state is `STOPPING` → `STOPPED` (expected)
3. If `ownershipReleased` → `DORMANT` (clean handoff to another cloud)
4. Otherwise → `GRACE_PERIOD`, starts 5s timer

When the 5s grace timer fires (`handleAppSessionGracePeriodExpired`):

1. Check if user's glasses WebSocket is still connected to THIS cloud
2. If user not connected → `DORMANT` (user probably switched clouds, can't resurrect)
3. If user connected → attempt resurrection:
   a. `stopApp(packageName)` — sends stop webhook, **destroys the AppSession**
   b. `startApp(packageName)` — sends start webhook, **creates brand new AppSession**
   c. All subscriptions, state, context from the old session: **gone**

### What Happens on Disconnect (SDK Side)

When the WebSocket closes, the SDK's close handler:

1. Categorizes the closure:
   - Normal (1000, 1001, 1008) or "App stopped" → don't reconnect
   - "User session ended" → `terminated = true`, never reconnect
   - Everything else → `handleReconnection()`

2. `handleReconnection()`:
   - Exponential backoff: `delay = 1000ms * 2^attempts`
   - Max 3 attempts (default)
   - Calls `this.connect(sessionId)` — sends `CONNECTION_INIT` (looks like a fresh start to the cloud)
   - On success: resets attempts
   - On final failure: emits `disconnected` with `permanent: true`

3. On successful reconnect:
   - Sends `CONNECTION_INIT` (same message as a brand new connection)
   - Cloud creates or reuses AppSession
   - SDK sends `SUBSCRIPTION_UPDATE` with current subscriptions
   - **Bug 007:** First subscription update is often empty due to timing
   - Cloud has 8s `SUBSCRIPTION_GRACE_MS` hack to ignore empty updates after reconnect

### Subscription Ownership (Three Places)

Subscriptions are tracked in three places that can drift:

1. **SDK `EventManager.getRegisteredStreams()`** — derived from developer's handlers. The "source of truth" for what the app WANTS.
2. **Cloud `AppSession._subscriptions`** — the cloud's record. The "source of truth" for what data gets routed to this app.
3. **Cloud `SubscriptionManager`** — aggregation layer that queries across AppSessions. Computes on demand (caches were removed to prevent drift).

On reconnect, the SDK re-derives subscriptions from handlers and sends `SUBSCRIPTION_UPDATE`. But the `CONNECTION_INIT` → `SUBSCRIPTION_UPDATE` sequence has a window where the cloud's AppSession has zero subscriptions (old ones cleared on the new connection, new ones haven't arrived yet).

The `SUBSCRIPTION_GRACE_MS = 8000` hack: if an empty `SUBSCRIPTION_UPDATE` arrives within 8s of a reconnect, the cloud ignores it. This prevents the "subscriptions disappeared" bug but is a timing-based heuristic, not a real fix. If the empty update arrives at 8.1s, it's applied and subscriptions are gone.

### Session Identity

**`sessionId` format:** `{email}-{packageName}` (e.g., `isaiahballah@gmail.com-com.mentra.captions`)

Problems:

- NOT unique per session instance. Same ID reused across clouds and resurrections.
- Cloud B creates an AppSession with the same `sessionId` as Cloud A's — no conflict detection.
- Cloud A's old AppSession becomes orphaned with a dead WebSocket. Memory leak until UserSession disposes.
- `email` is used as the user identifier, but some users won't have email (WeChat login for China launch).

### userId Is Actually Email

Throughout the entire system, `userId` is the user's email address:

- Key in `UserSession.sessions` map
- Part of `sessionId` format
- Passed to SDK in `onSession(session, sessionId, userId)`
- Stored in `user.runningApps`
- Auth token subject

When a user doesn't have an email (WeChat/WhatsApp/phone login), the entire identity system breaks.

---

## The Bugs This Has Caused

### 1. Subscription loss on reconnect

**Symptom:** After a network blip, the app reconnects but silently stops receiving transcription/notification/location data. No error. The app looks like it's working but no data flows.

**Root cause:** SDK sends `CONNECTION_INIT` (fresh start) then `SUBSCRIPTION_UPDATE`. Window between these two messages where AppSession has zero subscriptions. If data arrives during this window, dropped. If subscription update is empty (Bug 007), the 8s grace hack may or may not catch it.

**Frequency:** Recurring over the past year. Each occurrence is subtle and hard to diagnose.

### 2. Resurrection destroys app context

**Symptom:** After a brief network blip, `onSession` is called again with a fresh session. All in-memory state gone — conversation history, loaded preferences, running timers, accumulated data.

**Root cause:** Resurrection calls `stopApp()` then `startApp()`. This **destroys the old AppSession** (all subscriptions, all state) and creates a brand new one. The stop webhook fires, the start webhook fires. The app's `onStop` runs, then `onSession` runs with a fresh session. The developer can't tell this happened because of a 5s network blip vs. the user actually restarting the app.

**Impact:** Developers have to build their own persistence in `onStop` and restoration in `onSession` to survive resurrections. Most don't. Their apps break silently after any network blip longer than 5s.

### 3. Timing race between SDK backoff and cloud grace period

**Symptom:** SDK is still trying to reconnect but the cloud has already resurrected (destroyed and recreated) the session.

**Root cause:** SDK exponential backoff (1s, 2s, 4s). Cloud grace period: 5s. Third reconnection attempt starts at t=3s but if the connection takes >2s to establish, the cloud's 5s timer has fired and resurrection is in progress. The SDK reconnects to a session that's being torn down.

### 4. Multi-cloud ghost sessions (memory leak)

**Symptom:** After switching clouds, old cloud holds stale AppSessions with dead WebSockets. Memory grows over time.

**Root cause:** User switches from Cloud A to Cloud B:

- Cloud B sees `runningApps` in shared DB, starts those apps
- Mini apps connect to Cloud B
- Cloud A's WebSocket to mini app dies
- Cloud A checks glasses WebSocket — also dead (user left)
- Cloud A marks apps as `DORMANT`
- But `sessionId` is `email-packageName` (not unique per cloud). Cloud B creates a session with the same ID. No conflict detection.
- Cloud A's AppSession objects linger until UserSession disposes

### 5. Cloud doesn't know WHY the mini app disconnected

**Symptom:** Cloud A loses the mini app WebSocket. It doesn't know if:

- a) Network blip (app is alive, will reconnect in ms)
- b) App crashed (process dead, won't reconnect)
- c) User switched to Cloud B (app is now connected elsewhere)

Without the user's glasses WebSocket, Cloud A has no signal. Today, if the glasses WebSocket is dead, Cloud A assumes the user left and marks apps DORMANT. But this means Cloud A never tries to bring the app back — even in case (b) where the app genuinely crashed and needs resurrection.

With the reconnect webhook (proposed below), Cloud A can try to bring the app back regardless of whether it has the glasses WebSocket. The SDK decides whether to accept.

---

## V3 Architecture

### Design Principles

1. **WebSocket disconnect ≠ session dead.** The transport broke. The app server is still running. State is still in memory. Don't destroy anything.
2. **SDK handlers are the single source of truth** for subscriptions. The cloud matches what the SDK says. Always.
3. **Every connection includes subscription reconciliation.** No timing hacks. No grace windows. The SDK and cloud explicitly compare state and resolve mismatches.
4. **Resurrection preserves the AppSession.** Don't destroy and recreate. Keep the subscriptions, keep the state. Just get the SDK to reconnect.
5. **The SDK decides where to connect.** The cloud sends webhooks. The SDK decides whether to obey based on its current state.
6. **SDK version in CONNECTION_INIT** lets the cloud handle v2 and v3 apps differently on the same deployment.

### State: SDK Side

```typescript
// What the SDK holds for each session
interface SDKSessionState {
  // Identity
  sessionId: string | null // UUID from last CONNECTION_ACK (null if never connected)
  cloudHostname: string | null // which cloud we're connected to

  // Connection
  connectionState: "disconnected" | "connecting" | "connected"
  webSocket: WebSocket | null

  // Subscriptions (source of truth — derived from handlers)
  handlers: Map<string, Set<Function>> // eventType → callbacks
  subscriptions: Set<string> // derived from handlers, always in sync

  // Received from cloud
  settings: AppSettings
  capabilities: Capabilities
  userId: string // MongoDB _id
  email: string | undefined // optional
}
```

**Key invariant:** `subscriptions` is ALWAYS derived from `handlers`. When a handler is added, the subscription is added. When a handler is removed, the subscription is removed. They cannot drift. This is the Bug 007 fix made structural.

### State: Cloud Side

```typescript
// What the cloud holds per mini app per user
interface CloudAppSessionState {
  // Identity
  sessionId: string // UUID, unique per cloud per session instance
  packageName: string
  sdkVersion: string | null // from CONNECTION_INIT, null for v2

  // Connection
  connectionState: AppConnectionState // see state machine below
  webSocket: WebSocket | null // null during TRANSPORT_DOWN
  reconnectionMode: "legacy" | "v3" // derived from sdkVersion

  // Subscriptions (matches what the SDK last told us)
  subscriptions: Set<string>
  locationRate: LocationRate | null

  // Metadata
  connectedAt: Date | null
  disconnectedAt: Date | null
}
```

**Key invariant:** `subscriptions` on the cloud ALWAYS matches what the SDK last sent via `SUBSCRIPTION_UPDATE` or what was confirmed via `RECONNECT_ACK`. The cloud never modifies subscriptions on its own — only the SDK can change them.

### State Machine: Cloud Side (v3 apps)

```
                                    ┌──────────────────────────┐
                                    │                          │
CONNECTING ──→ RUNNING ──→ TRANSPORT_DOWN ──→ RUNNING          │
                  │              │         (RECONNECT received) │
                  │              │                              │
                  │              └──→ RESURRECTING              │
                  │              (5s, no RECONNECT)             │
                  │                    │                        │
                  │                    ├──→ RUNNING ────────────┘
                  │                    │   (SDK connects via webhook)
                  │                    │
                  │                    └──→ STOPPED
                  │                       (webhook failed / app dead)
                  │
                  └──→ STOPPING ──→ STOPPED
```

**State transitions:**

| From             | To               | Trigger                                    | What happens                                                                                                                        |
| ---------------- | ---------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `CONNECTING`     | `RUNNING`        | SDK sends `CONNECTION_INIT` or `RECONNECT` | WebSocket established, ACK sent                                                                                                     |
| `RUNNING`        | `TRANSPORT_DOWN` | WebSocket closes unexpectedly              | Start 5s timer. **Keep AppSession alive with all subscriptions.** WebSocket reference nulled but everything else preserved.         |
| `TRANSPORT_DOWN` | `RUNNING`        | SDK sends `RECONNECT` within 5s            | Cancel timer. Attach new WebSocket to existing AppSession. Send `RECONNECT_ACK` with current subscriptions. Data resumes instantly. |
| `TRANSPORT_DOWN` | `RESURRECTING`   | 5s timer fires, no `RECONNECT` received    | SDK probably crashed or is on a different cloud. Send start webhook to app server. **Keep AppSession alive** (don't destroy it).    |
| `RESURRECTING`   | `RUNNING`        | SDK connects (via webhook response)        | Attach new WebSocket to existing AppSession. Send ACK with preserved subscriptions. SDK reconciles.                                 |
| `RESURRECTING`   | `STOPPED`        | Webhook fails (app server unreachable)     | App is truly dead. Clean up AppSession. Notify mobile.                                                                              |
| `RUNNING`        | `STOPPING`       | `stopApp()` called (user or system)        | Send stop webhook.                                                                                                                  |
| `STOPPING`       | `STOPPED`        | Stop completes                             | Clean up AppSession.                                                                                                                |

**Critical difference from v2:** Resurrection does NOT destroy the AppSession. The cloud keeps it alive with all subscriptions. It just sends a webhook to get the SDK to reconnect. When the SDK connects, it finds the existing AppSession waiting for it.

### State Machine: Cloud Side (v2 apps — legacy, unchanged)

```
CONNECTING ──→ RUNNING ──→ GRACE_PERIOD ──→ RESURRECTING ──→ RUNNING (new session)
                  │              │
                  │              ├──→ DORMANT (user not connected)
                  │              │
                  │              └──→ STOPPED (resurrection failed)
                  │
                  └──→ STOPPING ──→ STOPPED
```

Same as today. No changes. The cloud reads `sdkVersion` from `CONNECTION_INIT` — if missing or `< 3.0.0`, legacy behavior. v2 apps work exactly as before.

### SDK Version Detection

```typescript
// v3 SDK sends:
{
  type: "connection_init",
  packageName: "com.example.app",
  apiKey: "...",
  sdkVersion: "3.0.0",             // NEW
  // sessionId removed from CONNECTION_INIT (see Session Identity below)
}
```

Cloud reads `sdkVersion` and sets `reconnectionMode`:

```typescript
if (!sdkVersion || semver.lt(sdkVersion, "3.0.0")) {
  appSession.reconnectionMode = "legacy" // current behavior
} else {
  appSession.reconnectionMode = "v3" // new behavior
}
```

Both modes coexist. A user can have v2 and v3 apps running simultaneously with different reconnection behavior.

---

## The Connection Protocol

### Scenario 1: Fresh Start (first connection, or new cloud)

This happens when:

- App is started for the first time
- App connects to a cloud that has never seen it before (user switched clouds)
- App server process restarted (lost all in-memory state, no `sessionId`)

```
Cloud                                         SDK
 │                                              │
 │──── Start Webhook ─────────────────────────→ │
 │     { cloudHostname: "cloud-a.mentra.glass", │
 │       userId: "mongo_id_123",                │
 │       ... }                                  │
 │                                              │ SDK has no sessionId for this cloud
 │                                              │ → fresh start
 │                                              │
 │←─── WebSocket connects ─────────────────────│
 │                                              │
 │←─── CONNECTION_INIT ────────────────────────│
 │     { packageName, apiKey,                   │
 │       sdkVersion: "3.0.0" }                  │
 │                                              │
 │  Cloud creates AppSession                    │
 │  Generates sessionId (UUID)                  │
 │  subscriptions = empty                       │
 │                                              │
 │──── CONNECTION_ACK ────────────────────────→ │
 │     { sessionId: "uuid-abc",                 │
 │       userId: "mongo_id_123",                │
 │       email: "user@example.com",             │
 │       subscriptions: [],                     │   ← cloud has nothing
 │       resurrected: false,                    │
 │       ... }                                  │
 │                                              │
 │                                              │ SDK stores sessionId, cloudHostname
 │                                              │ SDK compares local subs vs ACK subs
 │                                              │ Local: ["transcription:en", "button_press"]
 │                                              │ Remote: [] (empty — new cloud)
 │                                              │ Mismatch → send update
 │                                              │
 │←─── SUBSCRIPTION_UPDATE ────────────────────│
 │     { subscriptions: ["transcription:en",    │
 │       "button_press"] }                      │
 │                                              │
 │  Cloud stores subscriptions                  │
 │  Starts routing data                         │
 │                                              │
 │──── DataStream, events ────────────────────→ │
```

### Scenario 2: Reconnection (transport blip, SDK self-heals)

This happens when:

- WebSocket drops due to network glitch
- SDK detects it instantly and reconnects (usually within milliseconds)
- SDK still has `sessionId` and all state in memory

```
Cloud                                         SDK
 │                                              │
 │  (WebSocket drops)                           │  (WebSocket drops)
 │                                              │
 │  AppSession → TRANSPORT_DOWN                 │  connectionState → disconnected
 │  Start 5s timer                              │  Immediately try to reconnect
 │  Keep subscriptions, keep all state          │  (no backoff — reconnect ASAP)
 │                                              │
 │←─── New WebSocket connects ─────────────────│  (within milliseconds)
 │                                              │
 │←─── RECONNECT ──────────────────────────────│
 │     { sessionId: "uuid-abc" }                │
 │                                              │
 │  Cancel 5s timer                             │
 │  Match sessionId to existing AppSession      │
 │  Attach new WebSocket                        │
 │  AppSession → RUNNING                        │
 │                                              │
 │──── RECONNECT_ACK ─────────────────────────→ │
 │     { sessionId: "uuid-abc",                 │
 │       subscriptions: ["transcription:en",    │   ← cloud preserved everything
 │         "button_press"] }                    │
 │                                              │
 │                                              │ SDK compares local subs vs ACK subs
 │                                              │ Local: ["transcription:en", "button_press"]
 │                                              │ Remote: ["transcription:en", "button_press"]
 │                                              │ Match → no update needed
 │                                              │
 │──── DataStream resumes instantly ──────────→ │
```

**No subscription gap.** No empty update bug. No `SUBSCRIPTION_GRACE_MS` hack. The cloud never cleared subscriptions, so there's nothing to re-register.

**If subscriptions changed during the disconnect** (developer's code added/removed a handler while offline):

```
 │                                              │ SDK compares local subs vs ACK subs
 │                                              │ Local: ["transcription:en", "button_press", "location_stream"]
 │                                              │ Remote: ["transcription:en", "button_press"]
 │                                              │ Mismatch → send update
 │                                              │
 │←─── SUBSCRIPTION_UPDATE ────────────────────│
 │     { subscriptions: ["transcription:en",    │
 │       "button_press", "location_stream"] }   │
 │                                              │
 │  Cloud updates subscriptions                 │
```

### Scenario 3: Resurrection (SDK didn't reconnect in 5s)

This happens when:

- SDK process crashed (OOM, unhandled exception)
- SDK is connected to a different cloud (user switched)
- Network is completely down for >5s

```
Cloud                                         SDK
 │                                              │
 │  (WebSocket drops)                           │  (crashed, or connected elsewhere)
 │                                              │
 │  AppSession → TRANSPORT_DOWN                 │
 │  Start 5s timer                              │
 │  ... 5 seconds pass, no RECONNECT ...        │
 │                                              │
 │  Timer fires                                 │
 │  AppSession → RESURRECTING                   │
 │  **Keep AppSession alive with subs**         │
 │                                              │
 │──── Start Webhook ─────────────────────────→ │  (same webhook as a fresh start)
 │     { cloudHostname: "...",                  │
 │       userId: "...", ... }                   │
 │                                              │
 │  SDK receives webhook. Two possibilities:    │
 │                                              │
 │  CASE A: SDK still has state (e.g., it was   │
 │  connected to a different cloud but is now   │
 │  switching back, or network just recovered)  │
 │                                              │
 │←─── RECONNECT { sessionId: "uuid-abc" } ───│
 │                                              │
 │  Cloud matches to existing AppSession        │
 │  AppSession → RUNNING                        │
 │  Subs preserved                              │
 │                                              │
 │──── RECONNECT_ACK { subscriptions, ... } ──→ │
 │                                              │  SDK reconciles (same as Scenario 2)
 │                                              │
 │  ─── OR ───                                  │
 │                                              │
 │  CASE B: SDK lost state (process restarted)  │
 │                                              │
 │←─── CONNECTION_INIT { sdkVersion, ... } ────│
 │                                              │
 │  Cloud matches to existing AppSession        │
 │  (by packageName, since no sessionId sent)   │
 │  AppSession → RUNNING                        │
 │  **Subs still preserved on cloud side**      │
 │                                              │
 │──── CONNECTION_ACK ────────────────────────→ │
 │     { sessionId: "uuid-abc",                 │  ← could be same or new UUID
 │       subscriptions: ["transcription:en",    │  ← cloud's preserved subs
 │         "button_press"],                     │
 │       resurrected: true }                    │  ← SDK knows this was a resurrection
 │                                              │
 │                                              │  SDK compares local subs (freshly derived
 │                                              │  from handlers) vs cloud's preserved subs
 │                                              │  If match → no update (cloud was right!)
 │                                              │  If mismatch → send SUBSCRIPTION_UPDATE
 │                                              │
 │──── DataStream resumes ───────────────────→ │
```

**Key insight:** Even in CASE B (SDK lost state), the cloud's preserved subscriptions might be correct. If the developer's `onSession` registers the same handlers every time (which most apps do), the SDK's freshly derived subscriptions will match the cloud's preserved ones. No update needed. Data resumes instantly after the ACK, even for a resurrected session.

**The `resurrected: true` flag** lets the developer know this happened:

```typescript
app.onSession((session) => {
  if (session.wasResurrected) {
    // Optional: restore state from storage
    const saved = await session.storage.get("lastState")
  }

  // Register handlers (same as always)
  session.transcription.on((data) => {
    session.display.showText(data.text)
  })
})
```

### Scenario 4: Multi-Cloud Switch

```
Timeline:
t=0s    User on Cloud A. App connected to Cloud A with sessionId "abc".
t=5s    User switches to Cloud B.
        Cloud B reads runningApps from DB.
        Cloud B sends start webhook to app server.
        SDK receives webhook from Cloud B.
        SDK is currently connected to Cloud A.
        SDK sends OWNERSHIP_RELEASE to Cloud A ("user left").
        SDK connects to Cloud B with CONNECTION_INIT (new cloud, no sessionId for B).
        Cloud B creates AppSession with sessionId "def".
        SDK stores sessionId "def", cloudHostname "cloud-b.mentra.glass".
        Cloud A receives OWNERSHIP_RELEASE → marks apps DORMANT. Cleanup.
t=10s   Cloud A's WebSocket to the mini app is now dead.
        Cloud A doesn't have the glasses WebSocket either.
        Cloud A sends start webhook to app server (resurrection attempt).
        SDK receives webhook from Cloud A.
        SDK is currently connected to Cloud B.
        SDK IGNORES Cloud A's webhook — it already has a connection to Cloud B.
        (Cloud B has the user. Cloud A's webhook is stale.)
t=30s   User switches BACK to Cloud A.
        Cloud A sees glasses WebSocket reconnect.
        Cloud A still has DORMANT AppSessions.
        Cloud A sends start webhook (resurrection).
        SDK receives webhook from Cloud A.
        SDK is connected to Cloud B but Cloud A is asking it to connect.
        SDK sends OWNERSHIP_RELEASE to Cloud B.
        SDK connects to Cloud A.
        If SDK still has sessionId "abc" → sends RECONNECT.
          Cloud A matches to DORMANT AppSession, resumes with preserved subs.
        If SDK lost sessionId "abc" → sends CONNECTION_INIT.
          Cloud A matches by packageName, resumes with preserved subs.
        Either way, data resumes.
```

**SDK's decision logic when receiving a webhook:**

```
Receive start webhook from Cloud X:
  1. Am I currently connected to Cloud X?
     → Already connected. Ignore. (Shouldn't happen.)

  2. Am I connected to a different cloud?
     → Send OWNERSHIP_RELEASE to current cloud.
     → Connect to Cloud X.

  3. Am I not connected to anyone?
     → Connect to Cloud X.
```

The SDK always follows the most recent webhook. The webhook IS the signal that a cloud has the user.

**Why Cloud A sends a start webhook even without the glasses WebSocket:**

Cloud A lost the mini app WebSocket. It doesn't know WHY. Maybe:

- Network glitch (app is alive)
- App crashed (process dead)
- User switched to Cloud B (app connected elsewhere)

Cloud A can't tell. So it tries: send a start webhook. Let the SDK sort it out. If the SDK is on another cloud, it ignores the webhook (or it switches — depending on whether Cloud A actually has the user). If the SDK crashed, the webhook fails (no one listening). If the SDK is alive and unconnected, it reconnects.

---

## The Subscription Sync Protocol

Every connection (reconnect or fresh) follows the same reconciliation:

```
1. SDK connects (RECONNECT or CONNECTION_INIT)
2. Cloud sends ACK with its current subscriptions for this app
3. SDK compares:
   local_subs  = derived from registered handlers (source of truth)
   remote_subs = from the ACK (what the cloud has)
4. If local_subs === remote_subs → done, in sync, data flows
5. If local_subs !== remote_subs → SDK sends SUBSCRIPTION_UPDATE with local_subs
6. Cloud replaces its subscriptions with what the SDK sent
7. Data flows based on the reconciled subscriptions
```

**This eliminates:**

- The empty subscription bug (no window where subs are zero)
- The `SUBSCRIPTION_GRACE_MS` hack (no timing-based guessing)
- Subscription drift between SDK and cloud (explicit comparison every time)
- The need for subscription history/debugging on the cloud (the ACK comparison is the debug tool)

**For v2 SDKs:** The legacy flow is unchanged. `SUBSCRIPTION_GRACE_MS` stays for v2 sessions. The reconciliation protocol only applies to v3 sessions.

---

## Session Identity

### sessionId: A Real UUID

**Current:** `sessionId = "email-packageName"` — not unique per session instance.

**V3:** `sessionId` is a UUID generated by the cloud when a session is created. It's unique per cloud, per session instance.

- Cloud A creates session → `sessionId: "550e8400-e29b-41d4-a716-446655440000"`
- Cloud B creates session for same app → `sessionId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8"` (different UUID)
- Resurrection on Cloud A preserves the sessionId (because the AppSession isn't destroyed)
- The SDK stores the sessionId and sends it in `RECONNECT` messages
- The cloud uses it to match reconnections to existing AppSessions

### userId: MongoDB \_id (not email)

**Current:** `session.userId === "isaiahballah@gmail.com"` (email)

**V3:**

```typescript
session.userId // "65f2a1b3c4d5e6f7a8b9c0d1" — MongoDB _id, stable, never changes
session.email // "isaiahballah@gmail.com" | undefined — optional
```

**Why:**

- WeChat login (China launch) — no email
- WhatsApp / phone number login — no email
- Email can change — userId shouldn't change with it
- MongoDB `_id` is already on every user document

**Cloud changes:**

- `UserSession.sessions` map key: MongoDB `_id` (not email)
- Auth tokens include both `_id` and `email`
- `getById()` accepts both `_id` and email during transition
- `CONNECTION_ACK` includes both `userId` (the `_id`) and `email`

**SDK changes:**

- `session.userId` returns MongoDB `_id`
- `session.email` returns email (optional)
- v2 compat: `AppServer` shim passes email as `userId` to `onSession(session, sessionId, userId)`

---

## WebSocket Path Renames

**Current:**

- `/glasses-ws` — mobile client ↔ cloud (misleading: glasses don't connect here, the phone does)
- `/app-ws` — mini app SDK ↔ cloud (vague: "app" could mean anything)

**V3:**

- `/ws/client` — mobile client ↔ cloud
- `/ws/miniapp` — mini app SDK ↔ cloud

Legacy aliases for backward compat:

```
/ws/client   ← new (v3)
/glasses-ws  ← legacy alias (v2 mobile clients)

/ws/miniapp  ← new (v3)
/app-ws      ← legacy alias (v2 SDKs)
```

Both route to the same handler. Legacy aliases removed when v2 is fully deprecated.

---

## Webhook Changes

### Start Webhook (modified)

```typescript
// Cloud → App Server (same webhook for fresh start AND resurrection)
{
  type: "session_request",           // same as today
  cloudHostname: "cloud-a.mentra.glass",  // NEW — replaces mentraOSWebsocketUrl
  userId: "mongo_id_123",           // NEW — MongoDB _id
  email: "user@example.com",        // NEW — optional, for display/logging
  sessionId: "previous-session-uuid", // NEW — if resurrecting, the preserved session's ID
  timestamp: "...",

  // Backward compat — v2 SDKs need these
  mentraOSWebsocketUrl: "wss://cloud-a.mentra.glass/app-ws",  // DEPRECATED but still sent
  augmentOSWebsocketUrl: "wss://cloud-a.mentra.glass/app-ws", // DEPRECATED but still sent
}
```

The SDK uses `cloudHostname` to derive all URLs:

- WebSocket: `wss://${cloudHostname}/ws/miniapp`
- HTTP: `https://${cloudHostname}/api/...`

The `sessionId` in the webhook tells the SDK: "I have a preserved session with this ID. If you still have it, send RECONNECT. If not, send CONNECTION_INIT." This is how the SDK decides whether to reconnect or start fresh.

### Stop Webhook (unchanged)

```typescript
{
  type: "stop_request",
  sessionId: "...",
  userId: "...",
  reason: "...",
  timestamp: "..."
}
```

---

## New Message Types

### RECONNECT (SDK → Cloud)

Sent when the SDK reconnects to a cloud where it previously had a session. The `sessionId` identifies which AppSession to resume.

```typescript
{
  type: "reconnect",
  sessionId: string,        // UUID from the previous CONNECTION_ACK
  sdkVersion: string,
  timestamp: string
}
```

### RECONNECT_ACK (Cloud → SDK)

Cloud confirms the reconnection. Includes current subscriptions for reconciliation.

```typescript
{
  type: "reconnect_ack",
  sessionId: string,        // same sessionId (confirmed)
  subscriptions: string[],  // cloud's current subscriptions for this app
  userId: string,           // MongoDB _id
  email: string | undefined,
  timestamp: string
}
```

### RECONNECT_REJECTED (Cloud → SDK)

Cloud can't find the session (expired, or wrong cloud). SDK should fall back to CONNECTION_INIT.

```typescript
{
  type: "reconnect_rejected",
  code: "SESSION_NOT_FOUND" | "SESSION_STOPPED" | "SESSION_EXPIRED",
  message: string,
  timestamp: string
}
```

When the SDK receives this, it falls back to `CONNECTION_INIT` (fresh start). The cloud will create a new AppSession.

### Modified CONNECTION_INIT (SDK → Cloud)

```typescript
{
  type: "connection_init",
  packageName: string,
  apiKey: string,
  sdkVersion: string,       // NEW — "3.0.0", cloud uses this to set reconnectionMode
  timestamp: string
  // NOTE: sessionId is NOT in CONNECTION_INIT anymore.
  // sessionId is only in RECONNECT messages.
  // CONNECTION_INIT always means "fresh start."
}
```

### Modified CONNECTION_ACK (Cloud → SDK)

```typescript
{
  type: "connection_ack",
  sessionId: string,             // UUID — unique per cloud per session
  userId: string,                // MongoDB _id
  email: string | undefined,     // optional
  subscriptions: string[],       // NEW — cloud's current subs (for reconciliation)
  resurrected: boolean,          // NEW — true if this was a resurrection
  settings: AppSettings,
  mentraosSettings: object,
  capabilities: object,
  timestamp: string
}
```

---

## What Changes Where

### Cloud: AppSession

- Add `sdkVersion` field (from `CONNECTION_INIT`)
- Add `reconnectionMode: "legacy" | "v3"` (derived from `sdkVersion`)
- Add `sessionId` as a real UUID (generated on creation, NOT `email-packageName`)
- Add `TRANSPORT_DOWN` state — WebSocket dropped, session alive, subscriptions preserved, 5s timer running
- `handleDisconnect()`:
  - v3 mode: → `TRANSPORT_DOWN`, start 5s timer, **do NOT clear subscriptions**
  - legacy mode: → `GRACE_PERIOD` (current behavior, unchanged)
- Resurrection: do NOT destroy AppSession. Keep it alive. Just send the webhook and wait for the SDK to connect.
- `handleReconnect(ws, sessionId)`: new method — matches sessionId to existing AppSession, attaches new WebSocket, cancels 5s timer, sends `RECONNECT_ACK`

### Cloud: AppManager

- `handleAppInit()`:
  - Read `sdkVersion`, set `reconnectionMode`
  - Generate `sessionId` UUID, include in `CONNECTION_ACK`
  - Include `subscriptions: [...]` in ACK (the cloud's current list)
  - Include `resurrected: true/false`
- New: `handleReconnect(ws, reconnectMessage)`:
  - Find AppSession by `sessionId`
  - If found and in `TRANSPORT_DOWN` or `RESURRECTING` → attach WebSocket, resume
  - If not found → send `RECONNECT_REJECTED`, SDK will fall back to `CONNECTION_INIT`
- Resurrection (`handleAppSessionGracePeriodExpired`):
  - v3 mode: keep AppSession alive, send start webhook, wait for SDK
  - legacy mode: `stopApp()` + `startApp()` (current behavior)
- Include `cloudHostname` and `sessionId` in start webhook payload

### Cloud: SubscriptionManager

- For v3 sessions: remove `SUBSCRIPTION_GRACE_MS` hack (not needed — reconciliation protocol handles it)
- For v2 sessions: keep `SUBSCRIPTION_GRACE_MS` (backward compat)
- No other changes — subscriptions are still stored on AppSession, SubscriptionManager still aggregates

### Cloud: UserSession

- `sessions` map key: MongoDB `_id` (not email)
- `getById()`: accept both `_id` and email during transition
- Include `userId` (MongoDB `_id`) and `email` in `CONNECTION_ACK`

### Cloud: WebSocket Handlers (bun-websocket.ts)

- Accept connections on `/ws/miniapp` (new) and `/app-ws` (legacy alias)
- Accept connections on `/ws/client` (new) and `/glasses-ws` (legacy alias)
- Handle `RECONNECT` message type in `handleAppMessage`:
  - Parse `sessionId` from message
  - Delegate to `appManager.handleReconnect(ws, message)`

### SDK: MentraSession (v3)

- Store `sessionId` from `CONNECTION_ACK`
- Store `cloudHostname` from webhook
- On WebSocket disconnect:
  - Immediately reconnect (no exponential backoff)
  - Send `RECONNECT` with `sessionId` (not `CONNECTION_INIT`)
  - Retry the WebSocket connection every 1s until connected or the session is stopped
- On `RECONNECT_ACK`:
  - Compare local subscriptions (from handlers) vs cloud subscriptions (from ACK)
  - If mismatch → send `SUBSCRIPTION_UPDATE`
  - If match → do nothing, data resumes
- On `RECONNECT_REJECTED`:
  - Fall back to `CONNECTION_INIT` (fresh start)
  - New sessionId will be assigned
- On webhook received:
  - If currently connected to a different cloud → send `OWNERSHIP_RELEASE` to current cloud, connect to new cloud
  - If not connected → connect
  - If webhook includes `sessionId` that SDK recognizes → send `RECONNECT`
  - If webhook includes `sessionId` that SDK doesn't recognize, or no `sessionId` → send `CONNECTION_INIT`
- Send `sdkVersion` in `CONNECTION_INIT`
- Expose `session.userId` (MongoDB `_id`) and `session.email` (optional)
- Expose `session.wasResurrected` (from `CONNECTION_ACK.resurrected`)

### SDK: MentraApp / AppServer

- `onSession`: only called on fresh starts and resurrections (not reconnects)
- `session.wasResurrected: boolean` available in `onSession` callback
- Webhooks: read `cloudHostname` (new) with fallback to `mentraOSWebsocketUrl` (v2 compat)

---

## Open Questions

| #   | Question                                           | Notes                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Event buffering during TRANSPORT_DOWN**          | Should the cloud buffer events during the 5s hold and replay on reconnect? Most reconnects happen in milliseconds — the gap is tiny. Buffering adds complexity. Probably drop events during the gap — the app misses a few ms of data, not meaningful for most use cases.                                                                 |
| 2   | **Cloud restart scenario**                         | If the cloud process itself restarts (deploy, crash), all in-memory AppSessions are gone. SDK's `RECONNECT` gets `RECONNECT_REJECTED`. Falls back to `CONNECTION_INIT`. Cloud creates new AppSession with empty subs. SDK sends `SUBSCRIPTION_UPDATE`. This is equivalent to a fresh start — acceptable? Or persist AppSessions to Redis? |
| 3   | **RECONNECT retry strategy**                       | SDK reconnects immediately with no backoff. If the WebSocket can't be established (network fully down), keep retrying every 1s? Or slightly increase (1s, 1s, 2s, 2s)? Must succeed within 5s or cloud resurrects.                                                                                                                        |
| 4   | **userId transition plan**                         | How do we migrate from email-based userId to MongoDB `_id`? Support both simultaneously during transition? What about external systems (dev console, BetterStack logs, debug tools) that use email?                                                                                                                                       |
| 5   | **Kill sessionId as email-packageName**            | The old `sessionId` format (`email-packageName`) — do we keep it for any backward compat purpose? Or completely replace with the UUID? v2 SDKs send it in `CONNECTION_INIT` — does the cloud still need to parse it?                                                                                                                      |
| 6   | **Subscription comparison algorithm**              | How does the SDK compare local vs remote subscriptions? Set equality? Order-independent string comparison? Do we need to handle stream type aliases (e.g., `transcription:en-US` vs `transcription:en`)?                                                                                                                                  |
| 7   | **onReconnect event**                              | Should the developer know a reconnect happened? Silent reconnect is clean (session "just works"). But some apps might want to refresh data. Emit `session.on("reconnected")` always? Or opt-in?                                                                                                                                           |
| 8   | **v2 backport of resurrected flag**                | Should we add `resurrected: true` to v2 `CONNECTION_ACK` as well? Non-breaking addition. v2 SDKs would ignore it, but devs who check raw messages could use it.                                                                                                                                                                           |
| 9   | **RECONNECT_REJECTED → immediate CONNECTION_INIT** | When SDK gets `RECONNECT_REJECTED`, should it send `CONNECTION_INIT` on the same WebSocket connection? Or close and reconnect? Same-connection is faster. New-connection is cleaner.                                                                                                                                                      |
| 10  | **Multi-cloud webhook conflict**                   | If Cloud A and Cloud B both send start webhooks simultaneously (race condition during switch), the SDK follows the most recent. But "most recent" based on what — webhook receipt time? Does the webhook include a timestamp the SDK can compare?                                                                                         |
