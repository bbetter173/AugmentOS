# Spike: ResourceTracker Disposed Crash — Unhandled Exception Kills Pod

## Overview

**What this doc covers:** Investigation into cascading exit-code-1 crashes on US Central caused by `ResourceTracker.track()` throwing an unhandled exception when called on an already-disposed tracker. The throw propagates through `SonioxTranslationProvider.connect()` inside a `new Promise` constructor, becomes an unhandled promise rejection, and crashes the entire Bun process.
**Why this doc exists:** After fixing the heap growth (issue 067) and removing gc-after-disconnect, US Central began crashing with exit code 1 instead of exit code 137. The pod ran for only 5 minutes before dying, then cascaded — 3 restarts in 10 minutes. This is a different failure mode from the liveness probe kills we previously investigated.
**Who should read this:** Cloud engineers, anyone working on session lifecycle or translation/transcription streams.

**Depends on:**

- [067-heap-growth-investigation](../067-heap-growth-investigation/) — heap growth fix that extended pod lifetime, exposing this latent bug
- [057-cloud-observability](../057-cloud-observability/) — ResourceTracker introduced as part of memory leak fixes

---

## Background

`ResourceTracker` is a utility class that manages cleanup functions for timers, event listeners, and disposable objects. Each `UserSession` has a `ResourceTracker` instance. When the session is disposed, `ResourceTracker.dispose()` runs all cleanup functions and sets `isDisposed = true`.

The problem: after `dispose()`, if any async operation (like a translation stream connecting) tries to call `track()`, the method throws:

```
throw new Error("Cannot track resources on a disposed ResourceTracker");
```

This throw is unhandled because it occurs inside `SonioxTranslationProvider.connect()` within a `new Promise` constructor. An exception inside a Promise constructor becomes an unhandled promise rejection, which in Bun crashes the process with exit code 1.

---

## Findings

### 1. The crash stack trace

```
error: Cannot track resources on a disposed ResourceTracker
  at track (/app/packages/cloud/dist/utils/resource-tracker.js:35:23)
  at <anonymous> (/app/packages/cloud/dist/services/session/translation/providers/SonioxTranslationProvider.js:147:32)
  at new Promise (1:11)
  at connect (/app/packages/cloud/dist/services/session/translation/providers/SonioxTranslationProvider.js:86:16)

Bun v1.3.11 (Linux x64 baseline)
error: script "start" exited with code 1
```

### 2. The race condition

During a thundering herd reconnection (50+ users reconnecting simultaneously after a crash):

1. User connects → `UserSession` created → `TranslationManager` starts
2. `TranslationManager` calls `SonioxTranslationProvider.connect()` (async)
3. User disconnects before `connect()` completes (network flicker, client timeout)
4. Grace period expires → `UserSession.dispose()` → `ResourceTracker.dispose()` sets `isDisposed = true`
5. `SonioxTranslationProvider.connect()` callback fires → calls `this.resources.track()` → **throws**
6. Unhandled rejection → **process exit code 1**
7. All 50+ sessions destroyed → thundering herd on restart → same race → **cascade**

### 3. Why this was hidden before

Before the heap growth fix (issue 067), the pod was crashing every 30-45 minutes from liveness probe failure (exit code 137). The pod never lived long enough for this race condition to trigger frequently. After the heap fix stabilized the pod, it survived long enough for the thundering herd pattern to expose this latent bug.

### 4. The cascading pattern

Porter logs showed 3 crashes in 10 minutes:

| Time  | Sessions | Event                             |
| ----- | -------- | --------------------------------- |
| 15:55 | 72       | Stable                            |
| 15:56 | 74       | Crash 1 → exit code 1             |
| 15:57 | 29       | Restarting, sessions reconnecting |
| 16:11 | 54       | Stable for 14 minutes             |
| 16:12 | 12       | Crash 2 → exit code 1             |
| 16:16 | 29       | Recovering                        |
| 16:17 | 3        | Crash 3 → exit code 1             |

Each crash triggers a thundering herd that increases the probability of the race condition on the next instance.

### 5. This affects translation streams specifically

The stack trace points to `SonioxTranslationProvider.connect()`. The translation provider establishes a WebSocket connection to the Soniox API, which is async. If the user session is disposed during that async gap, the callback tries to register the connection cleanup with the disposed ResourceTracker.

The same pattern could theoretically occur in any provider that calls `resources.track()` after an async operation, but the translation provider is the one triggering it in production.

---

## Conclusions

| Finding                                                          | Confidence                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ResourceTracker.track()` throwing crashes the process           | **Confirmed** — stack trace from Porter logs                            |
| The throw is unhandled because it's inside a Promise constructor | **Confirmed** — stack trace shows `new Promise`                         |
| The race condition is: dispose() runs during async connect()     | **Confirmed** — connect is async, dispose is sync                       |
| Thundering herd increases probability of the race                | **Confirmed** — 3 cascading crashes in 10 minutes                       |
| This was hidden by the previous heap growth crashes              | **Confirmed** — only appeared after 067 fix                             |
| France, East Asia, US West, US East are not affected             | **Confirmed** — lower session counts reduce thundering herd probability |

---

## Next Steps

1. **Fix `ResourceTracker.track()`** — return a no-op instead of throwing when disposed. The throw serves no purpose other than crashing the process. A disposed tracker should silently ignore new registrations — the cleanup will never run anyway since `dispose()` already completed.
2. **Audit other callers** — check if `trackDisposable()`, `trackTimer()`, `setTimeout()`, `setInterval()` have the same issue (they all call `track()` internally, so they're all fixed by fixing `track()`).
3. **Consider adding a disposed guard in SonioxTranslationProvider.connect()** — check `this.disposed` before calling `resources.track()` as defense in depth.
