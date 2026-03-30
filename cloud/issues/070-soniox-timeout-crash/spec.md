# Spec: Soniox WebSocket Connection Timeout Crash Fix

## Overview

**What this doc covers:** Exact specification for fixing the unhandled promise rejection in `SonioxTranslationProvider.connect()` that crashes the Bun process with exit code 1 when the Soniox WebSocket connection times out. Also adds a global unhandled rejection handler as a safety net for any future unhandled rejections.
**Why this doc exists:** US Central crashed at 23:07 UTC on March 29 after 3h45m of stable uptime. A Soniox WebSocket connection timeout called `reject()` inside a `setTimeout` callback, the rejection was unhandled, and Bun exited with code 1. This is the second exit-code-1 crash pattern found (after ResourceTracker in issue 068). Both were exposed by the heap growth fix (issue 067) extending pod lifetime.
**What you need to know first:** [070 spike](./spike.md) for the full investigation, stack trace, and crash timeline.
**Who should read this:** Anyone reviewing the hotfix PR.

## The Problem in 30 Seconds

`SonioxTranslationProvider.connect()` creates a WebSocket to Soniox with a connection timeout. If the timeout fires, `reject(new Error("Soniox WebSocket connection timeout"))` is called. If the caller doesn't `.catch()` the rejection — or if the session was disposed and nobody is awaiting the result — Bun treats it as an unhandled promise rejection and exits with code 1. All 84 connected users lose their sessions instantly.

## Spec

### A1. Catch connection errors in SonioxTranslationProvider.connect()

**File:** `cloud/packages/cloud/src/services/session/translation/providers/SonioxTranslationProvider.ts`

Find where `connect()` is called (typically from `TranslationManager` or the stream lifecycle). Ensure every call site has a `.catch()` handler or is inside a `try/catch` with `await`.

If the `connect()` method itself contains the `new Promise` with `setTimeout` + `reject`, wrap the rejection path so it logs the error and cleans up gracefully instead of propagating an unhandled rejection:

**Before:**

```typescript
const connectionTimeout = setTimeout(() => {
  this.logger.error("Soniox WebSocket connection timeout")
  this.ws?.terminate()
  reject(new Error("Soniox WebSocket connection timeout"))
}, TIMEOUT_MS)
```

**After:**

```typescript
const connectionTimeout = setTimeout(() => {
  this.logger.error("Soniox WebSocket connection timeout")
  this.ws?.terminate()
  reject(new Error("Soniox WebSocket connection timeout"))
}, TIMEOUT_MS)
```

The `reject` itself is fine — the fix is to ensure the **caller** catches it. Find where `connect()` is awaited and add `.catch()`:

```typescript
// Wherever connect() is called:
this.connect().catch((err) => {
  this.logger.error({err}, "Translation stream connection failed — will retry")
  // Don't rethrow — let the retry/reconnect logic handle it
})
```

### A2. Add global unhandled rejection handler

**File:** `cloud/packages/cloud/src/index.ts`

Add a process-level safety net near the top of the entry point, after imports:

```typescript
// Safety net for unhandled promise rejections.
// Without this, Bun exits with code 1 on any unhandled rejection,
// killing all connected users. This logs the error and continues.
// Individual bugs should still be fixed — this is defense in depth.
// See: cloud/issues/068-resource-tracker-crash, cloud/issues/070-soniox-timeout-crash
process.on("unhandledRejection", (reason, promise) => {
  logger.error(
    {err: reason, feature: "unhandled-rejection"},
    `Unhandled promise rejection (process NOT exiting): ${reason}`,
  )
})
```

This prevents ANY future unhandled rejection from crashing the process. The error is logged to BetterStack with `feature: "unhandled-rejection"` so we can find and fix the root cause, but the server stays alive.

### A3. Audit other Soniox providers for the same pattern

**Files to check:**

- `cloud/packages/cloud/src/services/session/transcription/providers/SonioxSdkStream.ts`
- `cloud/packages/cloud/src/services/session/translation/providers/SonioxTranslationStream.ts`

Look for any `reject()` inside `setTimeout` callbacks or `new Promise` constructors that could go unhandled if the session is disposed during the async gap. Ensure all call sites have `.catch()` handlers.

## What This Does NOT Include

| Out of scope                       | Why                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Fixing Soniox API reliability      | External service — we can only handle their timeouts gracefully                                                    |
| Retry logic for failed connections | Already exists in TranslationManager — this fix ensures the failure doesn't crash the process before retry can run |
| Fixing the SDK's copy of providers | SDK runs in developer processes, not our server                                                                    |

## Decision Log

| Decision                                           | Alternatives considered                    | Why we chose this                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add global `unhandledRejection` handler            | Fix only this specific call site           | We've now hit 2 different unhandled rejection crashes (068, 070). There could be more. The global handler is a safety net that keeps the server alive while we find and fix individual bugs.      |
| Log at `error` level, not crash                    | Crash on unhandled rejection (Bun default) | Crashing kills 80+ users. Logging the error and continuing is strictly better — the individual operation fails but everyone else is unaffected. We can find and fix the root cause from the logs. |
| Fix the caller (add .catch) AND add global handler | Only add global handler                    | Defense in depth. The global handler is a safety net; fixing the caller is the proper fix. Both together.                                                                                         |

## Testing

### Verify locally

1. Start the cloud server
2. Set a very short Soniox connection timeout (e.g. 1ms) to force a timeout
3. Verify the server logs the error but does NOT crash
4. Verify the `unhandled-rejection` feature tag appears in logs

### Verify in production

After deploying:

- US Central should not crash with exit code 1 from Soniox timeouts
- Search BetterStack for `feature="unhandled-rejection"` — any hits indicate bugs to fix, but the server stayed alive
- Monitor uptime — should exceed the previous 3h45m crash cycle

## Rollout

1. Deploy to cloud-debug, verify no crashes
2. Merge to main → deploys to all regions
3. Monitor US Central uptime
4. Search for `feature="unhandled-rejection"` in BetterStack to find any other unhandled rejections to fix
