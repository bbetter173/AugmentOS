# Design: Mobile WebSocket Reconnect Storm (Implementation)

## Overview

**What this doc covers:** File-by-file implementation plan for the fix in [spec.md](./spec.md). Two coordinated changes to WebSocketManager (always-derive URL, plus Zustand subscription to backend_url) and two defense-in-depth changes (await close event, gate applet refresh on sustained disconnect).

**What you need to know first:** [spike.md](./spike.md), [spec.md](./spec.md).

**Who should read this:** PR reviewers.

---

## Branch Plan

One branch, one PR. All four changes land together: they are tightly related, small individually, and share testing.

Branch: `mobile/ws-reconnect-storm-fix` off `origin/dev`. Already created.

---

## Changes Summary

| Component                    | File                                                                                            | What changes                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| WSM always-derive URL        | `mobile/src/services/WebSocketManager.ts`                                                       | Remove `this.url`, derive URL fresh from the settings store on every connect/reconnect                |
| WSM backend_url subscription | `mobile/src/services/WebSocketManager.ts`                                                       | Subscribe to Zustand `backend_url` selector; reconnect immediately on change                          |
| WSM await close              | `mobile/src/services/WebSocketManager.ts`                                                       | `detachAndCloseSocket` awaits the close event with a 500 ms timeout                                   |
| Async plumbing               | `mobile/src/services/SocketComms.ts`, `MantleManager.ts`, `app/miniapps/settings/developer.tsx` | `cleanup`, `restartConnection`, `connectWebsocket` callers updated to await the new async WSM methods |
| Applet refresh gate          | `mobile/src/components/error/WebsocketStatus.tsx`                                               | Only refresh on transition from sustained-disconnected                                                |

All in the same PR. Actual diff: about 300 lines added, 140 removed, across 5 files.

---

## WebSocketManager Changes

### Change D1: Remove `this.url` as a cached field; always derive from the settings store

**File:** `mobile/src/services/WebSocketManager.ts`

**Current fields (around L33–L44):**

```typescript
class WebSocketManager extends EventEmitter {
  private static instance: WebSocketManager | null = null
  private webSocket: WebSocket | null = null
  private previousStatus: WebSocketStatus = WebSocketStatus.DISCONNECTED
  private url: string | null = null
  private coreToken: string | null = null
  private reconnectInterval: ReturnType<typeof BackgroundTimer.setInterval> = 0
  private manuallyDisconnected: boolean = false
  // ...
}
```

**New:**

```typescript
class WebSocketManager extends EventEmitter {
  private static instance: WebSocketManager | null = null
  private webSocket: WebSocket | null = null
  private previousStatus: WebSocketStatus = WebSocketStatus.DISCONNECTED
  private coreToken: string | null = null
  private reconnectInterval: ReturnType<typeof BackgroundTimer.setInterval> = 0
  private manuallyDisconnected: boolean = false
  // ...
}
```

`this.url` is gone.

**Current `connect()` signature (around L102):**

```typescript
public connect(url: string, coreToken: string) {
  console.log(`WSM: connect: ${url}`)
  this.manuallyDisconnected = false
  this.url = url
  this.coreToken = coreToken
  // ...
}
```

**New:**

```typescript
public async connect(coreToken: string) {
  const url = useSettingsStore.getState().getWsUrl()
  console.log(`WSM: connect: ${url}`)
  this.manuallyDisconnected = false
  this.coreToken = coreToken

  // Tear down any existing connection cleanly (awaits the close)
  this.stopLivenessMonitor()
  await this.detachAndCloseSocket()

  // Update status and store URL (for observability)
  this.updateStatus(WebSocketStatus.CONNECTING)
  const store = useConnectionStore.getState()
  store.setUrl(url)

  // Create new WebSocket with authorization
  const wsUrl = new URL(url)
  wsUrl.searchParams.set("token", coreToken)
  wsUrl.searchParams.set("livekit", "true")
  wsUrl.searchParams.set("udpEncryption", "true")
  console.log("WSM: Connecting to WebSocket URL:", wsUrl.toString().replace(/token=[^&]+/, "token=REDACTED"))

  this.webSocket = new WebSocket(wsUrl.toString())
  this.installWebSocketHandlers()
}

private installWebSocketHandlers() {
  if (!this.webSocket) return
  const store = useConnectionStore.getState()

  this.webSocket.onopen = () => {
    console.log("WSM: WebSocket connection established")
    this.updateStatus(WebSocketStatus.CONNECTED)
    this.startLivenessMonitor()
  }
  this.webSocket.onmessage = (event) => {
    this.handleIncomingMessage(event.data)
  }
  this.webSocket.onerror = (error) => {
    console.log("WSM: WebSocket error:", error)
    this.stopLivenessMonitor()
    this.updateStatus(WebSocketStatus.ERROR)
    store.setError(error?.toString() || "WebSocket error")
    this.startReconnectInterval()
  }
  this.webSocket.onclose = (event) => {
    console.log("WSM: Connection closed with code:", event.code)
    this.stopLivenessMonitor()
    this.updateStatus(WebSocketStatus.DISCONNECTED)
    this.startReconnectInterval()
  }
}
```

Key differences:

- `connect()` takes only `coreToken` now; URL is always read from `getWsUrl()` at call time.
- The event-handler installation is extracted into a helper so it can be reused without duplication.
- `connect()` is now `async` because `detachAndCloseSocket()` is now `async`.

**Current `actuallyReconnect()`:**

```typescript
private actuallyReconnect() {
  console.log("WSM: Attempting reconnect")
  const store = useConnectionStore.getState()

  if (store.status === WebSocketStatus.DISCONNECTED || store.status === WebSocketStatus.ERROR) {
    if (this.url && this.coreToken) {
      this.connect(this.url, this.coreToken)
    }
  }
  if (store.status === WebSocketStatus.CONNECTED) {
    console.log("WSM: Connected, stopping reconnect interval")
    BackgroundTimer.clearInterval(this.reconnectInterval)
  }
}
```

**New:**

```typescript
private actuallyReconnect() {
  console.log("WSM: Attempting reconnect")
  const store = useConnectionStore.getState()

  if (store.status === WebSocketStatus.DISCONNECTED || store.status === WebSocketStatus.ERROR) {
    if (this.coreToken) {
      // URL is read fresh from the settings store inside connect().
      void this.connect(this.coreToken)
    }
  }
  if (store.status === WebSocketStatus.CONNECTED) {
    console.log("WSM: Connected, stopping reconnect interval")
    BackgroundTimer.clearInterval(this.reconnectInterval)
  }
}
```

**Current `reconnectNow()`:**

```typescript
private reconnectNow(reason: string) {
  console.log(`WSM: Immediate reconnect requested: ${reason}`)
  if (this.manuallyDisconnected) {
    return
  }

  if (this.reconnectInterval) {
    BackgroundTimer.clearInterval(this.reconnectInterval)
    this.reconnectInterval = 0
  }

  this.stopLivenessMonitor()
  this.detachAndCloseSocket()
  this.updateStatus(WebSocketStatus.DISCONNECTED)

  if (this.url && this.coreToken) {
    this.connect(this.url, this.coreToken)
    return
  }

  this.startReconnectInterval()
}
```

**New:**

```typescript
private async reconnectNow(reason: string): Promise<void> {
  console.log(`WSM: Immediate reconnect requested: ${reason}`)
  if (this.manuallyDisconnected) {
    return
  }

  if (this.reconnectInterval) {
    BackgroundTimer.clearInterval(this.reconnectInterval)
    this.reconnectInterval = 0
  }

  if (this.coreToken) {
    // connect() handles teardown, URL read from settings, and new socket.
    await this.connect(this.coreToken)
    return
  }

  this.startReconnectInterval()
}

private handleNoActiveSession = () => {
  if (this.previousStatus === WebSocketStatus.CONNECTING) {
    return
  }
  void this.reconnectNow("REST request returned NO_ACTIVE_SESSION")
}
```

Note: `reconnectNow` previously called `this.detachAndCloseSocket()` and `this.updateStatus(DISCONNECTED)` before calling `connect()`. That's now redundant because `connect()` does the same tear-down at its start. Remove the duplicate calls.

### Change D2: Subscribe to backend_url Zustand changes

**File:** `mobile/src/services/WebSocketManager.ts`

**Rationale:** The always-derive fix (D1) alone closes the root cause but leaves a user-visible gap. If the user changes `backend_url` in dev settings without triggering any other reconnect signal (no 503, no server close, no ping timeout), the WS keeps running on the old backend because nothing tells it to reconnect. On a healthy connection that could be minutes. Users expect the switch to happen immediately when they tap Save.

**New field:**

```typescript
// Zustand subscription: fires when backend_url changes so we can
// proactively tear down the old WS and reconnect to the new backend.
// Without this, a Zustand update without a corresponding ws.connect()
// call would leave WSM on the old URL until the next reconnect trigger
// (ping timeout, server close, NO_ACTIVE_SESSION).
private backendUrlUnsub: (() => void) | null = null
```

**Subscription installed in the constructor:**

```typescript
private constructor() {
  super()
  GlobalEventEmitter.on("NO_ACTIVE_SESSION", this.handleNoActiveSession)

  this.backendUrlUnsub = useSettingsStore.subscribe(
    (state) => state.getSetting(SETTINGS.backend_url.key) as string | undefined,
    (newBackendUrl, prevBackendUrl) => {
      if (!newBackendUrl || newBackendUrl === prevBackendUrl) return
      this.handleBackendUrlChanged(newBackendUrl, prevBackendUrl)
    },
  )
}
```

This uses the `subscribeWithSelector` middleware already enabled on `useSettingsStore` (see `mobile/src/stores/settings.ts`). The selector returns the current `backend_url` value; the handler fires only when that value actually changes.

**Handler:**

```typescript
private handleBackendUrlChanged(newBackendUrl: string, prevBackendUrl: string | undefined): void {
  const currentStoreUrl = useConnectionStore.getState().url
  console.log(
    `WSM: backend_url changed ${prevBackendUrl ?? "(unset)"} -> ${newBackendUrl} (WS currently pointed at ${currentStoreUrl ?? "(none)"})`,
  )

  if (this.manuallyDisconnected) {
    // If the caller explicitly disconnected, trust that. The next
    // connect() call will read the fresh URL.
    return
  }

  if (!this.coreToken) {
    // No auth yet. Nothing to reconnect with. The next connect() call
    // from mantle.init() will pick up the new URL.
    return
  }

  void this.reconnectNow(`backend_url changed to ${newBackendUrl}`)
}
```

Three guards, each preventing a real bug:

- `manuallyDisconnected`: the caller is already orchestrating a disconnect (e.g., during `mantle.cleanup()` mid-switch). If we also kick a reconnect here, we race with them.
- `coreToken` null: we are pre-auth. `reconnectNow` would fall through to `startReconnectInterval()` which would later try to call `connect()` with no token. Cleaner to let `mantle.init()` drive the first connect.
- Neither set: call `reconnectNow` which routes through the standard teardown-then-connect path. `connect()` reads the URL fresh from the settings store, so we pick up the new value automatically.

**Cleanup in `cleanup()`:**

```typescript
public async cleanup(): Promise<void> {
  console.log("WSM: cleanup()")
  if (this.backendUrlUnsub) {
    this.backendUrlUnsub()
    this.backendUrlUnsub = null
  }
  await this.disconnect()
  this.webSocket = null
  const store = useConnectionStore.getState()
  store.reset()
}
```

Net effect: any `setSetting(backend_url, newUrl)` call triggers an immediate reconnect, with a debuggable log line showing the old vs new URL.

---

### Change D3: `detachAndCloseSocket` awaits the close event

**File:** `mobile/src/services/WebSocketManager.ts`

**Current (L95–L104):**

```typescript
private detachAndCloseSocket() {
  if (this.webSocket) {
    this.webSocket.onclose = null
    this.webSocket.onerror = null
    this.webSocket.onmessage = null
    this.webSocket.onopen = null
    this.webSocket.close()
    this.webSocket = null
  }
}
```

**New:**

```typescript
private readonly CLOSE_WAIT_TIMEOUT_MS = 500

private async detachAndCloseSocket(): Promise<void> {
  const sock = this.webSocket
  if (!sock) return

  // Clear reference first so nothing else can see the old socket.
  this.webSocket = null

  // Install a one-shot close listener to await the clean TCP close before
  // letting the caller proceed. Without this, a subsequent connect() can
  // create a new WebSocket while the old one is still finishing its close
  // handshake, producing server-side "stale, newer WebSocket already
  // active" log lines. See: cloud/issues/101-mobile-ws-reconnect-storm/
  const closePromise = new Promise<void>((resolve) => {
    sock.onclose = () => resolve()
    sock.onerror = () => resolve()
  })

  // Null the other handlers so they don't fire during the wait.
  sock.onmessage = null
  sock.onopen = null

  sock.close()

  await Promise.race([
    closePromise,
    new Promise<void>((resolve) => BackgroundTimer.setTimeout(resolve, this.CLOSE_WAIT_TIMEOUT_MS)),
  ])

  // Whatever happens after this, the old socket is no longer our concern.
  sock.onclose = null
  sock.onerror = null
}
```

The key change: we keep a one-shot `onclose` handler on the old socket just long enough to resolve the wait promise, then null it. If the close takes longer than `CLOSE_WAIT_TIMEOUT_MS`, we proceed anyway; the native bridge will eventually close the socket on its own schedule.

### Change D4: `disconnect()` becomes async

**Current:**

```typescript
public disconnect() {
  this.manuallyDisconnected = true
  if (this.reconnectInterval) {
    BackgroundTimer.clearInterval(this.reconnectInterval)
    this.reconnectInterval = 0
  }
  this.stopLivenessMonitor()
  this.detachAndCloseSocket()
  this.updateStatus(WebSocketStatus.DISCONNECTED)
}
```

**New:**

```typescript
public async disconnect(): Promise<void> {
  this.manuallyDisconnected = true
  if (this.reconnectInterval) {
    BackgroundTimer.clearInterval(this.reconnectInterval)
    this.reconnectInterval = 0
  }
  this.stopLivenessMonitor()
  await this.detachAndCloseSocket()
  this.updateStatus(WebSocketStatus.DISCONNECTED)
}
```

### Change D5: Callers adapt to the new async signatures

**Files:**

- `mobile/src/services/SocketComms.ts`
- `mobile/src/services/MantleManager.ts`

**`SocketComms.connectWebsocket`** currently calls `ws.connect(url, this.coreToken)` with a URL argument. Update:

```typescript
public async connectWebsocket() {
  console.log("SOCKET: connectWebsocket()")
  this.setupListeners()
  // ws.connect reads the URL freshly from the settings store.
  await ws.connect(this.coreToken)
}
```

**`SocketComms.cleanup`** calls `ws.cleanup()` which in turn calls `disconnect()`. Now async:

```typescript
public async cleanup() {
  console.log("SOCKET: cleanup()")
  await udp.cleanup()       // already async
  await ws.cleanup()
}
```

And `ws.cleanup`:

```typescript
public async cleanup() {
  console.log("WSM: cleanup()")
  await this.disconnect()
  this.webSocket = null
  const store = useConnectionStore.getState()
  store.reset()
}
```

**`MantleManager.cleanup`** already awaits its callees. Preserves behavior.

**`SocketComms.restartConnection`**:

```typescript
public async restartConnection() {
  console.log(`SOCKET: restartConnection()`)
  if (ws.isConnected()) {
    await ws.disconnect()
    await this.connectWebsocket()
  } else {
    await this.connectWebsocket()
  }
}
```

### Why we ship both "always-derive" AND "subscription"

Initial design was always-derive only. Testing on-device revealed the UX gap: when the user hits Save & Test URL in dev settings, `setSetting(backend_url, newUrl)` updates Zustand instantly, axios's next REST call goes to the new backend. But the WS stays on the old backend until something independently triggers a reconnect. For a healthy connection with no 503 pressure, that could be minutes (on the next ping timeout or server-side close). Users expect an immediate switch.

Subscription layer handles that. WSM subscribes to `useSettingsStore`'s `backend_url` selector. On change, it calls `reconnectNow()` which tears down and reconnects against the fresh URL.

Why both together: always-derive is what makes the root cause structurally unfixable (there is no `this.url` field to go stale). The subscription is what makes the behavior match user expectation. Without always-derive, the subscription would still technically work but `this.url` could race with the selector value during a reconnect. Without the subscription, a backend URL change in a healthy WS session has a delayed effect.

Subscription handler:

```typescript
private handleBackendUrlChanged(newBackendUrl: string, prevBackendUrl: string | undefined): void {
  if (this.manuallyDisconnected) return
  if (!this.coreToken) return
  void this.reconnectNow(`backend_url changed to ${newBackendUrl}`)
}
```

Three guards:

- `manuallyDisconnected` , the caller explicitly disconnected (e.g. during `mantle.cleanup()` mid-switch); honor that and let the next `connect()` pick up the URL.
- `coreToken` missing: we are pre-auth; no token to reconnect with. First `connect()` from `mantle.init()` will use the current URL.
- Otherwise: call `reconnectNow()` which goes through the standard teardown-then-connect path. `connect()` reads from the settings store inside, so whatever the current URL is at the moment of the new WS, that's what gets used.

Cleanup unsubscribes in `cleanup()`.

---

## WebsocketStatus Changes

### Change D6: `refreshApplets()` only on transition from sustained-disconnected

**File:** `mobile/src/components/error/WebsocketStatus.tsx`

**Current (L50–L91):**

```typescript
useEffect(() => {
  const prevStatus = prevConnectionStatusRef.current
  prevConnectionStatusRef.current = connectionStatus

  console.log(`WSM: useEffect: connectionStatus: ${connectionStatus}`)

  if (connectionStatus === WebSocketStatus.CONNECTED) {
    if (disconnectionTimerRef.current) {
      BackgroundTimer.clearTimeout(disconnectionTimerRef.current)
      disconnectionTimerRef.current = null
    }
    setDisplayStatus("connected")
    refreshApplets()
    return
  }

  if (prevStatus === WebSocketStatus.CONNECTED) {
    setDisplayStatus("warning")
    if (disconnectionTimerRef.current) {
      BackgroundTimer.clearTimeout(disconnectionTimerRef.current)
      disconnectionTimerRef.current = null
    }
    disconnectionTimerRef.current = BackgroundTimer.setTimeout(() => {
      setDisplayStatus("disconnected")
      refreshApplets()
    }, DISCONNECTION_DELAY)
    return
  }

  return () => {
    if (disconnectionTimerRef.current) {
      BackgroundTimer.clearTimeout(disconnectionTimerRef.current)
      disconnectionTimerRef.current = null
    }
  }
}, [connectionStatus])
```

**New:**

```typescript
// Track whether we observed the WS as disconnected for long enough that
// we may have missed applet state changes from the server. Set by the
// DISCONNECTION_DELAY timer below. Cleared on next CONNECTED after the
// refresh fires. Under the reconnect storm (issue 101), a sub-second
// CONNECTED → DISCONNECTED → CONNECTED flap does not mean we lost applet
// data. Only a real "offline for N seconds" event does.
const wasSustainedDisconnectedRef = useRef(false)

useEffect(() => {
  const prevStatus = prevConnectionStatusRef.current
  prevConnectionStatusRef.current = connectionStatus

  console.log(`WSM: useEffect: connectionStatus: ${connectionStatus}`)

  if (connectionStatus === WebSocketStatus.CONNECTED) {
    if (disconnectionTimerRef.current) {
      BackgroundTimer.clearTimeout(disconnectionTimerRef.current)
      disconnectionTimerRef.current = null
    }
    setDisplayStatus("connected")

    // Only refresh applets if we were "really" disconnected,
    // that is, for at least DISCONNECTION_DELAY (3s). A brief flap during a reconnect storm
    // is not evidence we lost applet state.
    if (wasSustainedDisconnectedRef.current) {
      wasSustainedDisconnectedRef.current = false
      refreshApplets()
    }
    return
  }

  if (prevStatus === WebSocketStatus.CONNECTED) {
    setDisplayStatus("warning")
    if (disconnectionTimerRef.current) {
      BackgroundTimer.clearTimeout(disconnectionTimerRef.current)
      disconnectionTimerRef.current = null
    }
    disconnectionTimerRef.current = BackgroundTimer.setTimeout(() => {
      setDisplayStatus("disconnected")
      wasSustainedDisconnectedRef.current = true
      refreshApplets()
    }, DISCONNECTION_DELAY)
    return
  }

  return () => {
    if (disconnectionTimerRef.current) {
      BackgroundTimer.clearTimeout(disconnectionTimerRef.current)
      disconnectionTimerRef.current = null
    }
  }
}, [connectionStatus])
```

The refresh still fires in two places:

- After 3 seconds of sustained DISCONNECTED (when the user is "really" offline and we want them to see fresh data when they come back)
- On the next CONNECTED if we previously observed a sustained-disconnected state

A transient flap (CONNECTED → DISCONNECTED → CONNECTED within 3s) triggers neither refresh. This is not a debounce or rate-limit. It is correctness. A brief flap doesn't invalidate our applet state.

---

## Constants and Imports

### Added to `WebSocketManager.ts`:

```typescript
import {useSettingsStore, SETTINGS} from "@/stores/settings"
```

Already imported in `SocketComms.ts`; adding here to access `getWsUrl()` and the settings key.

### Added to `WebsocketStatus.tsx`:

No new imports. Uses the existing `wasSustainedDisconnectedRef`.

---

## Testing

### Unit-level (local)

1. `bun run lint` passes.
2. `bun run typecheck` passes.
3. Start the mobile app in dev mode. Log in. Observe one `connect()` call.
4. Manually trigger a URL change via Metro debug console:
   ```
   useSettingsStore.getState().setSetting(SETTINGS.backend_url.key, "https://devapi.mentra.glass")
   ```
   No reconnect should happen immediately (no event triggers one).
5. Make a REST call (e.g. navigate to a screen that calls `getApplets`). The REST call goes to `devapi` and returns 503. The retry-on-503 emits `NO_ACTIVE_SESSION`. WSM reconnects; `connect()` reads fresh URL from settings; lands on `devapi`. Retry succeeds. No storm.

### Integration (dev/staging soak)

1. Deploy the branch to TestFlight Beta / Play Store Internal.
2. Reproduce the bug as originally observed: change backend URL in dev settings, observe for 2 minutes.
3. **Expected:** zero extra WS opens beyond the single reconnect to new URL. No 503 loop.
4. Spot-check 3–5 other known affected users from production logs over the next 24 hours. Expected: zero of them exhibit the storm pattern.

### Regression (dev)

- Cold-start app launch: one WS open, one REST settings load, standard flow.
- Force-close and relaunch: one WS open, no extra reconnects.
- BackendUrl.tsx Save flow: working as before (standard `mantle.cleanup + init` still happens; WSM now just gets the URL fresh within `connect()`).
- Network drop (disable Wi-Fi 10 s, re-enable): one WS reconnect, one `refreshApplets` call (after sustained-disconnected flag fires).

---

## Rollout

1. **Land PR to `origin/dev`.**
2. **Dev/staging soak 24h.** TestFlight Beta users exercise the reproducer.
3. **Cherry-pick to `v2.10.1`** hotfix branch. Release to stores.
4. **Observe production** for 1 week. Confirm no reports of "apps broken, can't recover without force-close." Confirm the WS-opens-per-minute metric for known reproducers drops to baseline.
5. **Full release as `v2.11`** with the fix plus any other accumulated dev changes.
6. **Backport to `main`** for eventual merge. Low urgency because main's retry logic is different (the stale-URL bug exists on main too and should be fixed there).

---

## Decision Log

| Decision                                                               | Alternatives considered                                                  | Why we chose this                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ship always-derive AND a Zustand subscription                          | Always-derive only                                                       | On-device testing showed users expect the WS to switch immediately when they change backend URL in dev settings. Without the subscription, the switch is delayed until the next reconnect trigger. Adding the subscription is ~25 lines. Strictly less total cost than shipping always-derive alone and iterating. |
| Keep `connect()`'s `url` parameter for backward compatibility          | Drop it and force `SocketComms.connectWebsocket` to change its signature | Keeping the parameter and ignoring it inside WSM (with a warning log on mismatch) is one line of code less to ship. Future cleanup can drop it in a separate PR. Earlier version of this doc said to drop it; changed after testing showed no caller benefits from the change.                                     |
| Keep `this.coreToken` cached                                           | Also derive fresh                                                        | Token does not rotate mid-session. No observed bug pattern. Scope this PR to the one cached field that actually caused the storm.                                                                                                                                                                                  |
| `detachAndCloseSocket` awaits close via one-shot listener              | Poll `readyState`; use native bridge                                     | Listener is the correct abstraction. Polling is hacky. Native bridge is over-engineering.                                                                                                                                                                                                                          |
| 500 ms timeout on close wait                                           | 100 ms, 2 s, no timeout                                                  | 500 ms covers typical TCP close latency (50 to 200 ms) with margin. Short enough not to noticeably delay legitimate reconnects. No timeout would risk hanging on a dead socket.                                                                                                                                    |
| `WebsocketStatus` uses a React ref to track sustained-disconnected     | New Zustand state                                                        | Local concern to this one component. No other component cares. Ref is the simplest expression.                                                                                                                                                                                                                     |
| Leave `refreshApplets` call inside the 3s disconnect-then-refresh path | Always refresh on CONNECTED with a 3s debounce                           | The 3s disconnect threshold already encodes the "were we really offline" check. Don't duplicate it.                                                                                                                                                                                                                |
| Subscription handler guards on `manuallyDisconnected` and `coreToken`  | Always reconnect on any `backend_url` change                             | Without the guards the subscription fights with mid-cleanup flows and fires pointless reconnects pre-auth. Guards make the behavior predictable and debuggable.                                                                                                                                                    |

---

## Risks And Open Questions

**Risk: an intermediate caller could pass a URL that disagrees with the settings store.** The shipped code logs a warning and proceeds with the settings-store value. That's safer than honoring the caller's argument, because the caller might be stale. Low risk today (only one caller: `SocketComms.connectWebsocket`).

**Risk: race between a `backend_url` write and a pending WS reconnect.** If `backend_url` changes at the exact moment `actuallyReconnect()` is running, the reconnect reads the new URL inside `connect()`. That is the desired outcome. If `actuallyReconnect` finishes CONNECTED on the old URL before the Zustand change is visible, the subscription (D2) fires next and triggers a fresh reconnect. One extra cycle maximum, not a storm. Acceptable.

**Risk: subscription fires during `cleanup()`.** The unsubscribe in `cleanup()` runs before `disconnect()` so the handler cannot fire while we are tearing down. Also guarded by `manuallyDisconnected` check inside the handler.

**Observability: log line on backend_url change.** Shipped. The handler logs the old and new URL plus the currently-connected URL. See sample log sequence in spec.md "Root cause acceptance".

---

## Summary

One cached field removed (`this.url`), one Zustand subscription added, two helpers made async, one React component useEffect tightened up. About 300 lines added and 140 removed across 5 files. No new dependencies, no new state machines, no rate limiters, no debouncers. Addresses the actual root cause and closes the dev-settings UX gap that always-derive alone left open.
