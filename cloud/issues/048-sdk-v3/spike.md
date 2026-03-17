# Spike: SDK v3 Implementation Plan

**Issue:** 048
**Branch:** `cloud/issues-048`
**Status:** Spike
**Spec:** [`039-sdk-v3-api-surface/v2-v3-api-map.md`](../039-sdk-v3-api-surface/v2-v3-api-map.md)
**Date:** 2026-03-17

---

## Overview

**What this doc covers:** Implementation plan for `@mentra/sdk` v3. The API surface design is already specced in [039](../039-sdk-v3-api-surface/v2-v3-api-map.md) — this doc is about how to build it, how to handle backward compat, and what order to do things in.

**What this doc does NOT cover:** The API design itself. If you need to understand _what_ the v3 API looks like, read the 039 API map first.

**Key constraints:**

- Cloud wire protocol (WebSocket messages, subscription strings, webhook format) does NOT change.
- v2 apps already deployed must keep working with the current cloud.
- v3 is a breaking change for SDK consumers, but we provide a v2 compat layer so `npm update` doesn't immediately break existing apps.
- The compat layer is a separate object (`AppServer`) that wraps the new `MentraApp`. It ships in v3.0 with deprecation warnings and is removed in v3.1.

---

## The Express → Hono Problem

The biggest migration friction isn't the API rename — it's the runtime change. v2 apps subclass `AppServer` which used to be Express-based. v3 (`MentraApp`) is Hono + Bun. A developer who did `class MyApp extends AppServer` and used Express middleware or `getExpressApp()` has a real porting challenge.

However, looking at actual usage:

1. **Captions app** (`packages/apps/captions`) — subclasses `AppServer`, uses `publicDir` config (static files), never touches Express directly.
2. **Streaming example** — subclasses `AppServer`, overrides `onSession`/`onStop`, never touches Express.
3. **Public example app** — same pattern: subclass, override hooks, done.

In practice, almost nobody calls `getExpressApp()` or uses Express middleware. The subclass pattern is just a way to register `onSession`/`onStop`/`onToolCall` callbacks. The v3 `MentraApp` callback pattern does the same thing without inheritance.

**The compat shim for `AppServer` doesn't need Express at all.** It just needs to:

1. Accept the same constructor config
2. Let subclasses override `onSession`, `onStop`, `onToolCall`
3. Internally create a `MentraApp` and wire the overrides as callbacks
4. Delegate `start()` / `stop()`

If a developer was using `getExpressApp()` to add custom Express routes, the shim logs a deprecation error telling them to add Hono routes on the `MentraApp` instance instead. That's the one breaking edge case.

---

## Architecture

### Layer diagram

```
┌─────────────────────────────────────────────────────┐
│                  Developer's code                    │
│                                                      │
│  v3 path:  const app = new MentraApp({...})          │
│            app.onSession((session) => {...})          │
│                                                      │
│  v2 compat: class MyApp extends AppServer {...}      │
│             (internally creates MentraApp)            │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│              MentraApp  (Hono server)                │
│                                                      │
│  Routes: /api/_mentraos/webhook                      │
│          /api/_mentraos/tool                          │
│          /api/_mentraos/health                        │
│          /api/_mentraos/settings                      │
│          /api/_mentraos/photo-upload                  │
│          /api/_mentraos/auth                          │
│  + legacy aliases at root paths for cloud compat     │
│                                                      │
│  Session factory → creates AppSession per user       │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│          AppSession  (thin orchestrator, ~500 lines) │
│                                                      │
│  WebSocket lifecycle: connect / disconnect / reconnect│
│  Message dispatcher: Map<type, handler>              │
│                                                      │
│  Managers (public readonly):                         │
│  ├── session.transcription  — TranscriptionManager   │
│  ├── session.translation    — TranslationManager     │
│  ├── session.display        — DisplayManager         │
│  ├── session.camera         — CameraModule           │
│  ├── session.audio          — AudioManager (output)  │
│  ├── session.mic            — MicManager (input)     │
│  ├── session.device         — DeviceManager          │
│  ├── session.phone          — PhoneManager           │
│  ├── session.location       — LocationManager        │
│  ├── session.led            — LedModule              │
│  ├── session.storage        — StorageManager         │
│  ├── session.permissions    — PermissionsManager     │
│  ├── session.dashboard      — DashboardManager       │
│  └── session.time           — TimeUtils              │
│                                                      │
│  System events: session.on('connected', ...)         │
│                 session.on('disconnected', ...)       │
│                 session.on('error', ...)              │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│          Wire protocol (UNCHANGED)                   │
│                                                      │
│  CONNECTION_INIT, SUBSCRIPTION_UPDATE,               │
│  DataStream, AudioChunk, DisplayRequest, etc.        │
│  Same message types, same subscription strings.      │
└─────────────────────────────────────────────────────┘
```

### v2 Compat Shim Layer

The shim is a **separate file** (`compat/AppServer.ts`) that wraps `MentraApp`:

```typescript
// compat/AppServer.ts — the entire v2 compat layer

import {MentraApp} from "../MentraApp"
import type {AppSession} from "../session/AppSession"

/** @deprecated Use MentraApp instead. Will be removed in v3.1. */
export class AppServer {
  private _app: MentraApp

  constructor(config: AppServerConfig) {
    console.warn(
      "⚠️ AppServer is deprecated. Use MentraApp instead.\n" +
        "   See migration guide: https://docs.mentra.glass/sdk/migration",
    )

    this._app = new MentraApp({
      packageName: config.packageName,
      apiKey: config.apiKey,
      port: config.port ?? 7010,
    })

    // Wire the override pattern → callback pattern
    this._app.onSession((session) => {
      const sessionId = session.getSessionId()
      const userId = session.userId
      return this.onSession(session, sessionId, userId)
    })

    this._app.onStop((session, reason) => {
      const sessionId = session.getSessionId()
      const userId = session.userId
      return this.onStop(sessionId, userId, reason)
    })

    this._app.onToolCall((toolCall) => {
      return this.onToolCall(toolCall)
    })

    // Legacy static file support
    if (config.publicDir && config.publicDir !== false) {
      const {serveStatic} = require("hono/bun")
      this._app.use("/public/*", serveStatic({root: config.publicDir}))
    }
  }

  // Override hooks — subclasses implement these (same as v2)
  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {}
  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {}
  protected async onToolCall(toolCall: any): Promise<any> {}

  async start() {
    return this._app.start()
  }
  async stop() {
    return this._app.stop()
  }

  /** @deprecated MentraApp is a Hono app — add routes directly on it. */
  getExpressApp() {
    console.error(
      "❌ getExpressApp() is removed in v3. MentraApp uses Hono, not Express.\n" +
        "   Add routes directly: app.get('/my-route', handler)",
    )
    return this._app
  }

  /** @deprecated Use the MentraApp instance directly. */
  getHonoApp() {
    return this._app
  }
}
```

**What this gives us:**

The captions app — the most complex real-world SDK user — would work with **zero code changes** after updating to v3.0:

```typescript
// This STILL WORKS in v3.0 (with deprecation warnings)
export class LiveCaptionsApp extends AppServer {
  constructor(config) {
    super({packageName: config.packageName, apiKey: config.apiKey, port: config.port})
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string) {
    // session.events.onTranscription() → still works via LegacyEventShim
    // session.layouts.showTextWall() → still works via alias
  }
}
```

Then in v3.1, they migrate to:

```typescript
// v3 way — clean
const app = new MentraApp({packageName: "...", apiKey: "...", port: 3000})

app.onSession((session) => {
  session.transcription.on((data) => {
    session.display.showText(data.text)
  })
})

await app.start()
```

### Session-Level Compat Shim

The `AppSession` in v3 exposes new managers. But old code uses `session.events.*`, `session.layouts.*`, etc. The shim strategy:

| Old accessor                                   | Shim approach                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `session.events.onTranscription(handler)`      | `LegacyEventShim` — delegates to `session.transcription.on(handler)`       |
| `session.events.onButtonPress(handler)`        | `LegacyEventShim` — delegates to `session.device.onButtonPress(handler)`   |
| `session.events.onPhoneNotifications(handler)` | `LegacyEventShim` — delegates to `session.phone.notifications.on(handler)` |
| `session.layouts.showTextWall(text)`           | `session.layouts` is a getter that returns `session.display` (alias)       |
| `session.simpleStorage`                        | Getter that returns `session.storage`                                      |
| `session.capabilities`                         | Getter that returns `session.device.capabilities`                          |
| `session.onTranscription(handler)`             | Direct deprecated methods on session — delegate to managers                |
| `session.subscribe(stream)`                    | `LegacyEventShim` — logs warning, internally handled by managers           |
| `session.getSettings()` / `.getSetting(key)`   | Delegate to `session.storage.getAll()` / `.get(key)`                       |
| `session.getWifiStatus()`                      | Delegate to `session.device.wifiConnected.value`                           |

The `LegacyEventShim` is a single object exposed as `session.events` that maps every old `session.events.*` method to the corresponding v3 manager call. It's one file, ~200 lines of pure delegation, logs a deprecation warning on first access. Removed entirely in v3.1.

**Key principle:** The v3 `AppSession` implementation has NO awareness of the shim. The shim wraps the session from the outside. The new managers are the real implementation. The shim is applied in the `AppServer` compat constructor, not in `MentraApp`.

Actually — correction. The shim should be on `AppSession` itself so that even `MentraApp` users who happen to use old method names get warnings. The session exposes both the new managers AND the deprecated accessors, but the deprecated ones are just getters that delegate. This means:

```typescript
class AppSession {
  // ─── v3 managers (the real API) ───────────────
  readonly transcription: TranscriptionManager
  readonly translation: TranslationManager
  readonly display: DisplayManager
  readonly camera: CameraModule
  readonly audio: AudioManager
  readonly mic: MicManager
  readonly device: DeviceManager
  readonly phone: PhoneManager
  readonly location: LocationManager
  readonly led: LedModule
  readonly storage: StorageManager
  readonly permissions: PermissionsManager
  readonly dashboard: DashboardManager
  readonly time: TimeUtils

  // ─── v2 compat (deprecated getters, removed in v3.1) ───
  /** @deprecated Use session.display */
  get layouts() {
    return this.display
  }

  /** @deprecated Use session.storage */
  get simpleStorage() {
    return this.storage
  }

  /** @deprecated Use session.storage */
  get settings() {
    return this._legacySettings
  }

  /** @deprecated Use managers directly */
  get events() {
    return this._legacyEvents
  }

  // etc.
}
```

This way:

- v3 users see clean autocomplete: `session.transcription`, `session.display`, etc.
- v2 users' code still compiles: `session.events.onTranscription()`, `session.layouts.showTextWall()` work
- Deprecation warnings fire on first use of old accessors
- In v3.1, delete the getters and the two shim files

---

## Translation Manager (New for v3.0)

The 039 spec deferred translation to v3.1. We're pulling it into v3.0 because it follows the same pattern as transcription and developers expect parity.

### API

```typescript
interface TranslationConfig {
  /** Source language (ISO 639-1). Default: auto-detect. */
  from?: string

  /** Target language (ISO 639-1). Required. */
  to: string
}

interface TranslationEvent {
  /** Translated text. */
  text: string

  /** Whether this is a final translation (vs interim). */
  isFinal: boolean

  /** Detected source language (ISO 639-1). */
  sourceLanguage: string

  /** Target language (ISO 639-1). */
  targetLanguage: string

  /** Original (untranslated) text. */
  originalText?: string

  /** Utterance grouping ID. */
  utteranceId?: string

  /** Confidence score (0-1). */
  confidence?: number

  startTime: number
  endTime: number
}

class TranslationManager {
  /**
   * Subscribe to translation events.
   * Must call configure() first or pass config inline.
   */
  on(handler: (data: TranslationEvent) => void): () => void

  /**
   * Configure translation languages. Can be called mid-session.
   * Internally manages the subscription string (e.g., "translation:en→es").
   */
  configure(config: TranslationConfig): void

  /**
   * Convenience: configure + subscribe in one call.
   */
  to(targetLang: string, handler: (data: TranslationEvent) => void): () => void

  /**
   * Convenience with explicit source.
   */
  fromTo(sourceLang: string, targetLang: string, handler: (data: TranslationEvent) => void): () => void

  /**
   * Stop translation and unsubscribe all handlers.
   */
  stop(): void
}
```

### Usage

```typescript
// Simplest — auto-detect source, translate to Spanish
session.translation.to("es", (data) => {
  session.display.showText(data.text)
})

// Explicit source and target
session.translation.fromTo("en", "ja", (data) => {
  session.display.showText(data.text)
})

// Configure separately, subscribe separately
session.translation.configure({from: "en", to: "es"})
session.translation.on((data) => {
  console.log(data.text)
})

// Change target mid-session (handlers stay subscribed)
session.translation.configure({to: "fr"})

// Stop
session.translation.stop()
```

### Wire protocol mapping

Internally, `TranslationManager` maps to the existing subscription string format:

```
session.translation.to("es", handler)
  → subscribe("translation:auto-es")
  → addHandler for translation data stream

session.translation.fromTo("en", "ja", handler)
  → subscribe("translation:en-ja")
  → addHandler for translation data stream
```

The cloud doesn't need to change. Same subscription strings, same DataStream messages.

### Legacy shim

```typescript
// v2 code:
session.events.onTranslationForLanguage("en-US", "es-ES", handler)

// LegacyEventShim maps to:
session.translation.fromTo("en", "es", handler)
// (strips region suffix from BCP-47 → ISO 639-1)
```

---

## Message Dispatch Refactor

The current `handleMessage()` is a 412-line if/else chain. Replace with a registry pattern:

```typescript
// In AppSession constructor:
this.messageHandlers = new Map<string, (msg: CloudToAppMessage) => void>();

// Each manager registers its handlers:
this.transcription.registerHandlers(this);  // registers DATA_STREAM handler
this.translation.registerHandlers(this);    // registers DATA_STREAM handler (filters by stream type)
this.device.registerHandlers(this);         // registers CONNECTION_ACK, GLASSES_BATTERY, etc.
this.phone.registerHandlers(this);          // registers PHONE_NOTIFICATION, etc.
this.audio.registerHandlers(this);          // registers AUDIO_CHUNK, AUDIO_PLAY_RESPONSE
// ... etc.

// The dispatch is now ~10 lines:
private handleMessage(raw: string) {
  const msg = JSON.parse(raw) as CloudToAppMessage;
  if (!msg?.type) return;

  const handler = this.messageHandlers.get(msg.type);
  if (handler) {
    handler(msg);
  } else {
    this.logger.debug({ type: msg.type }, "Unhandled message type");
  }
}
```

For `DATA_STREAM` messages (which carry transcription, translation, notifications, etc. all under the same message type), the handler dispatches further based on the stream type inside the data payload. This sub-dispatch lives in a `DataStreamRouter` that the relevant managers register with:

```typescript
// DataStreamRouter handles the DATA_STREAM message type
class DataStreamRouter {
  private handlers = new Map<string, (data: any) => void>()

  register(streamPrefix: string, handler: (data: any) => void) {
    this.handlers.set(streamPrefix, handler)
  }

  handle(msg: DataStreamMessage) {
    // msg.streamType might be "transcription:en", "translation:en-ja", etc.
    for (const [prefix, handler] of this.handlers) {
      if (msg.streamType.startsWith(prefix)) {
        handler(msg.data)
        return
      }
    }
  }
}

// TranscriptionManager registers:
dataStreamRouter.register("transcription", (data) => this.emit(data))

// TranslationManager registers:
dataStreamRouter.register("translation", (data) => this.emit(data))

// PhoneManager registers:
dataStreamRouter.register("phone_notification", (data) => this.notifications.emit(data))
```

---

## Route Namespacing + Cloud Compat

Per 039 §24, SDK endpoints move behind `/api/_mentraos/`. But the cloud currently sends webhooks to `${publicUrl}/webhook`, tool calls to `${publicUrl}/tool`, etc.

**Strategy:** v3 SDK mounts both:

```typescript
// Primary (v3)
app.post("/api/_mentraos/webhook", webhookHandler)
app.post("/api/_mentraos/tool", toolHandler)
// ... etc.

// Legacy aliases (for current cloud)
app.post("/webhook", webhookHandler) // same handler, no deprecation warning (cloud sends these)
app.post("/tool", toolHandler)
// ... etc.
```

The cloud can migrate to the new paths at its own pace. Once all cloud deployments send to `/api/_mentraos/*`, the legacy aliases can be removed. This is a cloud-side change, not an SDK concern — the SDK just mounts both.

---

## What Gets Deleted

### Dead code (delete immediately, no shim)

| Code                                    | Lines | Why                                                                |
| --------------------------------------- | ----- | ------------------------------------------------------------------ |
| `pendingUserDiscoveryRequests`          | ~7    | Never read or written                                              |
| `isUserActive()`                        | ~10   | Always throws (passes empty string to function that rejects empty) |
| All app-to-app communication            | ~250  | Backend broken, feature unused (039 D40)                           |
| `DashboardAPI` (old mini-app interface) | ~100  | Dashboard is cloud-internal now (047)                              |
| `TpaServer` / `TpaSession`              | ~40   | Already deprecated for 2 major versions                            |
| `dashboard.ts` session module (old)     | ~200  | Replaced by v3 DashboardManager                                    |
| `appInstructions` config field          | ~5    | Deprecated, unused                                                 |
| `cloudApiUrl` config field              | ~5    | Deprecated, cloud provides URL via webhook                         |
| `webhookPath` config field              | ~5    | Deprecated, hardcoded to `/webhook`                                |

### Extracted to modules (moved, not deleted)

| Code in AppSession             | Destination                                  | Lines moved |
| ------------------------------ | -------------------------------------------- | ----------- |
| App-to-app communication       | DELETED (not moved)                          | ~250        |
| WiFi status/setup              | `DeviceManager`                              | ~45         |
| Telemetry buffer + upload      | `TelemetryModule` (internal)                 | ~50         |
| Instructions fetch             | Keep on session (trivial)                    | ~15         |
| Binary audio send              | `AudioManager` / `MicManager`                | ~15         |
| Settings shadow copy           | Deleted — `SettingsManager` is single source | ~40         |
| 20 deprecated `on*` wrappers   | `LegacyEventShim`                            | ~150        |
| `handleMessage` 412-line chain | `DataStreamRouter` + manager registrations   | ~412 → ~30  |

### Net result

|                    | Before       | After                         |
| ------------------ | ------------ | ----------------------------- |
| `AppSession`       | ~2,423 lines | ~500 lines                    |
| `AppServer`        | ~1,006 lines | ~150 lines (compat shim)      |
| `MentraApp` (new)  | —            | ~400 lines                    |
| Total new managers | —            | ~1,200 lines across ~10 files |
| Dead code removed  | —            | ~650 lines                    |

---

## Bug Fixes Included

| Bug                                                    | Fix                                                      |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `isUserActive()` always throws                         | Delete it (app-to-app removed)                           |
| Double `disconnected` event emission                   | Single emission point in close handler                   |
| `cookieSecret` defaults to `apiKey`                    | Generate random secret if none provided                  |
| `subscribeToGestures` bypasses EventManager            | Route through `DeviceManager`                            |
| Dynamic `require()` for DashboardManager               | Top-level import (circular dep eliminated by extraction) |
| Dynamic `require()` for token utils                    | Top-level import                                         |
| Duplicate URL validation in constructor                | Single validation pass                                   |
| Duplicate `connect()` promise resolution               | Single resolve point                                     |
| `console.log` in `disconnect()`                        | Use `this.logger` everywhere                             |
| `onSettingsUpdate` duck-typing with `as any`           | Proper callback on `MentraApp`                           |
| Error wrapping copy-pasted ~20 times                   | `toErrorMessage()` utility                               |
| `_audioStreamReadyHandlers` is public                  | Private, accessed via module method                      |
| Stale comment with missing `${}` interpolation (L1309) | Fix the template literal                                 |
| Settings stored in two places                          | Kill `settingsData`, `SettingsManager` is sole owner     |

---

## Implementation Phases

### Phase 1: Foundation (~3 days)

**Goal:** New `MentraApp` class works, `AppServer` shim wraps it, existing apps still run.

1. Create `MentraApp` class (Hono server, callback hooks, route namespacing)
2. Create `AppServer` compat shim (wraps `MentraApp`, maps overrides → callbacks)
3. Slim `AppSessionConfig` — remove deprecated fields
4. Verify captions app runs with zero changes via `AppServer` shim
5. Add `toErrorMessage()` utility, route namespacing with legacy aliases

### Phase 2: Manager extraction (~5 days)

**Goal:** `AppSession` shrinks to ~500 lines. All managers exist and work.

1. **`TranscriptionManager`** — new, replaces `events.onTranscription*` (~1.5 days)
2. **`TranslationManager`** — new, replaces `events.onTranslation*` (~1 day)
3. **`DisplayManager`** — rename from `LayoutManager`, add `showText(string|string[])`, `wrap()`, device info (~0.5 day)
4. **`MicManager`** — new, takes audio input from `EventManager` + `AudioManager` (~0.5 day)
5. **`DeviceManager`** — new, absorbs hardware events + WiFi + capabilities from session (~0.5 day)
6. **`PhoneManager`** — new, absorbs phone events with sub-scoped notifications/calendar (~0.5 day)
7. **`PermissionsManager`** — new, centralized permission checks (~0.25 day)
8. **`DashboardManager`** — redesigned, `.showText()` + `.clear()` only (~0.25 day)
9. **`TimeUtils`** — new, timezone + formatting (~0.25 day)
10. **`StorageManager`** — rename from `SimpleStorage` (~0.1 day)

### Phase 3: Message dispatch refactor (~1.5 days)

**Goal:** `handleMessage` goes from 412-line if/else to ~30-line dispatch map.

1. Create `DataStreamRouter`
2. Each manager registers its handlers
3. Wire up in `AppSession` constructor
4. Delete old `handleMessage`

### Phase 4: Compat shim layer (~1.5 days)

**Goal:** `session.events.*`, `session.layouts.*`, `session.on*()` all still work with warnings.

1. Create `LegacyEventShim` — maps every `session.events.*` call to the corresponding manager
2. Add deprecated getters on `AppSession` (`layouts`, `simpleStorage`, `settings`, `capabilities`)
3. Add deprecated direct methods on `AppSession` (`onTranscription`, `onButtonPress`, etc.)
4. Each deprecated path logs once-per-session warning with migration hint
5. BCP-47 → ISO 639-1 auto-mapping in shim (strip `-US`, `-JP` suffixes)

### Phase 5: Dead code removal + bug fixes (~1 day)

**Goal:** Everything from the "What Gets Deleted" and "Bug Fixes" tables above.

1. Delete app-to-app communication (250 lines)
2. Delete old `DashboardAPI`
3. Delete `TpaServer` / `TpaSession`
4. Delete `pendingUserDiscoveryRequests`
5. Fix all bugs from the table
6. Replace all `console.*` with `this.logger`

### Phase 6: Polish + publish (~2 days)

**Goal:** v3.0 ships.

1. Update all examples to v3 API
2. Write migration guide
3. Update README
4. Run captions app, example apps against cloud-debug
5. Publish `3.0.0` to npm (drop `-hono` prerelease tag)
6. Update public example repos

### Phase 7: v3.1 cleanup (separate PR, ~1 day)

**Goal:** Remove all compat shims.

1. Delete `AppServer` compat shim
2. Delete `LegacyEventShim`
3. Delete all deprecated getters on `AppSession`
4. Delete legacy route aliases
5. Publish `3.1.0`

---

## Total Effort

| Phase                       | Days         |
| --------------------------- | ------------ |
| Phase 1: Foundation         | ~3           |
| Phase 2: Manager extraction | ~5           |
| Phase 3: Message dispatch   | ~1.5         |
| Phase 4: Compat shim        | ~1.5         |
| Phase 5: Dead code + bugs   | ~1           |
| Phase 6: Polish + publish   | ~2           |
| **Total for v3.0**          | **~14 days** |
| Phase 7: v3.1 cleanup       | ~1           |

---

## Open Questions

| #   | Question                                                                   | Notes                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Remove `session.events` entirely in v3.0?**                              | Pro: clean, no dual paths. Con: harder migration for existing apps. Current plan: keep as deprecated shim, remove in v3.1. But if we're already providing `AppServer` class shim + deprecated getters, do we need ANOTHER shim object? |
| 2   | **v3.1 timeline**                                                          | How long do we give developers before removing shims? 4 weeks? 8 weeks? Need to commit to a date.                                                                                                                                      |
| 3   | **`session.translation.to()` — does auto-detect source work with Soniox?** | Need to verify Soniox supports translation without explicit source language. If not, `from` becomes required and `.to()` convenience method won't work.                                                                                |
| 4   | **ISO 639-1 codes in wire protocol**                                       | 039 says v3 SDK sends `transcription:en` not `transcription:en-US`. Cloud needs to accept both. Is this cloud change already in place or do we need to add it?                                                                         |
| 5   | **`publicDir` in AppServer shim**                                          | The shim uses `serveStatic` from Hono to support legacy `publicDir` config. Does this work with the same path semantics as the old Express static middleware? Need to test.                                                            |
| 6   | **Captions app migration**                                                 | Should we migrate captions to v3 API as part of this PR, or keep it on the `AppServer` shim and migrate separately? Migrating it validates the new API; keeping it validates the shim.                                                 |
| 7   | **Cloud route migration**                                                  | When does the cloud switch from `${publicUrl}/webhook` to `${publicUrl}/api/_mentraos/webhook`? Can be done independently, but should we coordinate?                                                                                   |

---

## File Structure (Proposed)

```
packages/sdk/src/
├── index.ts                          # Public exports
├── MentraApp.ts                      # NEW — Hono server, callback hooks
├── compat/
│   ├── AppServer.ts                  # v2 compat shim (class inheritance → callbacks)
│   ├── LegacyEventShim.ts           # v2 compat: session.events.* → managers
│   └── deprecated-methods.ts        # v2 compat: session.onTranscription() etc.
├── session/
│   ├── AppSession.ts                 # Slim orchestrator (~500 lines)
│   ├── DataStreamRouter.ts           # Message dispatch for DATA_STREAM subtypes
│   └── managers/
│       ├── TranscriptionManager.ts   # NEW
│       ├── TranslationManager.ts     # NEW
│       ├── DisplayManager.ts         # Renamed from LayoutManager + wrap() integration
│       ├── CameraModule.ts           # Existing, minor cleanup
│       ├── AudioManager.ts           # Existing, output only
│       ├── MicManager.ts             # NEW — audio input
│       ├── DeviceManager.ts          # NEW — hardware events, WiFi, capabilities
│       ├── PhoneManager.ts           # NEW — notifications, calendar, battery
│       ├── LocationManager.ts        # Existing, redesigned API
│       ├── LedModule.ts              # Existing, no changes
│       ├── StorageManager.ts         # Renamed from SimpleStorage
│       ├── PermissionsManager.ts     # NEW
│       ├── DashboardManager.ts       # Redesigned — showText() + clear()
│       └── TimeUtils.ts             # NEW — timezone + formatting
├── types/                            # Existing, cleaned up
├── utils/
│   ├── error-utils.ts                # NEW — toErrorMessage()
│   └── ...existing utils
├── logging/                          # Existing
└── constants/                        # Existing
```
