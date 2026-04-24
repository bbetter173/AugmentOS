# Mentra Bluetooth SDK AI Review Follow-ups

Last checked: 2026-04-24

This document tracks AI review findings from the phase PRs that were merged into
`philippe/os-1178-mentra-bluetooth-sdk-feature` and rolled up in PR #2607.

## PRs Checked

| PR                                                              | Branch                                                        | AI review result                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| [#2595](https://github.com/Mentra-Community/MentraOS/pull/2595) | `philippe/os-1178-mentra-bluetooth-sdk`                       | CodeRabbit posted actionable inline findings.                         |
| [#2596](https://github.com/Mentra-Community/MentraOS/pull/2596) | `philippe/os-1178-mentra-bluetooth-sdk-phase-1`               | No actionable AI review threads found.                                |
| [#2597](https://github.com/Mentra-Community/MentraOS/pull/2597) | `philippe/os-1178-mentra-bluetooth-sdk-phase-2`               | Codex posted one P1 inline finding.                                   |
| [#2598](https://github.com/Mentra-Community/MentraOS/pull/2598) | `philippe/os-1178-mentra-bluetooth-sdk-phase-3`               | No actionable AI review threads found.                                |
| [#2599](https://github.com/Mentra-Community/MentraOS/pull/2599) | `philippe/os-1178-mentra-bluetooth-sdk-phase-optional-rename` | No actionable AI review threads found.                                |
| [#2600](https://github.com/Mentra-Community/MentraOS/pull/2600) | `philippe/os-1178-mentra-bluetooth-sdk-phase-4`               | Codex posted one P1 inline finding.                                   |
| [#2601](https://github.com/Mentra-Community/MentraOS/pull/2601) | `philippe/os-1178-mentra-bluetooth-sdk-phase-5`               | No actionable AI review threads found.                                |
| [#2605](https://github.com/Mentra-Community/MentraOS/pull/2605) | `philippe/os-1178-mentra-bluetooth-sdk-phase-6`               | No actionable AI review threads found.                                |
| [#2607](https://github.com/Mentra-Community/MentraOS/pull/2607) | `philippe/os-1178-mentra-bluetooth-sdk-feature`               | Current roll-up PR; no actionable AI review threads at time of check. |

## Highest Priority

### 1. Guard notification-dismissed emission in Crust

- Source: Codex on [#2597](https://github.com/Mentra-Community/MentraOS/pull/2597#discussion_r3133810997)
- Priority: P1
- File: `mobile/modules/crust/android/src/main/java/com/mentra/crust/services/NotificationListener.kt`
- Current status: fixed in the working tree by adding guarded Crust event emission.

`onNotificationRemoved` calls `CrustModule.emitPhoneNotificationDismissed(...)`
directly. If the React runtime is torn down or reloaded while Android's
notification listener service is still alive, the static emitter callback can
throw and crash the service. The previous bridge path had defensive error
handling, so this is a reliability regression.

Recommended fix:

- Wrap Crust event emission in `try/catch`.
- Log the failure without aborting the notification listener service.
- Consider guarding `listeners.forEach { listener.onNotificationRemoved(...) }`
  separately so one listener cannot prevent others from running.

Validation:

- Run Android unit/build validation that covers Crust compilation.
- If practical, add a small test or manual logcat verification around
  notification dismissal while the JS runtime is unavailable.

### 2. Resolve `lc3Lib` Maven publishing problem

- Source: Codex on [#2600](https://github.com/Mentra-Community/MentraOS/pull/2600#discussion_r3134757101)
- Priority: P1
- File: `mobile/modules/bluetooth-sdk/android/build.gradle`
- Current status: fixed in the working tree by making `lc3Lib` publishable as a
  companion Maven artifact.

The Bluetooth SDK publishes `components.release`, but Android still depends on
`implementation project(':lc3Lib')`. That works for monorepo or npm/path-based
integration where the local Gradle project is injected, but a Maven consumer of
`com.mentra:bluetooth-sdk` will not have `:lc3Lib`, making the published Android
artifact unusable outside the monorepo.

Decision made:

- Publish `lc3Lib` as its own stable Maven artifact with the same version as
  `com.mentra:bluetooth-sdk`.
- Keep the local `project(':lc3Lib')` dependency for monorepo/npm-path builds so
  MentraOS and Expo prebuild behavior do not change.

Validation:

- Test a fresh external Gradle project consuming the published/local Maven
  artifact without the monorepo `settings.gradle` plugin injection.
- Confirm LC3 encode/decode paths still work for Mentra Live, G1, and Nex flows.

## Test Correctness Follow-ups

### 3. Fix `Platform.OS` redefinition in pairing tests

- Source: CodeRabbit on [#2595 scan](https://github.com/Mentra-Community/MentraOS/pull/2595#discussion_r3132995774) and [#2595 success](https://github.com/Mentra-Community/MentraOS/pull/2595#discussion_r3132995778)
- Priority: high
- Files:
  - `mobile/src/__tests__/app/pairing/scan.test.tsx`
  - `mobile/src/__tests__/app/pairing/success.test.tsx`
- Current status: still relevant.

The tests redefine `Platform.OS` with `Object.defineProperty(...)` without
`configurable: true` or `writable: true`. The first redefine can make the
property non-configurable, and later attempts to switch to Android or rerun
`beforeEach` can throw `TypeError: Cannot redefine property: OS`.

Recommended fix:

- Store the original `Platform.OS`.
- Define the test value with `configurable: true` and `writable: true`.
- Restore the original value in `afterEach`.

Validation:

- `cd mobile && bun run test -- src/__tests__/app/pairing/scan.test.tsx src/__tests__/app/pairing/success.test.tsx --runInBand`

### 4. Make audio playback listener assertions less fragile

- Source: CodeRabbit on [#2595](https://github.com/Mentra-Community/MentraOS/pull/2595#discussion_r3132995791)
- Priority: medium
- File: `mobile/src/services/AudioPlaybackService.test.ts`
- Current status: still relevant.

The tests call `mockPlayer.addListener.mock.calls[0][1]`, assuming listener
registration always happens in the same test and in the first call. That is
fragile around the singleton `audioPlaybackService` and future refactors to
`release()`.

Recommended fix:

- Read the latest listener via `mockPlayer.addListener.mock.calls.at(-1)?.[1]`.
- Assert the listener is defined before invoking it.
- Keep `audioPlaybackService.release()` in `afterEach`.

Validation:

- `cd mobile && bun run test -- src/services/AudioPlaybackService.test.ts --runInBand`

### 5. Isolate `MantleManager.test.ts` state between tests

- Source: CodeRabbit on [#2595](https://github.com/Mentra-Community/MentraOS/pull/2595#discussion_r3132995797)
- Priority: medium
- File: `mobile/src/services/MantleManager.test.ts`
- Current status: still relevant.

`mantle.init()` and store setup currently run in `beforeAll`, while tests mutate
Zustand stores and mocks. This creates order coupling and makes future test
additions easier to break.

Recommended fix:

- Prefer `beforeEach` store resets plus `jest.clearAllMocks()`.
- If moving `mantle.init()` into `beforeEach` creates duplicate listener
  behavior, keep one-time init but add a robust per-test cleanup/reset layer.
- Reset OTA state and connected state after the OTA test, even if it remains
  last today.

Validation:

- `cd mobile && bun run test -- src/services/MantleManager.test.ts --runInBand`

### 6. Reset Bluetooth SDK mock between pairing loading mounts

- Source: CodeRabbit review summary on [#2595](https://github.com/Mentra-Community/MentraOS/pull/2595#pullrequestreview-4164945267)
- Priority: low/medium
- File: `mobile/src/__tests__/app/pairing/loading.test.tsx`
- Current status: still relevant as a defensive cleanup.

The test unmounts and remounts the loading screen. Production cleanup should
remove event listeners, but a defensive `resetBluetoothSdkMock()` between mounts
would make the test independent of stale listener behavior.

Recommended fix:

- After `first.unmount()`, call `resetBluetoothSdkMock()` before rendering the
  second screen.

Validation:

- `cd mobile && bun run test -- src/__tests__/app/pairing/loading.test.tsx --runInBand`

### 7. Scope fake timer cleanup in `RestComms.test.ts`

- Source: CodeRabbit review summary on [#2595](https://github.com/Mentra-Community/MentraOS/pull/2595#pullrequestreview-4164945267)
- Priority: low
- File: `mobile/src/services/RestComms.test.ts`
- Current status: still relevant, but not a runtime bug.

The global `afterEach` clears timers and restores real timers even though only
one test installs fake timers. It is harmless today but slightly confusing.

Recommended fix:

- Either scope `useFakeTimers()` cleanup to the test that uses it, or guard the
  cleanup with a local flag.

Validation:

- `cd mobile && bun run test -- src/services/RestComms.test.ts --runInBand`

## Import and Style Cleanup

### 8. Use absolute imports in new tests

- Source: CodeRabbit review summary on [#2595](https://github.com/Mentra-Community/MentraOS/pull/2595#pullrequestreview-4164945267)
- Priority: low
- Files:
  - `mobile/src/services/AudioPlaybackService.test.ts`
  - `mobile/src/services/MantleManager.test.ts`
- Current status: still relevant.

The tests still use a few relative imports/requires where the mobile codebase
prefers the `@/` alias.

Recommended fix:

- Change `./AudioPlaybackService` to `@/services/AudioPlaybackService`.
- Change `./MantleManager` to `@/services/MantleManager`.
- Change mock factory requires like `../test-utils/mockBluetoothSdk` and
  `../test-utils/mockCrustModule` to `@/test-utils/...`.

Validation:

- Run the affected tests and `cd mobile && bun lint`.

## Documentation Follow-ups

### 9. Clarify why `auth_email` and `core_token` remain in Bluetooth SDK

- Source: CodeRabbit on [#2595](https://github.com/Mentra-Community/MentraOS/pull/2595#discussion_r3132995750)
- Priority: medium
- File: `docs/mentra-bluetooth-sdk-plan.md`
- Current status: partially addressed, but can be clearer for non-MentraOS
  customers.

The plan says MentraLive reads these values and sends them down to hardware, but
it should explicitly state whether they are hardware protocol requirements or
MentraOS cloud credentials currently tunneled through the device path.

Recommended doc update:

- Explain the current data flow through `DeviceStore` / `GlassesStore` and
  MentraLive init.
- Add guidance for external/native customers on how to populate, configure, or
  stub these fields before they are made optional.
- Add a future-cleanup note to make authentication explicit and optional.

### 10. Add a dedicated testing strategy section

- Source: CodeRabbit on [#2595](https://github.com/Mentra-Community/MentraOS/pull/2595#discussion_r3132995760)
- Priority: medium
- File: `docs/mentra-bluetooth-sdk-plan.md`
- Current status: still relevant.

The plan has validation bullets, but not a cohesive testing strategy for the SDK
split.

Recommended doc update:

- Unit tests for native stores/managers and TypeScript adapter behavior.
- Integration tests for BLE connection flows and native event emitters.
- Regression tests for pairing, audio streaming, display control, gallery sync,
  and transcription.
- CI rules for what gates refactors vs publishing.
- Device/OS compatibility matrix expectations.

### 11. Verify Phase 6 migration guidance is complete

- Source: CodeRabbit on [#2595](https://github.com/Mentra-Community/MentraOS/pull/2595#discussion_r3132995766)
- Priority: low/medium
- File: `docs/mentra-bluetooth-sdk-plan.md`
- Current status: mostly addressed by the new Phase 6 section and native Android
  / iOS API planning docs.

Recommended follow-up:

- Review the Phase 6 section once more after native SDK extraction starts.
- Ensure the plan names the actual MentraOS TypeScript adapter files that will
  own store-to-typed-API migration.
- Ensure cloud formatting stays clearly owned by MentraOS TypeScript, not the
  native SDK.

### 12. Markdown polish in the plan

- Source: CodeRabbit review summary on [#2595](https://github.com/Mentra-Community/MentraOS/pull/2595#pullrequestreview-4164945267)
- Priority: low
- File: `docs/mentra-bluetooth-sdk-plan.md`
- Current status: still relevant.

Several fenced code blocks in the plan lack language specifiers, and the success
criteria could include more measurable quality metrics.

Recommended doc update:

- Add `plaintext`, `yaml`, `kotlin`, `swift`, or other accurate language tags to
  fenced blocks.
- Add quality metrics around test coverage, connection latency, battery impact,
  device/OS compatibility, and documentation completeness.

## Suggested Work Order

1. Fix the two P1 runtime/release issues: notification dismissal guard and
   `lc3Lib` publishing decision.
2. Fix test correctness issues: `Platform.OS`, audio listener, MantleManager
   isolation, loading mock reset, RestComms timer cleanup.
3. Clean up imports and run focused mobile tests plus lint.
4. Update docs with auth/token guidance, testing strategy, and markdown polish.
5. Re-run PR #2607 CI and check for any new AI review comments.
