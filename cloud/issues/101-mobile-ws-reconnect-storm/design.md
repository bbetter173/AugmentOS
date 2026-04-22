# Design: Mobile WebSocket Reconnect Storm — Implementation

## Overview

**What this doc covers:** File-by-file implementation plan for the root-cause fix in [spec.md](./spec.md). The core change is removing `WebSocketManager.this.url` as a cached variable and always reading the WS URL freshly from the settings store when reconnecting. Plus two small defense-in-depth changes.

**What you need to know first:** [spike.md](./spike.md), [spec.md](./spec.md).

**Who should read this:** PR reviewers.

---

## Branch Plan

One branch, one PR. All three changes land together — they're tightly related, small individually, and share testing.

Branch: `mobile/ws-reconnect-storm-fix` off `origin/dev`. Already created.

---

## Changes Summary

| Component             | File                                              | What changes                                                  |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| WSM always-derive URL | `mobile/src/services/WebSocketManager.ts`         | Remove `this.url`, derive URL fresh on reconnect              |
| WSM await close       | `mobile/src/services/WebSocketManager.ts`         | `detachAndCloseSocket` awaits close event with 500 ms timeout |
| Applet refresh gate   | `mobile/src/components/error/WebsocketStatus.tsx` | Only refresh on transition from sustained-disconnected        |

All three in the same PR. Total diff estimate: ~80 lines.

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

### Change D2: `detachAndCloseSocket` awaits the close event

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
  // handshake, producing server-side "stale — newer WebSocket already
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

### Change D3: `disconnect()` becomes async

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

### Change D4: Callers adapt to the new async signatures

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

### Why we chose remove-cached-URL over reactive-subscription

Explicit per Decision Log in spec: simpler, less state. Let's spell out why in code terms.

Subscription-based version would look like:

```typescript
// In constructor:
this.settingsUnsub = useSettingsStore.subscribe(
  (state) => state.getSetting(SETTINGS.backend_url.key) as string,
  (newUrl, prevUrl) => {
    if (newUrl !== prevUrl && this.coreToken) {
      void this.connect(this.coreToken)
    }
  },
)
```

That works. But it introduces:

- A new listener to clean up in `cleanup()`.
- An edge case where the subscription fires during `cleanup()` itself (need to check `manuallyDisconnected` inside the handler).
- A subtle ordering problem: if multiple settings changes happen in quick succession, the subscription fires N times. Race conditions on `coreToken` being set mid-change.

The always-derive approach has none of these. Every `reconnectNow` / `actuallyReconnect` / `connect` reads the current URL and uses it. If `backend_url` changes, the NEXT reconnect picks up the new URL. That does mean "picking up the new URL" happens whenever the WS next reconnects — which might be immediate (if it's already in a reconnect loop) or after the next onclose.

For the storm scenario: the retry-on-503 path immediately triggers a reconnect, which reads the fresh URL, which lands on the right pod, which completes the REST request successfully. No storm.

For the "user changes backend URL in dev settings without triggering cleanup" edge case: the WS stays on the old backend until something forces a reconnect. That's acceptable — REST goes to the new backend, which 503s once, retry-on-503 triggers reconnect, WS switches. Fine.

The only case always-derive handles worse than subscription: a backend URL change during a long idle period where no reconnect would naturally happen. But that also can't cause a storm because there's nothing firing REST calls.

---

## WebsocketStatus Changes

### Change D5: `refreshApplets()` only on transition from sustained-disconnected

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
// data — only a real "offline for N seconds" event does.
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

    // Only refresh applets if we were "really" disconnected — i.e. for at
    // least DISCONNECTION_DELAY (3s). A brief flap during a reconnect storm
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

A transient flap (CONNECTED → DISCONNECTED → CONNECTED within 3s) triggers neither refresh. This is not a debounce or rate-limit — it's correctness. A brief flap doesn't invalidate our applet state.

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
6. **Backport to `main`** for eventual merge. Low urgency because main's retry logic is different — but the stale-URL bug exists on main too and should be fixed there.

---

## Decision Log

| Decision                                                               | Alternatives considered                              | Why we chose this                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove `this.url` (always-derive)                                      | Reactive subscription to settings store              | Simpler. No listener to clean up. No edge cases around subscription firing during cleanup. Strictly less state to reason about.                                                                                                          |
| Keep `this.coreToken` cached                                           | Also derive fresh                                    | Token doesn't rotate mid-session; no observed bug pattern. Reducing scope to what's actually broken. Flag for follow-up audit.                                                                                                           |
| `connect()` signature drops `url` argument                             | Keep `url` arg, default to `getWsUrl()` if undefined | Current callers all pass the URL as a prop of "give me this URL specifically." But the bug is that the URL should never be sticky. Dropping the arg forces callers to go through the settings store, which is the right source of truth. |
| `detachAndCloseSocket` awaits close via one-shot listener              | Poll `readyState`; use raw native bridge             | Listener is the correct abstraction. `readyState` polling is hacky. Native bridge is over-engineering.                                                                                                                                   |
| 500 ms timeout on close wait                                           | 100 ms, 2 s, no timeout                              | 500 ms covers typical TCP close latency (50–200 ms) with margin. Short enough to not noticeably delay legitimate reconnects. No timeout risks hanging on a dead socket.                                                                  |
| `WebsocketStatus` uses a ref to track sustained-disconnected           | New Zustand state                                    | Local concern to this component. No other component cares about this flag. Ref is the simplest expression.                                                                                                                               |
| Leave `refreshApplets` call inside the 3s disconnect-then-refresh path | Always refresh on CONNECTED + 3s debounce            | The 3s disconnect threshold already encodes the "were we really offline" check. Don't duplicate it.                                                                                                                                      |

---

## Risks And Open Questions

**Risk: an intermediate caller could pass a URL that doesn't match the settings store.** `socketComms.connectWebsocket()` is the only caller of `ws.connect`, and it now reads from settings itself (passing just the token). If someone adds another caller that passes a URL argument to an older signature, TypeScript will flag the signature change. Low risk.

**Risk: race between a Zustand `backend_url` write and a pending WS reconnect.** If `backend_url` changes at the exact moment `actuallyReconnect()` is running, the reconnect reads the new URL — good, that's what we want. But if `actuallyReconnect` is mid-flight and then finishes CONNECTED on the old URL before the change is visible, the next REST call will 503 against the new URL and trigger another reconnect cycle. That's one extra cycle max, not a storm. Acceptable.

**Open question: should `connect()` read the URL inside the new `installWebSocketHandlers()` helper, or in the body?** Current design reads in the body. Leaves room for someone to later pass a URL override if needed. Keeping the read in the body is fine.

**Open question: do we want a log line when the URL derived by `connect()` differs from the URL of the currently-open socket?** Useful observability signal: "the WSM just noticed a URL change." Cheap to add. Propose yes, add as a single `logger.info`.

---

## Summary

One field removed, two helpers refactored, one component useEffect tightened up. ~80 lines changed. No new dependencies, no new state machines, no new rate limiters or debouncers. Addresses the actual root cause.
