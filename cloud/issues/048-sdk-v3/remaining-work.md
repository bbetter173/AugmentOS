# SDK v3 — Remaining Work Before Implementation

**Issue:** 048
**Related:** All spikes in this directory
**Status:** Pre-implementation checklist
**Date:** 2026-03-17

---

## Purpose

This document catalogs everything that still needs to be spiked, discussed, or decided before we start implementing SDK v3. It's the "what's left" checklist after the brainstorm session that produced the 6 spikes in this directory.

**Spikes completed:**

| Spike                                                                      | Covers                                                                                     | Status      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------- |
| [spike.md](./spike.md)                                                     | Core SDK v3 — MentraSession, managers, MentraApp, compat shims, translation, transcription | ✅ Complete |
| [client-sdk-spike.md](./client-sdk-spike.md)                               | Local runtime — Hermes, MentraJS framework, build pipeline, TranscriptionCapabilities      | ✅ Complete |
| [reconnection-architecture-spike.md](./reconnection-architecture-spike.md) | Reconnection, resurrection, session identity, subscription sync, multi-cloud, userId/email | ✅ Complete |
| [session-camera-spike.md](./session-camera-spike.md)                       | Camera — photos, streaming unification, video recording (future), error propagation        | ✅ Complete |
| [session-speaker-spike.md](./session-speaker-spike.md)                     | Speaker — audio output, TTS, audio streaming, priority/conflict                            | ✅ Complete |
| [session-state-spike.md](./session-state-spike.md)                         | Typed shared state — session.state\<T\>, webview hooks, transport                          | ✅ Complete |

---

## Needs Its Own Spike

These are complex enough that they should be spiked before implementation. They have open design questions that need team input.

### 1. `session.mic` — Audio Input

**What:** The input side of audio. `session.speaker` (output) is spiked. `session.mic` (input) is not.

**From the 039 API map:**

```typescript
class MicManager {
  onChunk(handler: (chunk: AudioChunk) => void): () => void
  onVoiceActivity(handler: (vad: Vad) => void): () => void
  readonly isSpeaking: boolean // from VAD
  readonly isActive: boolean // is mic streaming?
  readonly hasPermission: boolean
}
```

**What needs to be figured out:**

- How does `session.mic` interact with `session.transcription`? Transcription consumes mic audio. Are they independent subscriptions? Does subscribing to transcription implicitly activate the mic?
- Today, mic audio goes: glasses → phone → cloud (UDP) → transcription provider. For local apps, it goes: glasses → phone → on-device Whisper/Sherpa. Does the mic manager need to know about this routing?
- The current cloud has `MicrophoneManager`, `UdpAudioManager`, `AudioManager` — what's the relationship and does it need cleanup?
- Raw audio chunks vs processed audio — what format does `onChunk` deliver? PCM? What sample rate?
- Multiple apps subscribing to mic simultaneously — is this supported? (Currently yes via subscriptions, but should it be?)

### 2. `session.device` — Hardware & Device State

**What:** The 039 API map significantly redesigned this manager. Not spiked.

**From the 039 API map:**

```typescript
// Device state — keep the .state. nesting (NOT flattened)
// There's too much on session.device already (events, actions, capabilities)
// to also dump all the Observable state properties on the same level.
session.device.state.wifiConnected // Observable<boolean>
session.device.state.wifiSsid // Observable<string>
session.device.state.batteryLevel // Observable<number>
session.device.state.charging // Observable<boolean>
session.device.state.caseBatteryLevel // Observable<number>
session.device.state.connected // Observable<boolean>
session.device.state.modelName // Observable<string>
// ... more observables

// Hardware events (moved from session.events)
session.device.onButtonPress(handler)
session.device.onHeadPosition(handler)
session.device.onTouchEvent(handler)
session.device.onVpsCoordinates(handler)
session.device.subscribeToGestures(gestures)

// Actions
session.device.requestWifiSetup(ssid, pass) // moved from session-level

// Capabilities
session.device.capabilities // moved from session.capabilities
```

> **Decision: Do NOT flatten `device.state`.** The 039 API map proposed flattening `session.device.state.batteryLevel` → `session.device.batteryLevel`, but `session.device` already has hardware events, WiFi actions, capabilities, and gesture subscriptions. Adding all Observable state properties on the same level makes it too crowded. Keeping `session.device.state` as a sub-object is cleaner — two levels of nesting is fine when `state` is a coherent group of read-only values. Same pattern as `session.phone.notifications.on()`.

**What needs to be figured out:**

- The Observable pattern — the current `DeviceState` uses a custom Observable. Is this the right pattern for v3? Should we use a simpler getter + onChange callback instead?
- Hardware events (button, head position, touch) — these are currently on `session.events`. Moving to `session.device` makes sense but needs the handler registration to flow through to the subscription system correctly.
- WiFi setup — the current implementation is on `AppSession` directly. Moving to `session.device` is a rename, but does the WiFi status interact with the reconnection system? (E.g., "glasses on WiFi" triggers video upload.)
- VPS coordinates — is this still a thing? Is it used?

### 3. `session.phone` — Phone Events

**What:** Sub-scoped notifications and calendar under `session.phone`.

**From the 039 API map:**

```typescript
class PhoneManager {
  readonly battery: number | null
  onBatteryUpdate(handler): () => void

  readonly notifications: {
    on(handler): () => void
    onDismissed(handler): () => void
    readonly hasPermission: boolean
  }

  readonly calendar: {
    on(handler): () => void
    readonly hasPermission: boolean
  }
}
```

**What needs to be figured out:**

- The sub-scoping pattern (`session.phone.notifications.on()`) — how does this interact with the subscription system? Is `notifications` a sub-manager with its own handler tracking?
- Phone battery vs glasses battery — `session.phone.battery` vs `session.device.batteryLevel`. Clear enough naming?
- The cloud already routes phone notifications and calendar events (issue 047 dashboard work). Does the `PhoneManager` just subscribe to the existing streams?
- Are there other phone capabilities that should be here? (e.g., phone GPS is on `session.location`, phone notifications on `session.phone.notifications` — is this the right split?)

---

## Doesn't Need a Full Spike — Implement from 039 API Map

These are straightforward renames/restructures that can be implemented directly from the [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md) without a separate spike.

### 4. `session.permissions` — Centralized Permission Checks

```typescript
class PermissionsManager {
  has(permission: PermissionType): boolean
  getAll(): Record<PermissionType, boolean>
  onUpdate(handler): () => void
}
type PermissionType = "location" | "microphone" | "camera" | "notifications" | "calendar"
```

Straightforward. Individual managers expose `.hasPermission` as a getter that reads from this central store. No open design questions.

### 5. `session.location` — GPS

Already exists as `LocationManager`. Changes:

- `subscribeToStream()` → `onUpdate(handler)`
- `getLatestLocation()` → cached `lat` / `lng` / `accuracy` / `timestamp` read-only properties
- Add `hasPermission`
- Add `requestUpdate()` for one-shot
- Add `stop()`

No open design questions. The 039 map has the full API.

### 6. `session.led` — LED Control

No changes from v2. Keep as-is.

### 7. `session.storage` — Key-Value Storage

Rename from `session.simpleStorage`. Methods:

- `get(key)`, `set(key, value)`, `delete(key)`, `clear()`, `keys()`, `has(key)`, `getAll()`, `setMultiple(data)`, `flush()`

Rename `hasKey` → `has`, `getAllData` → `getAll`. No other changes.

### 8. `session.time` — Timezone Utils

New in v3. Simple stateless namespace:

```typescript
session.time.zone          // IANA timezone string
session.time.now()         // Date in user's timezone
session.time.toLocal(date) // convert UTC → user local
session.time.format(date, opts?) // Intl.DateTimeFormat wrapper
```

No open design questions. The user's timezone comes from `userSession.userTimezone` (already available).

### 9. `session.dashboard` — Dashboard Widget

```typescript
session.dashboard.showText(text: string | string[])
session.dashboard.clear()
```

Already implemented on the cloud side in issue 047. SDK just needs the two methods. No open questions.

### 10. `session.display` — Display / Text Formatting

Rename from `session.layouts`. Key additions from 039:

- `showText(text: string | string[])` — accepts pre-wrapped arrays
- `wrap(text, opts?)` — pure text formatting, returns `string[]`
- `maxLines`, `widthPx`, `profile` — device info read-only properties
- `createScrollView()` — ScrollView integration

The 039 API map §3b has the full spec including the two-layer wrapping model.

---

## Needs Discussion But Not a Full Spike

### 11. Route Namespacing (`/api/_mentraos/`)

The 039 map specifies moving all SDK endpoints behind `/api/_mentraos/`:

| v2 path         | v3 path                       |
| --------------- | ----------------------------- |
| `/webhook`      | `/api/_mentraos/webhook`      |
| `/tool`         | `/api/_mentraos/tool`         |
| `/health`       | `/api/_mentraos/health`       |
| `/settings`     | `/api/_mentraos/settings`     |
| `/photo-upload` | `/api/_mentraos/photo-upload` |

Legacy aliases at root paths for backward compat.

**What needs team input:** The cloud hardcodes these paths in `AppManager.ts`, `app.service.ts`, `PhotoManager.ts`, `app-settings.routes.ts`, `system-app.api.ts`. When does the cloud switch to the new paths? Same PR as SDK v3? Separate cloud PR? Can the cloud auto-detect which paths the SDK supports (via `sdkVersion`)?

### 12. `mentra` CLI Tool

We designed `mentra dev / build / publish` in the client SDK spike. Before building it:

- Is it a separate npm package (`@mentra/cli`)? Or bundled with `@mentra/sdk`?
- How does `mentra dev` discover `mentra.config.ts`?
- Does `mentra build` bundle `hermesc` or call it externally?
- Does `mentra publish` authenticate with the dev console? How?
- Is this v3.0 scope or v3.1+?

Probably v3.1+ — the CLI is for local apps which depend on the mobile runtime work. v3.0 is the cloud SDK refactor.

### 13. Open Questions from All Spikes

Each spike has open questions. These should be reviewed and decided before or during implementation:

**From spike.md (core SDK):**

- Remove `session.events` entirely in v3.0 or keep as deprecated shim?
- v3.1 shim removal timeline?
- ISO 639-1 codes in wire protocol — does cloud accept both `en` and `en-US`?
- Captions app: migrate to v3 API or keep on compat shim?

**From reconnection-architecture-spike.md:**

- Event buffering during TRANSPORT_DOWN (5s) — buffer or drop?
- Cloud restart: persist AppSessions to Redis? Or accept fresh start?
- RECONNECT retry strategy (every 1s? slight backoff?)
- userId transition plan (email → MongoDB \_id)
- Kill old sessionId format entirely?
- Subscription comparison algorithm
- v2 backport of `resurrected: true` flag

**From session-camera-spike.md:**

- Video recording TTL (24h? configurable?)
- SRT support timeline
- Photo upload path for local apps (no cloud intermediary?)
- Concurrent photo + stream operations
- Video max file size / duration limits

**From session-speaker-spike.md:**

- Audio priority model (priority levels? OS mixer? last-writer-wins?)
- Track system expansion (more than 3 tracks?)
- PCM encoding — SDK or cloud responsibility?
- `flush()` naming (too aggressive? `interrupt()`? `clear()`?)

**From session-state-spike.md:**

- Webview without active session — show stale data? "App not running" screen?
- Storage access without active session
- Grace period before "no-session" fires
- Auto-restart — SDK or OS concern?

**From client-sdk-spike.md:**

- Hermes context isolation (one instance per app or shared?)
- JSI `fetch` availability in standalone Hermes
- Hermes bytecode versioning (server vs phone mismatch)
- iOS App Store review for JS bundle execution
- Shared vs dedicated BLE connection

---

## Suggested Implementation Order

This is a suggestion, not a decision — the team should prioritize based on what matters most:

**Phase 1 — Core refactor (unblocks everything else):**

- `MentraSession` (renamed from AppSession)
- `Transport` interface + `WebSocketTransport`
- `MentraApp` (callback pattern)
- `AppServer` compat shim
- Message dispatch refactor (DataStreamRouter)
- `@mentra/sdk/session` entrypoint
- `sdkVersion` in CONNECTION_INIT

**Phase 2 — Managers (the bulk of the work):**

- `TranscriptionManager` (with `forLanguage(string | string[])`)
- `TranslationManager` (with `to(string | string[])`)
- `DisplayManager` (rename from layouts, add wrap/showText)
- `SpeakerManager` (rename from AudioManager, audio streaming)
- `MicManager` (new — audio input)
- `DeviceManager` (new — hardware events, WiFi, capabilities)
- `PhoneManager` (new — notifications, calendar)
- `PermissionsManager`, `LocationManager`, `StorageManager`, `TimeUtils`, `DashboardManager`
- `CameraManager` (unified streaming, photo cleanup)

**Phase 3 — Reconnection (fixes active bugs):**

- `RECONNECT` message type
- `TRANSPORT_DOWN` state (preserve AppSession)
- Subscription sync protocol (ACK includes subs, SDK compares)
- `sessionId` as UUID
- `cloudHostname` in webhooks
- Backward compat for v2 SDKs

**Phase 4 — Shared state + compat:**

- `session.state<T>` (typed shared state)
- WebSocket transport for state sync
- `useMentraState<T>()` React hook
- `LegacyEventShim` (v2 compat)
- Deprecated getters on MentraSession
- `AppSession` type alias

**Phase 5 — Polish:**

- `userId` → MongoDB `_id` migration
- Route namespacing (`/api/_mentraos/`)
- WebSocket path renames (`/ws/client`, `/ws/miniapp`)
- Dead code removal (app-to-app, old DashboardAPI, TpaServer/TpaSession)
- Bug fixes from the spike tables
- Migration guide, README, examples
- Publish `3.0.0`

**Phase 6 (v3.1) — Cleanup + advanced:**

- Remove all compat shims
- Remove legacy route aliases
- `mentra` CLI
- Video recording (when ASG client supports it)
- Audio priority system
- SRT streaming support
