# OTA System Rearchitecture Spec

> **Status:** Draft  
> **Date:** 2026-04-13  
> **Scope:** Glasses client (`asg_client`), phone native bridge (`mobile/modules/core`), phone UI (`mobile/src`)

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Current Architecture](#current-architecture)
3. [Root Causes](#root-causes)
4. [Known Bugs (Pre-existing)](#known-bugs-pre-existing)
5. [Target Architecture](#target-architecture)
6. [Detailed Design](#detailed-design)
7. [Migration & Backwards Compatibility](#migration--backwards-compatibility)
8. [File Change Map](#file-change-map)
9. [Phased Rollout](#phased-rollout)
10. [Open Questions](#open-questions)

---

## Problem Statement

The OTA update system is fragile. Users experience stuck screens, phantom countdowns, and confusing multi-phase UI. Engineers struggle to test the flow because it requires installing old firmware every time.

**Core issues:**

- The phone tries to orchestrate an update it can't reliably observe.
- `ota_progress` events (including critical `FINISHED`/`FAILED`) are sent over unreliable BLE with no ACK/retry.
- There is no mechanism for the phone to query the glasses' OTA state after a BLE reconnect.
- The glasses app process is killed during APK install, losing all in-memory OTA state.
- The user sees 14 distinct screens/states for a 3-step update (APK + MTK + BES).

---

## Current Architecture

### Update Sequence (APK + MTK + BES)

```
Phone                          Glasses                         System/BES Chip
──────                         ───────                         ──────────────
ota_start ──────────────────►  startOtaFromPhone()
                               ├─ Phase 0: Pre-download MTK+BES (suppressed from phone)
                               ├─ Phase 1: Download APK
◄────────────────────────────  ota_progress (download %)
                               ├─ Send install FINISHED *before* install
◄────────────────────────────  ota_progress (install FINISHED)
                               └─ installApk() → PROCESS KILLED

                               ── App restarts ──
                               checkAndResumeAfterApkUpdate()
                               └─ Background prefetch only (not install)

ota_start ──────────────────►  processAppsSequentially()
                               ├─ MTK download (progress suppressed)
                               ├─ MTK install (via system broadcast)
                               │   └─ MtkOtaReceiver → EventBus → OtaService
◄────────────────────────────  ota_progress (install %, via sendMtkInstallProgressToPhone)
◄────────────────────────────  ota_progress (install FINISHED)

ota_start ──────────────────►  processAppsSequentially()
                               ├─ BES download (progress suppressed)
                               ├─ BES install (UART protocol, UART busy)
                               │   └─ BES chip sends sr_adota via BLE ──────► Phone
◄────────────────────────────  sr_adota (converted to ota_progress by MentraLive)
                               └─ BES apply → chip reboots
```

### State Tracking

| What            | Phone                                                        | Glasses                                            |
| --------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| Update sequence | `updateSequenceRef` (frozen from first `otaUpdateAvailable`) | Parsed from version manifest on each `ota_start`   |
| Current step    | `currentUpdateIndex` (0, 1, 2)                               | `currentUpdateType` (mutable string, can be stale) |
| Progress        | `otaProgress` in Zustand store                               | Not persisted; in-memory only                      |
| Phase           | `progressState` (8 enum values, 9+ transitions)              | Not tracked as explicit state                      |
| Session         | No session concept                                           | No session concept                                 |

### Communication

| Message                   | Direction        | Delivery                                  | ACK/Retry                                       |
| ------------------------- | ---------------- | ----------------------------------------- | ----------------------------------------------- |
| `ota_start`               | Phone → Glasses  | BLE with `mId` + ACK tracking             | Yes (phone retries 3x at 5s)                    |
| `ota_start_ack`           | Glasses → Phone  | Raw BLE `sendData`                        | No                                              |
| `ota_progress`            | Glasses → Phone  | Raw BLE `sendData`                        | No                                              |
| `ota_update_available`    | Glasses → Phone  | `ReliableMessageManager`                  | Yes                                             |
| `mtk_update_complete`     | Glasses → Phone  | `reliableManager.sendMessage`             | Attempted, but type not in `RELIABLE_TYPES` set |
| `sr_adota` (BES progress) | BES chip → Phone | BLE characteristic (bypasses glasses app) | No                                              |

### Phone UI States

For a 3-step update, the user sees:

1. "Checking for updates..." (check screen)
2. "Update Available" (check screen)
3. "Starting Update" (progress — spinner)
4. "Downloading Update..." (progress — APK with %)
5. "Installing Update..." (progress — APK, no %)
6. "Starting Update" (progress — spinner, AGAIN)
7. "Installing Update..." (progress — MTK with %)
8. "Starting Update" (progress — spinner, AGAIN)
9. "Downloading Update..." (progress — BES, spinner)
10. "Installing Update..." (progress — BES with %)
11. "Update Installed" (restarting — Continue disabled 15s)
12. "All Updates Installed" (completed)
13. "Checking for updates..." (re-verification)
14. "Up to Date" (check screen)

---

## Root Causes

### 1. No Persistent OTA Session on Glasses

The glasses process updates in `processAppsSequentially()` on a single thread, but APK install kills the process. After restart, there is no record of the in-progress multi-step OTA. The phone must re-trigger each step with a fresh `ota_start`.

### 2. No State Query Mechanism

After any BLE disconnect (including expected reboots during MTK/BES), the phone has no way to ask the glasses "what step are you on?" It must infer from version numbers, build number changes, and incoming progress events.

### 3. Unreliable Delivery for Critical Events

`ota_progress` (including `FINISHED` and `FAILED`) is sent via raw `sendData` — no ACK, no retry. If a `FINISHED` event is dropped:

- **APK**: Phone can detect build number change (backup path works).
- **MTK**: `mtk_update_complete` event exists but the handler on the phone (`waitingForMtkComplete`) is dead code — never set to `true`.
- **BES**: No backup. Phone times out after 120s and shows "failed" even if BES succeeded.

### 4. Download Suppression Hides Failures

`sendProgressToPhone()` in `OtaHelper.java` line 2471-2473 suppresses ALL download-stage events for MTK and BES, including `FAILED`. The phone never learns about firmware download failures.

### 5. Phone Over-Orchestrates

The phone's `progress.tsx` (1,900 lines) runs 8+ concurrent timers, maintains multiple refs for reconnection gating, and uses two event systems (Zustand store + GlobalEventEmitter) to reconstruct what the glasses are doing. This complexity is the source of most UI bugs (stale closures, race conditions, stuck states).

### 6. Three Different Progress Paths

- APK: Direct `sendProgressToPhone()` calls
- MTK: System broadcast → `MtkOtaReceiver` → EventBus → `OtaService` → `sendMtkInstallProgressToPhone()`
- BES: BES chip → `sr_adota` via BLE → `MentraLive` conversion → `ota_progress` event

The phone must understand all three paths and stitch them into a coherent UI.

---

## Known Bugs (Pre-existing)

These bugs exist in the current codebase and should be fixed regardless of the rearchitecture. Items marked with `[R]` are resolved by the rearchitecture; items marked with `[I]` should be fixed independently.

### Critical (UI gets stuck)

| #   | Bug                                                                                                                                                        | File                                       | Fix                                                                                               | Status                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | BLE disconnect during APK install leaves UI stuck on "Installing..." — neither `disconnected` nor `restarting` branch fires when `currentUpdate === "apk"` | `progress.tsx` lines 811-841               | Add branch: `installing` + not mtk/bes → `disconnected`                                           | `[R]` Eliminated by simplified progress screen        |
| 2   | Stale closures in `sendOtaStartCommand` retry/stuck timers capture `progressState` from render instead of using `progressStateRef.current`                 | `progress.tsx` lines 613-647               | Use `progressStateRef.current` in timer callbacks                                                 | `[R]` Eliminated — only 1 timer in new design         |
| 3   | Connection overlay covers OTA during expected reboots (MTK/BES) — "Stop trying" button aborts the flow                                                     | `ConnectionOverlayContext.tsx` lines 65-90 | Expose `suppressOverlay` flag from progress screen when in `restarting`/`installing` with MTK/BES | `[I]` Fix independently                               |
| 4   | Stale progress regression guard blocks new OTA sessions — `setOtaProgress` clamps 0% to previous session's 100%                                            | `glasses.ts` lines 149-167                 | Reset `otaProgress` at session start                                                              | `[R]` Eliminated — `otaStatus` replaces `otaProgress` |

### High (wrong decisions / misleading UX)

| #   | Bug                                                                                                                | File                               | Fix                                            | Status                              |
| --- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------- | ----------------------------------- |
| 5   | MTK/BES download failures never reported to phone — suppression filter blocks `FAILED` status                      | `OtaHelper.java` lines 2469-2474   | Exempt `FAILED`/`FINISHED` from suppression    | `[I]` Fix independently (quick win) |
| 6   | BES segment verify failure doesn't call `cleanup()` — `isBesOtaInProgress` stays true, blocking future BES updates | `BesOtaManager.java` lines 714-716 | Add `cleanup()` call                           | `[I]` Fix independently             |
| 7   | BES `send()` failure during data transfer only logs — no FAILED event, no cleanup                                  | `BesOtaManager.java` lines 767-769 | Post `createFailed(...)` and call `cleanup()`  | `[I]` Fix independently             |
| 8   | Missing deps in check-for-updates `useEffect` — `mtkFwVersion`/`besFwVersion` not in dependency array              | `check-for-updates.tsx` line 206   | Add to deps, guarded by `hasInitiatedCheckRef` | `[I]` Fix independently             |
| 9   | No wakelock on queued install path — `startOtaFromPhone` sets `pendingPhoneInstall` without acquiring wakelock     | `OtaHelper.java` lines 454-461     | Acquire wakelock in queued path                | `[I]` Fix independently             |

### Medium (suboptimal UX / operational)

| #   | Bug                                                                                                                        | File                                                  | Fix                                                               | Status                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| 10  | MTK/BES firmware downloads have no retry logic (APK retries 3x)                                                            | `OtaHelper.java`                                      | Extract retry pattern, apply to firmware downloads (2 retries)    | `[I]` Fix as part of rearchitecture              |
| 11  | APK integrity verification disabled (`verifyApkFile` returns `true`)                                                       | `OtaHelper.java` lines 1283-1294                      | Re-enable SHA256 when manifest supports hashes                    | `[I]` Tech debt                                  |
| 12  | Revalidation race — async version fetch mid-OTA can prematurely set `completed`                                            | `progress.tsx` lines 350-425                          | Guard to only run in `starting`/`restarting`                      | `[R]` Eliminated — no revalidation in new design |
| 13  | BES wakelock too short (120s) — large transfers may outlive it                                                             | `BesOtaManager.java` lines 33-34                      | Increase to 5 min or refresh periodically                         | `[I]` Fix independently                          |
| 18  | BES protocol has no total operation timeout — if chip hangs mid-UART, glasses wait forever with wakelock held              | `BesOtaManager.java` `dealOtaRecvCmd()`               | Add 5-min total timeout; call `cleanup()` + post FAILED on expiry | `[I]` Fix independently                          |
| 19  | Cache pruning on startup only checks file existence, not integrity — truncated/corrupted files from crashes pass the check | `OtaHelper.java` lines 421-443 `pruneOneCacheEntry()` | Verify file size against cached metadata and/or SHA256 hash       | `[I]` Fix independently                          |
| 14  | Stale `connected` after BES wait in OtaUpdateChecker — doesn't re-read from store after async wait                         | `OtaUpdateChecker.tsx` lines 567-571                  | Re-read `useGlassesStore.getState().connected`                    | `[I]` Fix independently                          |
| 15  | `waitingForMtkComplete` ref is never set to `true` — `mtk_update_complete` handler is dead code                            | `progress.tsx` lines 891-908                          | Remove dead code or wire up the ref                               | `[R]` Eliminated                                 |
| 16  | Misleading log: "Started periodic OTA checks every 15 minutes" but constant is 30 minutes                                  | `OtaHelper.java` line 502                             | Fix log message                                                   | `[I]` Fix independently                          |
| 17  | `FileInputStream.available()` used as file length in BES — unreliable on Android                                           | `BesOtaManager.java` lines 198-204                    | Use `File.length()` instead                                       | `[I]` Fix independently                          |

---

## Target Architecture

### Principles

1. **Glasses are the source of truth.** The glasses own the update sequence, track the current step, persist state across restarts, and report a unified status.
2. **Phone is a display terminal.** The phone shows progress, handles user input (start, retry, cancel), and converts BES `sr_adota` into the status format. It does not orchestrate steps.
3. **One message type, one progress bar.** The user sees a single overall percentage that monotonically increases. Internal details (APK vs MTK vs BES, download vs install) are hidden.
4. **Query on reconnect.** After any BLE disconnect, the phone asks the glasses for current status. No inference, no guessing.
5. **Reliable delivery for terminal events.** `FINISHED` and `FAILED` use ACK/retry. Intermediate progress can be lossy.

### Update Sequence (New)

```
Phone                          Glasses                         System/BES Chip
──────                         ───────                         ──────────────
ota_start ──────────────────►  startOtaFromPhone()
                               ├─ Create OTA session (persisted to SharedPreferences)
                               ├─ Compute step sequence from version manifest
◄────────────────────────────  ota_status {step:1/3, phase:download, overall:0%, status:in_progress}
                               ├─ Download APK
◄────────────────────────────  ota_status {step:1/3, phase:download, overall:15%, ...}
                               ├─ Install APK (sends FINISHED, then process dies)
◄────────────────────────────  ota_status {step:1/3, phase:install, overall:33%, status:step_complete}

                               ── App restarts ──
                               OtaService reads persisted session
                               └─ Auto-continues to step 2 (isPhoneInitiatedOta = true)

                               BLE reconnects
ota_query_status ───────────►  Read persisted session
◄────────────────────────────  ota_status {step:2/3, phase:download, overall:33%, status:in_progress}
                               ├─ MTK download (from cache or fresh)
                               ├─ MTK install (system broadcast → MtkOtaReceiver → OtaService)
◄────────────────────────────  ota_status {step:2/3, phase:install, overall:55%, ...}
◄────────────────────────────  ota_status {step:2/3, phase:install, overall:67%, status:step_complete}
                               └─ Persist: MTK done, advance to step 3

                               Auto-continues to step 3
◄────────────────────────────  ota_status {step:3/3, phase:download, overall:67%, ...}
                               ├─ BES download
                               ├─ BES install (UART busy — progress via sr_adota)
                               │   └─ BES chip ──► sr_adota ──► Phone converts to ota_status
◄────────────────────────────  ota_status {step:3/3, phase:install, overall:90%, ...}
                               └─ BES apply → chip reboots → glasses reboot

                               BLE reconnects
ota_query_status ───────────►  Read persisted session (marked complete)
◄────────────────────────────  ota_status {overall:100%, status:complete}
                               └─ Clear persisted session
```

### Phone UI States (New)

For a 3-step update, the user sees:

1. "Update Available" — tap Update Now
2. "Updating... 34%" — real progress bar, "Step 1 of 3" in small text
3. Brief "Reconnecting..." overlay during expected reboots
4. "All Updates Complete" — tap Continue

**4 screens. 1 progress bar.**

---

## Detailed Design

### A. Glasses: OTA Session Persistence

**New class:** `OtaSessionManager.java`

**SharedPreferences key:** `"ota_session"`

**Persisted fields:**

```json
{
  "session_id": "uuid",
  "total_steps": 3,
  "step_sequence": ["apk", "mtk", "bes"],
  "current_step_index": 0,
  "current_phase": "download",
  "step_percent": 0,
  "status": "in_progress",
  "error_message": null,
  "version_json_url": "https://...",
  "last_activity_at": 1713045600000,
  "restarting_since": null
}
```

**Write points:**

- On `ota_start` received: create session with full step list from version manifest. If an active session already exists, resume it instead of creating a new one (see Edge Case: `ota_start` vs `ota_query_status` race below).
- Before each step begins: update `current_step_index` and `current_phase`
- On progress updates: update `step_percent` (throttled, every 5%)
- On step completion: increment `current_step_index`, reset `step_percent` to 0, update `last_activity_at`
- On session end (all complete or fatal failure): clear session
- Before APK install: set `restarting_since` to current timestamp, then persist session (install kills the process)

**Read points:**

- On `ota_query_status`: return current session state
- On app restart in `OtaService.checkAndResumeAfterApkUpdate()`: check for active session

**Session expiry:** If `last_activity_at` is more than 30 minutes old on read, consider the session stale and clear it. Expiry is based on last activity (step completion, progress update) — not session creation time. This prevents long multi-step updates from expiring mid-flow while still cleaning up zombie sessions.

**APK restart guard:** Before APK install, set `restarting_since` to the current timestamp. On app restart, if `restarting_since` is set and less than 10 seconds have elapsed, wait for the remainder before auto-continuing. This prevents the edge case where the old process hasn't fully died yet when the new process starts. After the wait, clear `restarting_since` and proceed.

**Session locking:** `ota_start` must check `hasActiveSession()` before creating a new session. If an active session exists, treat `ota_start` as a resume (re-send current `ota_status`) rather than resetting to step 1. This prevents duplicate APK installs if the phone sends `ota_start` while a session is mid-flight.

### B. Glasses: Unified `ota_status` Message

**New method:** `sendOtaStatus()` in `OtaHelper.java`

**JSON payload:**

```json
{
  "type": "ota_status",
  "session_id": "uuid",
  "total_steps": 3,
  "current_step": 2,
  "step_type": "mtk",
  "phase": "install",
  "step_percent": 60,
  "overall_percent": 53,
  "status": "in_progress",
  "error_message": null
}
```

**`status` enum values:** `"in_progress"`, `"step_complete"`, `"complete"`, `"failed"`, `"idle"`

**Overall percent computation:**

Each step gets equal weight: `stepWeight = 100 / totalSteps`.

Within a step, download phase is 40% of step weight, install phase is 60%.

```java
int computeOverallPercent(int stepIndex, int totalSteps, String phase, int stepPercent) {
    double stepWeight = 100.0 / totalSteps;
    double completedWeight = stepIndex * stepWeight;
    double phaseWeight = "download".equals(phase) ? 0.4 : 1.0;
    double phaseBase = "install".equals(phase) ? 0.4 * stepWeight : 0;
    return (int)(completedWeight + phaseBase + phaseWeight * stepWeight * stepPercent / 100.0);
}
```

When firmware download is cached (cache hit), the download phase is skipped entirely and the step jumps straight to install.

**Delivery:**

- `status` values `"in_progress"` with intermediate `step_percent`: unreliable (raw `sendData`), throttled every 2s or 5%
- `status` values `"step_complete"`, `"complete"`, `"failed"`: reliable (`ReliableMessageManager`)
- The `ota_status` type must be added to `MessageReliability.RELIABLE_TYPES`

**Backwards compatibility:** Send both `ota_progress` (old format) and `ota_status` (new format) during a transition period. The phone checks for `ota_status` first.

### C. Glasses: `ota_query_status` Handler

**New handler** in `OtaCommandHandler.java`.

**Request:**

```json
{
  "type": "ota_query_status"
}
```

**Response:** Glasses reads `OtaSessionManager` and sends an `ota_status` message. If no session is active:

```json
{
  "type": "ota_status",
  "status": "idle"
}
```

Sent via `ReliableMessageManager` (important — this is a response to a query, not a periodic update).

### D. Glasses: Auto-Continue After APK Restart

**Modified:** `OtaService.checkAndResumeAfterApkUpdate()`

Currently it starts a background prefetch. New behavior:

```java
OtaSessionManager session = new OtaSessionManager(this);
if (session.hasActiveSession()) {
    // Active OTA session found — auto-continue
    otaHelper.setPhoneInitiatedOta(true);
    otaHelper.startVersionCheckWithUrl(this, session.getVersionJsonUrl());
} else if (currentVersion > previousVersion) {
    // Version bumped but no session — just prefetch
    otaHelper.startVersionCheck(this);
}
```

Since Phase 0 pre-downloads firmware before APK install, the cache should be warm. The glasses skip the download phase and go straight to install.

### E. Glasses: Fix Download Suppression

**Modified:** `OtaHelper.sendProgressToPhone()` line 2471-2473

```java
// Before:
if ("download".equals(stage) && ("bes".equals(currentUpdateType) || "mtk".equals(currentUpdateType))) {
    return;
}

// After:
if ("download".equals(stage)
    && ("bes".equals(currentUpdateType) || "mtk".equals(currentUpdateType))
    && !"FAILED".equals(status)
    && !"FINISHED".equals(status)) {
    return;
}
```

This applies to both old `ota_progress` and the new `sendOtaStatus()` path.

### F. Glasses: Firmware Download Retry

**Modified:** `OtaHelper.java`

Extract retry logic from `downloadApk` into a shared `downloadWithRetry(url, outputFile, connectTimeoutMs, readTimeoutMs, maxRetries, retryDelayMs)` method.

Apply to `downloadMtkFirmware` and `downloadBesFirmware` with 2 retries and 10s delay.

### G. Glasses: BES Reliability Fixes

**Modified:** `BesOtaManager.java`

1. **Segment verify failure (line 714-716):** Add `cleanup()` after posting `createFailed`.
2. **`send()` failure during data transfer (line 767-769):** Post `BesOtaProgressEvent.createFailed(...)` and call `cleanup()`.
3. **Wakelock (line 33-34):** Increase `WAKELOCK_TIMEOUT_MS` from 120s to 300s (5 min).
4. **`FileInputStream.available()` (line 199):** Replace with `File.length()` for reliable file size.
5. **Total operation timeout:** Add a `BES_TOTAL_TIMEOUT_MS = 300_000` (5 min) guard. Record `startTime` when `startFirmwareUpdate()` is called. In `dealOtaRecvCmd()`, before processing each UART response, check if `System.currentTimeMillis() - startTime > BES_TOTAL_TIMEOUT_MS`. If exceeded, call `cleanup()` and post `BesOtaProgressEvent.createFailed("BES firmware update timeout — chip may be unresponsive")`. This prevents the glasses from holding a wakelock forever if the BES chip hangs mid-protocol (e.g., stops responding after `SetStartInfo`).

### H. Glasses: Wakelock on Queued Install

**Modified:** `OtaHelper.startOtaFromPhone()` lines 454-461

Acquire wakelock before returning from the queued path:

```java
if (versionCheckLock.isLocked()) {
    pendingPhoneInstall = true;
    suppressPhoneProgress = false;
    isPhoneInitiatedOta = true;
    WakeLockManager.acquireCpuWakeLock(context, OTA_WAKELOCK_TIMEOUT_MS);  // ADD THIS
    sendProgressToPhone("download", 0, 0, 0, "STARTED", null);
    return;
}
```

### I. Phone Native Bridge: Android (`MentraLive.java`)

1. **New method:** `sendOtaQueryStatus()` — sends `{"type": "ota_query_status"}` to glasses via `sendJson`.
2. **New event listener:** Handle incoming `ota_status` messages. Forward to React Native as `"ota_status"` event with camelCase field mapping.
3. **`sr_adota` handler modification:** When converting BES progress to events, also emit as `ota_status` format using cached session info (last known `totalSteps`, `currentStep`) from the most recent `ota_status` received.

### J. Phone Native Bridge: iOS (`MentraLive.swift`)

Same changes as Android:

1. `sendOtaQueryStatus()` method
2. `ota_status` event forwarding
3. `sr_adota` → `ota_status` merging

### K. Phone Bridge Types (`Core.types.ts`, `CoreModule.ts`)

```typescript
export interface OtaStatus {
  sessionId: string
  totalSteps: number
  currentStep: number      // 1-indexed for display
  stepType: 'apk' | 'mtk' | 'bes'
  phase: 'download' | 'install'
  stepPercent: number      // 0-100
  overallPercent: number   // 0-100
  status: 'in_progress' | 'step_complete' | 'complete' | 'failed' | 'idle'
  error?: string
}

// New method on CoreModule
sendOtaQueryStatus(): void
```

### L. Phone Store (`glasses.ts`)

Replace `otaProgress` / `otaInProgress` with:

```typescript
otaStatus: OtaStatus | null
setOtaStatus: (status: OtaStatus | null) => void
```

No regression guard needed — `overallPercent` is computed by the glasses and guaranteed monotonic.

`clearOtaState` clears `otaStatus` to `null`.

### M. Phone Events (`MantleManager.ts`)

Add handler for `ota_status` events:

```typescript
CoreModule.addListener("ota_status", (event) => {
  const status: OtaStatus = {
    sessionId: event.session_id,
    totalSteps: event.total_steps,
    currentStep: event.current_step,
    stepType: event.step_type,
    phase: event.phase,
    stepPercent: event.step_percent,
    overallPercent: event.overall_percent,
    status: event.status,
    error: event.error_message,
  }
  useGlassesStore.getState().setOtaStatus(status)
  GlobalEventEmitter.emit("ota_status", status)

  if (status.status === "complete" || status.status === "failed") {
    useGlassesStore.getState().setOtaUpdateAvailable(null)
  }
})
```

Keep existing `ota_progress` handler for backwards compatibility with older glasses firmware.

### N. Phone UI: `progress.tsx` Rewrite

Replace the current 1,900-line file with ~200-300 lines.

**States:** `'starting' | 'updating' | 'complete' | 'failed' | 'disconnected'`

**Logic:**

```typescript
const otaStatus = useGlassesStore((s) => s.otaStatus)
const connected = useGlassesStore((s) => s.connected)
const [state, setState] = useState<ProgressState>("starting")
const [lastPercent, setLastPercent] = useState(0)
const lastStatusTime = useRef(Date.now())
const sessionStarted = useRef(false)

// On mount or reconnect: start or resume
useEffect(() => {
  if (!connected) return

  if (otaStatus?.status === "in_progress" || otaStatus?.status === "step_complete") {
    // Session already active (e.g., app relaunched mid-update) — query, don't restart
    CoreModule.sendOtaQueryStatus()
    sessionStarted.current = true
  } else if (!sessionStarted.current) {
    // No active session — start fresh
    CoreModule.sendOtaStart()
    sessionStarted.current = true
  } else {
    // Session was started by us, reconnecting after BLE drop — query current state
    CoreModule.sendOtaQueryStatus()
  }
}, [connected])

// React to status updates
useEffect(() => {
  if (!otaStatus) return
  lastStatusTime.current = Date.now()

  switch (otaStatus.status) {
    case "complete":
      setState("complete")
      break
    case "failed":
      setState("failed")
      break
    case "in_progress":
    case "step_complete":
      setState("updating")
      setLastPercent(otaStatus.overallPercent)
      break
    case "idle":
      // Glasses say no OTA active — might have completed while disconnected
      setState("complete")
      break
  }
}, [otaStatus])

// Single timeout: no status update in 2 min → failed
useEffect(() => {
  if (state !== "starting" && state !== "updating") return
  const timer = setTimeout(() => {
    setState("failed")
  }, 120_000)
  return () => clearTimeout(timer)
}, [state, otaStatus])
```

**Render:**

- `starting`: Icon + "Starting Update" + spinner + "Do not disconnect"
- `updating`: Icon + "Updating..." + **progress bar** at `lastPercent%` + "Step N of M" (dim) + elapsed time
- `complete`: Check icon + "All Updates Complete" / "Update Complete" + Continue button
- `failed`: Warning icon + "Update Failed" + error message + Retry / Change WiFi buttons
- `disconnected`: Bluetooth icon + "Update Interrupted" + Retry button

**Eliminated:**

- `currentUpdateIndex`, `advanceToNextStep`, `sendOtaStartCommand` retry loop
- 8 concurrent timers (replaced by 1)
- `waitingForReconnectRef`, `hasSentOtaStartMidSequenceRef`
- Revalidation effect
- `expectedStep` vs `currentUpdate` mismatch logic
- MTK stall simulation
- Build number detection as APK completion backup
- `otaProgress` → `progressState` translation layer
- Cover video trigger logic (can be simplified to "show on first `updating` state")
- `ota_start_ack` / `mtk_update_complete` / `GlobalEventEmitter` listeners

### O. Phone UI: Connection Overlay Fix

**Modified:** `ConnectionOverlayContext.tsx`

Regardless of rearchitecture, fix the overlay to not cover OTA during expected reboots:

- Add `suppressOverlay` to `useConnectionOverlayConfig`
- `progress.tsx` sets `suppressOverlay: true` when `state === 'updating'` and `otaStatus?.stepType` is `'mtk'` or `'bes'` and `otaStatus?.phase === 'install'`
- The overlay checks this flag and stays hidden

### P. Phone Effects: `OtaUpdateChecker.tsx`

Simplify: after glasses connect and version info arrives, check `otaStatus?.status`. If `'in_progress'`, don't show the "update available" alert (the user is already updating). If `'idle'`, proceed with normal check logic.

Fix the stale `connected` bug: re-read from `useGlassesStore.getState().connected` after `await waitForGlassesState`.

---

## Migration & Backwards Compatibility

### Phase 1: Glasses ships first

1. Glasses sends BOTH `ota_progress` (old) and `ota_status` (new) for every progress event.
2. Glasses adds `ota_query_status` handler.
3. Glasses persists OTA session and auto-continues after APK restart.
4. Old phone app ignores `ota_status` (unknown event type) and works as before.
5. No breaking changes.

### Phase 2: Phone ships

1. Phone checks glasses firmware version (from `version_info`).
2. If glasses supports `ota_status` (firmware >= threshold): use new simplified `progress.tsx`.
3. If glasses is old: fall back to current `progress.tsx` (kept as `progress-legacy.tsx`).
4. Feature flag: `useNewOtaFlow` based on glasses firmware version.

### Phase 3: Cleanup

Once all glasses in the field are updated:

1. Remove `ota_progress` sending from glasses.
2. Remove `progress-legacy.tsx` from phone.
3. Remove old `otaProgress` from store.

---

## File Change Map

### Glasses (`asg_client`)

| File                                                        | Change                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **NEW** `io/ota/session/OtaSessionManager.java`             | OTA session persistence (SharedPreferences wrapper)                                                                 |
| `io/ota/helpers/OtaHelper.java`                             | Add `sendOtaStatus()`, update `sendProgressToPhone()` suppression, use `OtaSessionManager`, firmware download retry |
| `io/ota/services/OtaService.java`                           | Auto-continue from persisted session in `checkAndResumeAfterApkUpdate()`                                            |
| `service/core/handlers/OtaCommandHandler.java`              | Add `ota_query_status` handler                                                                                      |
| `service/communication/managers/CommunicationManager.java`  | Route terminal `ota_status` via `ReliableMessageManager`                                                            |
| `io/bes/BesOtaManager.java`                                 | Cleanup on segment verify failure, send() failure, wakelock increase, file size fix                                 |
| `service/communication/reliability/MessageReliability.java` | Add `"ota_status"` to `RELIABLE_TYPES` for terminal events                                                          |

### Phone Native Bridge

| File                                                   | Change                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `mobile/modules/core/android/.../MentraLive.java`      | `sendOtaQueryStatus()`, `ota_status` listener, `sr_adota` → `otaStatus` merge |
| `mobile/modules/core/ios/Source/sgcs/MentraLive.swift` | Same as Android                                                               |
| `mobile/modules/core/src/CoreModule.ts`                | Export `sendOtaQueryStatus()`                                                 |
| `mobile/modules/core/src/Core.types.ts`                | Add `OtaStatus` interface, `OtaQueryStatusEvent`                              |

### Phone App

| File                                               | Change                                                          |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `mobile/src/stores/glasses.ts`                     | Add `otaStatus` / `setOtaStatus`, keep `otaProgress` for legacy |
| `mobile/src/services/MantleManager.ts`             | Add `ota_status` event handler                                  |
| `mobile/src/app/ota/progress.tsx`                  | Rewrite (~200 lines)                                            |
| `mobile/src/app/ota/check-for-updates.tsx`         | Minor: fix dependency array, use `otaStatus`                    |
| `mobile/src/contexts/ConnectionOverlayContext.tsx` | Add `suppressOverlay` support                                   |
| `mobile/src/effects/OtaUpdateChecker.tsx`          | Simplify, fix stale connected bug                               |

---

## Phased Rollout

### Sprint 1: Independent Bug Fixes (no architecture changes)

Fix items marked `[I]` in the Known Bugs table. These are safe, isolated fixes:

- [ ] Fix download suppression for `FAILED`/`FINISHED` (OtaHelper.java line 2471)
- [ ] BES `cleanup()` on segment verify failure (BesOtaManager.java)
- [ ] BES `send()` failure handling (BesOtaManager.java)
- [ ] BES wakelock increase to 5 min (BesOtaManager.java)
- [ ] BES `FileInputStream.available()` → `File.length()` (BesOtaManager.java)
- [ ] BES total operation timeout — 5 min guard in `dealOtaRecvCmd()` (BesOtaManager.java) **(EC-4)**
- [ ] Wakelock on queued install path (OtaHelper.java)
- [ ] Connection overlay suppression during OTA (ConnectionOverlayContext.tsx)
- [ ] Fix check-for-updates dependency array (check-for-updates.tsx)
- [ ] Fix stale connected in OtaUpdateChecker (OtaUpdateChecker.tsx)
- [ ] Fix misleading 15-minute log (OtaHelper.java)
- [ ] Add cache file integrity validation in `pruneOneCacheEntry()` (OtaHelper.java) **(EC-1)**

### Sprint 2: Glasses-Side Rearchitecture

- [ ] Implement `OtaSessionManager.java` with `last_activity_at` expiry and `restarting_since` guard **(EC-3, EC-5)**
- [ ] Add session locking — `ota_start` resumes if active session exists **(EC-2)**
- [ ] Add `sendOtaStatus()` to `OtaHelper.java` (send alongside `ota_progress`)
- [ ] Add `ota_query_status` handler to `OtaCommandHandler.java`
- [ ] Modify `OtaService.checkAndResumeAfterApkUpdate()` for auto-continue with restart guard **(EC-5)**
- [ ] Add reliable delivery for terminal `ota_status` events
- [ ] Add firmware download retry logic
- [ ] Test: full 3-step OTA with new glasses, old phone (verify backwards compat)

### Sprint 3: Phone-Side Rearchitecture

- [ ] Add `sendOtaQueryStatus()` to native bridges (Android + iOS)
- [ ] Add `ota_status` event handling to native bridges
- [ ] Add `OtaStatus` types to `Core.types.ts`
- [ ] Add `otaStatus` to glasses store
- [ ] Add `ota_status` handler to `MantleManager.ts`
- [ ] Rewrite `progress.tsx` with `sessionStarted` ref and reconnect-safe logic **(EC-2)**
- [ ] Add firmware version gating (new vs legacy progress screen)
- [ ] Test: full 3-step OTA with new glasses + new phone
- [ ] Test: old glasses + new phone (verify legacy fallback)

### Sprint 4: Cleanup

- [ ] Remove dual-send of `ota_progress` from glasses (once field rollout confirms stability)
- [ ] Remove `progress-legacy.tsx`
- [ ] Remove old `otaProgress` from store
- [ ] Re-enable APK SHA256 verification

---

## Edge Cases (Must Handle)

These edge cases are realistic field conditions that the rearchitecture must address. Each is mapped to the design section that handles it.

### EC-1: Corrupted Download Cache

**Scenario:** Glasses download an APK, phone disconnects mid-write, file is half-written but exists on disk. On retry, `pruneOneCacheEntry()` sees the file exists and skips re-download. APK install fails with a corrupted package.

**Mitigation (Section A + Bug #19):**

- On `ota_start`, validate cached files before considering them "complete." Check file size against the expected size from the version manifest (the manifest already contains `updateUrl` — add `expectedSizeBytes` to the manifest or use HTTP `Content-Length` stored during download).
- If validation fails, delete the cached file and re-download.
- Long-term: when the manifest supports SHA256 hashes, verify integrity before install.

### EC-2: `ota_start` vs `ota_query_status` Race

**Scenario:** Phone sends `ota_start`, glasses begin APK download. BLE drops briefly. Phone reconnects and fires both `ota_query_status` (from the reconnect effect) and potentially another `ota_start` (if the user navigated back and re-entered the progress screen). The glasses receive `ota_start` while already mid-session, reset to step 1, and trigger a duplicate APK download/install.

**Mitigation (Section A — Session locking):**

- `OtaCommandHandler` checks `OtaSessionManager.hasActiveSession()` before honoring `ota_start`.
- If active session exists, `ota_start` is treated as a resume — glasses respond with current `ota_status` instead of creating a new session.
- Phone-side: `progress.tsx` tracks `sessionStarted` ref to avoid sending redundant `ota_start` on reconnect. On reconnect, always prefer `sendOtaQueryStatus()` if the session is already in flight.

### EC-3: Session Expiry Races with Step Completion

**Scenario:** Glasses are installing MTK firmware. The install takes 20 minutes (slow device, large firmware). The session's `created_at` timestamp was 25 minutes ago. A step completion or progress event triggers `OtaSessionManager` to read the session, which finds it "expired" (>30 min since creation) and clears it — killing the active OTA mid-flow.

**Mitigation (Section A — `last_activity_at`):**

- Session expiry is based on `last_activity_at`, not `created_at`. The session is refreshed on every progress update, step transition, and phase change.
- The 30-minute expiry window means: "no activity for 30 minutes." As long as progress events flow (even slowly), the session stays alive.
- On step completion, `last_activity_at` is explicitly updated before checking expiry.

### EC-4: BES Chip Hangs During UART Protocol

**Scenario:** Glasses send `SetStartInfo` to the BES chip. The chip ACKs, but hangs during the actual data transfer — no more UART responses arrive. The current code waits indefinitely in `dealOtaRecvCmd()`, holding a wakelock. The glasses never report FAILED to the phone, so the phone UI shows "Installing BES firmware..." forever.

**Mitigation (Section G — Total operation timeout):**

- Add `BES_TOTAL_TIMEOUT_MS = 300_000` (5 min). Record `startTime` when `startFirmwareUpdate()` is called.
- On each UART callback in `dealOtaRecvCmd()`, check elapsed time. If exceeded, call `cleanup()` and post `BesOtaProgressEvent.createFailed("BES timeout")`.
- `OtaHelper` receives the FAILED event and propagates it via `sendOtaStatus()` → phone shows failure with retry option.
- The per-operation wakelock (also increased to 5 min) ensures the total timeout can fire before the wakelock expires.

### EC-5: APK Install Restart Timing

**Scenario:** The glasses trigger APK install via `PackageInstaller`. The system kills the old ASG Client process and starts the new one. In rare cases, the new process's `OtaService.onCreate()` fires before the old process is fully dead. The new process reads the session from `SharedPreferences`, calls `checkAndResumeAfterApkUpdate()`, and begins MTK download — while the old process's pending I/O ops (e.g., incomplete `SharedPreferences` write) corrupt the session file.

**Mitigation (Section A — APK restart guard):**

- Before triggering APK install, write `restarting_since = System.currentTimeMillis()` to the session.
- On app restart, if `restarting_since` is set and fewer than 10 seconds have elapsed, sleep for the remainder before proceeding. This gives the old process time to die and release file locks.
- After the wait, clear `restarting_since` and continue with `checkAndResumeAfterApkUpdate()`.

---

## Edge Cases (Monitor — Lower Priority)

These are plausible but lower-frequency scenarios. They should be tracked but don't need to block the initial rearchitecture rollout.

### EC-L1: Battery Drops Below Critical During Update

**Scenario:** User starts OTA at 8% battery. APK installs fine. MTK download starts. Battery hits 3%. Glasses shut down mid-download.

**Recommendation:** Add a pre-flight battery check before `ota_start` (e.g., require >10%). Decide whether to also check before each step. A mid-step shutdown is already survivable (session persists, user retries after charging) — the question is whether to prevent it proactively.

### EC-L2: Insufficient Storage Mid-Update

**Scenario:** Glasses have 50MB free when APK downloads. APK install frees some space by replacing the old APK. MTK firmware file is 200MB and download fails partway through.

**Recommendation:** Add a pre-flight storage check. Sum the sizes of all artifacts to be downloaded (from the version manifest) and compare against available space. This requires adding file sizes to the version manifest.

### EC-L3: WiFi Network Changes Mid-Download

**Scenario:** Glasses are connected to WiFi A. User walks out of range. Glasses auto-connect to saved WiFi B (different subnet, potentially no internet). Download stalls or fails silently because the TCP connection to CDN drops without a clean error.

**Recommendation:** The HTTP connection timeout (15s connect, 30s read) already handles this — a stalled TCP connection will eventually fail. The retry logic (Section F) will re-attempt the download. No additional mitigation needed beyond existing timeout + retry, but worth monitoring in field telemetry.

---

## Open Questions

1. **Session expiry duration:** 30 minutes is proposed (based on `last_activity_at`). Should it be longer for very slow connections (e.g., rural WiFi)?

2. **Step weight distribution:** Equal weight per step (33/33/33 for 3 steps) is simple but may not match perceived time. APK downloads are fast; MTK install is slow. Should weights be configurable per step type?

3. **BES `sr_adota` session context:** The phone needs to merge BES chip progress into the `ota_status` format. Should the glasses pre-send the session info before BES install starts (while UART is still available), or should the phone cache the last `ota_status` and overlay BES progress?

4. **Retry semantics on phone:** If the user taps "Retry" after failure, should the phone send `ota_start` (which creates a new session on glasses) or `ota_resume` (which continues the existing session)? New session is simpler; resume avoids re-downloading cached artifacts. Note: with session locking (EC-2), sending `ota_start` to glasses with an active session already acts as a resume.

5. **OTA simulation mode for testing:** Should the glasses support a `DEBUG_SIMULATE_OTA` flag that fakes the entire 3-step flow with delays and progress events, so the phone UI can be tested without real firmware?

6. **Pre-flight battery/storage checks (EC-L1, EC-L2):** Should these be hard gates (refuse to start OTA) or soft warnings (show advisory but allow user override)? What are the minimum thresholds?
