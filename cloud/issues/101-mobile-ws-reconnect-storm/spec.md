# Spec: Mobile WebSocket Reconnect Storm — Fix

## Overview

**What this doc covers:** Exact behavior changes to eliminate the WebSocket reconnect storm identified in [spike.md](./spike.md). The fix is surgical — `WebSocketManager.this.url` stops being a cached field and always derives freshly from `useSettingsStore.getState().getWsUrl()` whenever the WSM needs to reconnect. Two smaller fixes fold in as defense-in-depth: `WebsocketStatus.useEffect` stops calling `refreshApplets()` on every CONNECTED transition, and `detachAndCloseSocket()` awaits the `close` event before returning.

**Why this doc exists:** v2.10 is shipping on the app stores right now. Every user who updates to v2.10 and then encounters any situation that updates `backend_url` without going through `mantle.cleanup()+mantle.init()` is one retry-on-503 trigger away from a 90-opens-per-minute reconnect storm. This needs to ship in v2.10.1 or v2.11.

**What you need to know first:** [spike.md](./spike.md) for evidence and root cause.

**Who should read this:** Mobile engineers reviewing the PR. Cloud engineers reviewing the server-side impact.

---

## The Problem in 30 Seconds

`WebSocketManager.this.url` caches the WebSocket URL from the last `connect()` call. It is never updated when `useSettingsStore`'s `backend_url` setting changes. Any code path that updates `backend_url` without triggering a full `mantle.cleanup() → mantle.init() → ws.connect(newUrl)` cycle leaves the WSM reconnecting forever against the stale URL, while axios immediately follows the new URL. REST returns 503 (session on old pod, not new), retry-on-503 fires NO_ACTIVE_SESSION, WSM reopens the WS against the stale URL, loop. Fix: always read the URL freshly from the settings store when reconnecting.

---

## Spec

### S1. `WebSocketManager` always derives the URL from the settings store

**File:** `mobile/src/services/WebSocketManager.ts`

**Current:** `WebSocketManager` has a private `url: string | null` field, written only inside `connect(url, coreToken)`. `reconnectNow()` reads `this.url` and passes it back into `connect(this.url, this.coreToken)`.

**New behavior:**

- Remove `this.url` as a cached source of truth for which URL to reconnect to.
- When WSM needs a URL for a connect/reconnect operation, it must read fresh from the settings store: `useSettingsStore.getState().getWsUrl()`.
- `connect(url, coreToken)` may still exist as a public API to allow explicit callers (e.g. `socketComms.connectWebsocket()` during `mantle.init()`) to pass a URL — but WSM itself does not depend on the argument persisting across calls.
- When the URL returned by `getWsUrl()` differs from the URL WSM is currently connected against, WSM cleanly disconnects the old socket and connects to the new one. This makes `backend_url` Zustand changes transparent.

Implementation options — either acceptable, picking one in the design:

- **Option A — reactive subscription.** WSM subscribes to `useSettingsStore` on construction. When `backend_url` changes, WSM disconnects (with a one-shot flag to suppress auto-reconnect during the transition) and reconnects to the new URL.
- **Option B — always-derive on reconnect.** Remove `this.url`. `reconnectNow()` and the `onclose` reconnect path always call `useSettingsStore.getState().getWsUrl()`. `connect()`'s signature is preserved for backwards compatibility but internally defaults to `getWsUrl()` if not provided.

Option B is simpler and has strictly less state. Pick that unless design finds a reason not to.

### S2. `coreToken` stays cached (for now)

**File:** `mobile/src/services/WebSocketManager.ts`

`this.coreToken` has the same shape as `this.url` — set in `connect()`, read in `reconnectNow()`. In principle it has the same class of bug if the token rotates without `connect()` being called. In practice the token is set once at auth time and lives for the whole session, so this is not a current issue. Leave as-is for this spec. Flag for a follow-up audit.

### S3. `WebsocketStatus.useEffect` does not call `refreshApplets()` on every CONNECTED

**File:** `mobile/src/components/error/WebsocketStatus.tsx`

**Current:** on every CONNECTED transition, the `useEffect` calls `refreshApplets()` unconditionally.

**New behavior:** refresh applets only when transitioning from a "true" disconnected state, not on every flap. Specifically:

- Track the previous connection status via a ref (the code already does this as `prevConnectionStatusRef`).
- Only call `refreshApplets()` when the WS transitions from DISCONNECTED or ERROR _and_ the previous status had been DISCONNECTED/ERROR long enough that we plausibly lost apps data. Propose: only refresh if the WS was observed to have been disconnected for ≥ the disconnection warning threshold (3 s, already defined as `DISCONNECTION_DELAY` in this file).

This isn't a debounce or backoff — it's recognizing that a sub-second flap CONNECTED→DISCONNECTED→CONNECTED within one cycle does not mean the client lost its applet data and needs to re-fetch. A real "was offline for 3+ seconds, now back" event does mean that.

### S4. `detachAndCloseSocket()` awaits the close event

**File:** `mobile/src/services/WebSocketManager.ts`

**Current:** `detachAndCloseSocket()` nulls the handlers, calls `this.webSocket.close()`, and immediately returns. `connect()` then creates a new WebSocket in the same tick.

**New behavior:** before returning from `detachAndCloseSocket()`, await the actual close event (up to a short timeout, e.g. 500 ms). If the timeout fires, proceed anyway — the old connection will be forcibly abandoned and the socket cleanup happens in the native bridge. But waiting the typical 50–200 ms for a clean close eliminates the server-side "stale newer WebSocket already active" overlap in the happy path.

Implementation detail: we can't listen to `onclose` because we just nulled it. We need to either re-attach a one-shot handler, or track the socket state via `readyState` polling (simpler but worse), or restructure so the detach is: attach a fresh one-shot `close` listener that resolves a promise, then null all the other handlers, then call `close()`, then await with timeout.

### S5. No exponential backoff, no retry rate limit, no debounce

Explicitly rejected as fixes. Each of those treats the symptom, not the cause. They let the stale-URL bug continue to lock users out of REST, just more slowly. The root-cause fix above removes the need for any of them.

The existing retry-on-503 code from PR #2565 **stays in place**. Its intent (transient cross-pod recovery during a real pod restart) is valid. With `this.url` no longer stale, the retry's assumption ("reconnect and try again") becomes true: the reconnect lands on the URL that REST is currently targeting, because both read from the same source of truth.

### S6. No server-side rate limit

Explicitly rejected. The server-side WS upgrade rate-limit was proposed earlier as a backstop. With the root-cause fix, WS upgrade volume should drop to normal baseline — no need to rate-limit legitimate clients. If a future regression re-introduces a similar class of bug, we can reconsider, but adding a limit now just hides the bug.

---

## Non-Goals

- **Redesigning cross-pod session replication.** The architecture relies on CF session affinity to keep users on the same pod. That's fine. This fix doesn't touch it.
- **Changing the way `backend_url` is set.** All existing code paths that call `setBackendUrl` or `setSetting(SETTINGS.backend_url.key, ...)` continue to work. The WSM just starts noticing.
- **Fixing the prod-build (non-v2.10) slow reconnect cycle.** one prod-build user's ~11s clean-close cycle observed earlier is a different bug on an older build. Separate issue.
- **Audit of other cached-URL bugs.** `coreToken` in WSM has the same shape but doesn't currently exhibit the bug. Flagged for follow-up, not scoped here.
- **Changing PR #2565's retry-on-503 logic.** The retry is correct once the URL staleness is fixed.
- **Improving `mantle.cleanup()` / `mantle.init()` orchestration.** They're fine as they are; this fix makes them redundant (but still working) rather than required.

---

## Decision Log

| Decision                                                        | Alternatives considered               | Why we chose this                                                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Remove cached `this.url` in WSM (Option B)                      | Option A: subscribe to settings store | Subscribing is more code and introduces a new listener to cleanup. Just deriving the URL on every reconnect is strictly simpler and has less state. No event handler to plumb. |
| Keep cached `this.coreToken`                                    | Audit and fix both fields together    | Token doesn't rotate mid-session in practice. Scope this PR to the one variable that actually caused the observed bug. Flag for later.                                         |
| Fix amplifier (`WebsocketStatus.useEffect`) as defense in depth | Leave it                              | Even with the root cause fixed, this code is wasteful — a fast WS flap still fires a full REST refresh. Cheap to fix.                                                          |
| No exponential backoff                                          | Add 1→60s backoff                     | Explicit non-goal. Treating symptoms. Ships complexity we'd have to remove later.                                                                                              |
| No retry rate limit                                             | Cap retries at 1 per call             | Explicit non-goal. With the root cause fixed, retries will succeed.                                                                                                            |
| No `refreshApplets` debounce                                    | 10s debounce                          | Explicit non-goal. The S3 fix (only refresh on a "real" disconnect) is correctness, not throttling.                                                                            |
| No server-side WS upgrade rate limit                            | Add as backstop                       | Explicit non-goal. Hides the bug.                                                                                                                                              |
| Await close event in `detachAndCloseSocket` with timeout        | Leave the overlap race                | The overlap race is a real but rare bug. A 500 ms timeout is free to add.                                                                                                      |
| Await timeout is 500 ms                                         | 100 ms, 2 s, no timeout               | 500 ms is long enough for typical TCP close handshake, short enough that it won't noticeably delay legitimate reconnects. No timeout risks hanging on a dead socket.           |

---

## Testing

### Root cause acceptance

1. On a dev build, connect the app to `api.mentra.glass` and establish a session.
2. Open the dev settings `BackendUrl` screen.
3. **Without** tapping Save (i.e. without triggering the `mantle.cleanup() + mantle.init()` flow), change `backend_url` programmatically via the Metro debug console (`useSettingsStore.getState().setSetting(SETTINGS.backend_url.key, "https://devapi.mentra.glass")`).
4. Wait 5 seconds.
5. **Expected:** WSM notices the URL change and reconnects cleanly to `devapi.mentra.glass`. REST and WS both land on `us-central-dev`. No 503s. No storm.

### Reproduction of original bug

1. Same as acceptance but run against the pre-fix build first to confirm the reproducer hits.
2. Measure WS opens/minute over 2 minutes.
3. **Expected on pre-fix:** 80–100 opens/minute sustained.
4. **Expected on post-fix:** 0 extra opens — at most a single clean reconnect to the new URL.

### Amplifier test

1. On a dev build, simulate a brief WS drop by force-closing the TCP connection at the OS level (Android: disable Wi-Fi for 500 ms and re-enable).
2. **Expected:** one `refreshApplets()` call after the 3-second disconnection threshold, not one per CONNECTED transition.

### Overlap test

1. On a dev build, trigger a WS reconnect via `reconnectNow`.
2. Watch server logs for the reproducer user.
3. **Expected:** zero `"stale — newer WebSocket already active"` log lines. The close for the old socket is observed server-side before the new one is upgraded.

### Regression checks

- Normal app startup: log in, connect, use the app. Single WS open. No extra reconnects.
- Standard backend change via `BackendUrl.tsx handleSaveUrl`: still works, same UX.
- Force-close recovery: kill app, reopen, connect. Single WS open.
- Pod restart (simulated by kubectl delete pod on cloud-debug): one WS reconnect per client, not a storm.

---

## Rollout

1. **Branch** `mobile/ws-reconnect-storm-fix` off `origin/dev`.
2. **PR to `dev`** with S1, S3, S4. Land as one change.
3. **Soak on dev/staging for 24 hours.** Reproduce the scenario from "Root cause acceptance" above, confirm no storm.
4. **Cherry-pick to a v2.10.1 hotfix tag.** Release to TestFlight / Play Store Beta.
5. **Production release as v2.11** after one week of stable observation on TestFlight.
6. **Backport to `main`** (which doesn't currently have #2565's retry code but does have the `this.url` bug pattern if anything changes `backend_url` outside BackendUrl.tsx). This is lower priority because main is not the storm source today.

---

## Key Numbers

| Metric                                          | Before (v2.10)              | After (post-fix)                      |
| ----------------------------------------------- | --------------------------- | ------------------------------------- |
| WS opens/min under reproducer                   | ~90 peak, ~87 sustained     | 0 extra (single reconnect to new URL) |
| REST 503s/second during reproducer              | ~20                         | 0                                     |
| Server-side stale-close log rate                | occasional                  | ~0                                    |
| User-visible recovery time after backend switch | requires force-close        | < 1 s                                 |
| Cloud transient heap churn per reproducer-hour  | ~100+ MB/hr from one client | negligible                            |
