# Spike: Soniox WebSocket Connection Timeout Crash

## Overview

**What this doc covers:** Investigation into an unhandled promise rejection in `SonioxTranslationProvider.connect()` that crashes the Bun process with exit code 1 when the Soniox WebSocket connection times out. This is the second unhandled-rejection crash pattern we've found (after the ResourceTracker issue in 068), exposed by the heap growth fix extending pod lifetime.
**Why this doc exists:** US Central crashed at 23:07 UTC on March 29 after 3 hours 45 minutes of stable uptime with 84 sessions. The previous crash pattern (ResourceTracker) was fixed in issue 068, but this is a different code path with the same class of bug — an unhandled `reject()` inside an async operation that kills the entire process.
**Who should read this:** Cloud engineers, anyone working on translation/transcription providers.

**Depends on:**

- [068-resource-tracker-crash](../068-resource-tracker-crash/) — first instance of this bug pattern (ResourceTracker.track() throw)
- [067-heap-growth-investigation](../067-heap-growth-investigation/) — heap growth fix that extended pod lifetime, exposing these latent bugs

---

## Background

`SonioxTranslationProvider.connect()` establishes a WebSocket connection to the Soniox translation API. It wraps the connection in a `new Promise()` with a `setTimeout` that calls `reject()` if the connection doesn't complete within the timeout window. If the Soniox API is temporarily unreachable or slow, the timeout fires and rejects the promise.

The problem: if the caller doesn't `.catch()` the rejection (or if the rejection propagates through an unhandled async chain), Bun treats it as an unhandled promise rejection and exits with code 1.

---

## Findings

### 1. The crash stack trace

From Porter's previous container logs:

```text
{"level":50,"time":"2026-03-29T23:07:35.372Z","service":"SonioxTranslationStream",
 "msg":"Soniox WebSocket connection timeout"}

91 |                 this.ws = new ws_1.default(wsUrl);
92 |                 // Set connection timeout
93 |                 const connectionTimeout = setTimeout(() => {
94 |                     this.logger.error("Soniox WebSocket connection timeout");
95 |                     this.ws?.terminate();
96 |                     reject(new Error("Soniox WebSocket connection timeout"));
                                    ^
error: Soniox WebSocket connection timeout
      at <anonymous> (SonioxTranslationProvider.js:96:32)

Bun v1.3.11 (Linux x64 baseline)
error: script "start" exited with code 1
```

### 2. The pattern

This is identical to the ResourceTracker crash pattern:

| Issue   | Code path                             | What throws/rejects                                     | Why unhandled                                      | Exit code |
| ------- | ------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- | --------- |
| 068     | `ResourceTracker.track()`             | `throw new Error(...)` inside `new Promise` constructor | Exception in Promise constructor becomes rejection | 1         |
| **070** | `SonioxTranslationProvider.connect()` | `reject(new Error(...))` inside `setTimeout` callback   | Caller doesn't catch the rejection                 | 1         |

Both are async operations that fail after the session has moved on (disposed or timed out), and the failure propagates as an unhandled rejection that kills the process.

### 3. The timeline

```text
22:55 — 84 sessions, RSS 563MB, heap 288MB, GC 82ms — stable
22:56 — 90 sessions, RSS 573MB — peak session count
23:00 — 87 sessions, RSS 588MB — still stable
23:04 — 86 sessions, GC 97ms — slightly elevated but within range
23:07 — Soniox WebSocket timeout → reject() → unhandled rejection → exit code 1
23:08 — 34 sessions, RSS 361MB — pod restarted
```

Zero event loop gaps. GC probes within range (77-97ms). RSS was 573-592MB with 84-90 sessions — higher than post-logging-fix levels, but the heap was 288-335MB which is reasonable.

The crash was NOT caused by memory pressure, GC, or event loop blocking. It was a single unhandled promise rejection from a Soniox API timeout.

### 4. Why this was hidden before

Same reason as issue 068 — before the heap growth fix, the pod was crashing every 30-45 minutes from liveness probe failure. The pod never survived long enough with 84+ sessions for the Soniox timeout to trigger. Now that the pod is stable for hours, rare events like Soniox API timeouts can occur and expose these unhandled rejection bugs.

### 5. Other potential crash sites

Any provider that calls `reject()` or `throw` inside an async operation without the caller catching it could cause the same crash. Candidates:

- `SonioxSdkStream` — transcription provider, has similar WebSocket connection logic
- `SonioxTranslationStream` — different from the provider, but same Soniox dependency
- Any `setTimeout` + `reject()` pattern in provider code

---

## Conclusions

| Finding                                                                            | Confidence                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Crash caused by unhandled promise rejection in SonioxTranslationProvider.connect() | **Confirmed** — stack trace from Porter logs                                 |
| The reject() is in a setTimeout callback (connection timeout)                      | **Confirmed** — stack trace shows line 96                                    |
| Soniox API was temporarily unreachable or slow                                     | **Likely** — the timeout fired, meaning the WebSocket didn't connect in time |
| Same bug pattern as issue 068 (ResourceTracker)                                    | **Confirmed** — unhandled rejection → exit code 1                            |
| Pod was otherwise healthy before crash                                             | **Confirmed** — zero gaps, GC within range, heap stable                      |
| France, East Asia, US West, US East not affected                                   | **Confirmed** — 4+ hours uptime, lower session counts reduce probability     |

---

## Next Steps

1. **Fix SonioxTranslationProvider.connect()** — ensure the connection timeout rejection is caught. The caller should handle the timeout gracefully (log error, mark stream as failed, allow retry) instead of letting it crash the process.
2. **Audit all providers** for the same `setTimeout` + `reject()` pattern without catch handling.
3. **Consider adding a global unhandled rejection handler** as a safety net — log the error and continue instead of crashing. This is a process-level defense-in-depth, not a replacement for fixing individual bugs.
