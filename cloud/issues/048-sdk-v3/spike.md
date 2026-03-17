# Spike: SDK v3 Implementation Plan

**Issue:** 048
**Branch:** `cloud/issues-048`
**Status:** Spike
**Spec:** [`039-sdk-v3-api-surface/v2-v3-api-map.md`](../039-sdk-v3-api-surface/v2-v3-api-map.md)
**Date:** 2026-03-17
**Updated:** 2026-03-17 — `MentraSession` rename, local runtime, app distribution

---

## Overview

**What this doc covers:** Implementation plan for `@mentra/sdk` v3. The API surface design is already specced in [039](../039-sdk-v3-api-surface/v2-v3-api-map.md) — this doc is about how to build it, how to handle backward compat, and what order to do things in.

**What this doc does NOT cover:** The API design itself. If you need to understand _what_ the v3 API looks like, read the 039 API map first.

**Key constraints:**

- Cloud wire protocol (WebSocket messages, subscription strings, webhook format) does NOT change.
- v2 apps already deployed must keep working with the current cloud.
- v3 is a breaking change for SDK consumers, but we provide a v2 compat layer so `npm update` doesn't immediately break existing apps.
- The compat layer is a separate object (`AppServer`) that wraps the new `MentraApp`. It ships in v3.0 with deprecation warnings and is removed in v3.1.
- The session layer (`MentraSession` + managers) must be runtime-agnostic — no Node.js/Bun/server dependencies. It must run on a cloud server (via `MentraApp`) AND on-device (via a local runtime on the phone). Same API, different host environments.

**Key naming:**

- `MentraApp` — the HTTP server (Hono, creates sessions from webhooks). Cloud/server apps only.
- `MentraSession` — one user's connection. The thing developers interact with. Same class everywhere — cloud, phone, webview.
- `AppServer` — deprecated v2 compat shim that wraps `MentraApp`.

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

### Layer diagram — cloud apps (server-side)

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
│  Session factory → creates MentraSession per user    │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│       MentraSession  (thin orchestrator, ~500 lines) │
│                                                      │
│  Transport: injectable (WebSocket, native bridge, etc)│
│  Message dispatcher: Map<type, handler>              │
│                                                      │
│  Managers (public readonly):                         │
│  ├── session.transcription  — TranscriptionManager   │
│  ├── session.translation    — TranslationManager     │
│  ├── session.display        — DisplayManager         │
│  ├── session.camera         — CameraModule           │
│  ├── session.speaker        — SpeakerManager (output)│
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
│          Transport layer                             │
│                                                      │
│  Cloud apps: WebSocket to cloud (/app-ws)            │
│  Local apps: Native bridge to phone OS runtime       │
│                                                      │
│  Both use the same message protocol:                 │
│  CONNECTION_INIT, SUBSCRIPTION_UPDATE,               │
│  DataStream, AudioChunk, DisplayRequest, etc.        │
└─────────────────────────────────────────────────────┘
```

### Layer diagram — local apps (on-device)

```
┌─────────────────────────────────────────────────────┐
│              Developer's app bundle                  │
│              (JS, hosted at a URL or in app store)   │
│                                                      │
│  Same code as a cloud app:                           │
│    session.transcription.on((data) => {              │
│      session.display.showText(data.text)             │
│    })                                                │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│       MentraSession  (SAME class as cloud apps)      │
│                                                      │
│  Transport: native bridge (not WebSocket)            │
│  Same managers, same API, same message types         │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│       Phone OS Runtime                               │
│       (JS engine + native bindings)                  │
│                                                      │
│  Routes messages to local or cloud services:         │
│  ├── display      → Bluetooth to glasses             │
│  ├── camera       → Bluetooth to glasses             │
│  ├── speaker      → Bluetooth to glasses             │
│  ├── mic          → glasses mic via Bluetooth        │
│  ├── transcription→ on-device (Whisper) OR cloud     │
│  ├── location     → phone GPS                        │
│  ├── phone        → phone notifications/calendar     │
│  └── storage      → local storage on phone           │
│                                                      │
│  Bundle loader:                                      │
│  ├── Fetch from app store CDN or developer URL       │
│  ├── Cache locally (works offline after first load)  │
│  └── Version check on launch                         │
└─────────────────────────────────────────────────────┘
```

### v2 Compat Shim Layer

The shim is a **separate file** (`compat/AppServer.ts`) that wraps `MentraApp`:

```typescript
// compat/AppServer.ts — the entire v2 compat layer

import { MentraApp } from "../MentraApp";
import type { MentraSession } from "../session/MentraSession";

/** @deprecated Use MentraApp instead. Will be removed in v3.1. */
export class AppServer {
  private _app: MentraApp;

  constructor(config: AppServerConfig) {
    console.warn(
      "⚠️ AppServer is deprecated. Use MentraApp instead.\n" +
      "   See migration guide: https://docs.mentra.glass/sdk/migration"
    );

    this._app = new MentraApp({
      packageName: config.packageName,
      apiKey: config.apiKey,
      port: config.port ?? 7010,
    });

    // Wire the override pattern → callback pattern
    this._app.onSession((session) => {
      const sessionId = session.getSessionId();
      const userId = session.userId;
      return this.onSession(session, sessionId, userId);
    });

    this._app.onStop((session, reason) => {
      const sessionId = session.getSessionId();
      const userId = session.userId;
      return this.onStop(sessionId, userId, reason);
    });

    this._app.onToolCall((toolCall) => {
      return this.onToolCall(toolCall);
    });

    // Legacy static file support
    if (config.publicDir && config.publicDir !== false) {
      const { serveStatic } = require("hono/bun");
      this._app.use("/public/*", serveStatic({ root: config.publicDir }));
    }
  }

  // Override hooks — subclasses implement these (same as v2)
  protected async onSession(session: MentraSession, sessionId: string, userId: string): Promise<void> {}
  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {}
  protected async onToolCall(toolCall: any): Promise<any> {}

  async start() { return this._app.start(); }
  async stop() { return this._app.stop(); }

  /** @deprecated MentraApp is a Hono app — add routes directly on it. */
  getExpressApp() {
    console.error(
      "❌ getExpressApp() is removed in v3. MentraApp uses Hono, not Express.\n" +
      "   Add routes directly: app.get('/my-route', handler)"
    );
    return this._app;
  }

  /** @deprecated Use the MentraApp instance directly. */
  getHonoApp() { return this._app; }
}
}
```

**What this gives us:**

The captions app — the most complex real-world SDK user — would work with **zero code changes** after updating to v3.0:

```typescript
// This STILL WORKS in v3.0 (with deprecation warnings)
export class LiveCaptionsApp extends AppServer {
  constructor(config) {
    super({ packageName: config.packageName, apiKey: config.apiKey, port: config.port });
  }

  protected async onSession(session: MentraSession, sessionId: string, userId: string) {
    // session.events.onTranscription() → still works via LegacyEventShim
    // session.layouts.showTextWall() → still works via alias
  }
}
```

Then in v3.1, they migrate to:

```typescript
// v3 way — clean, cloud app
const app = new MentraApp({ packageName: "...", apiKey: "...", port: 3000 });

app.onSession((session) => {
  session.transcription.on((data) => {
    session.display.showText(data.text);
  });
});

await app.start();
```

And the exact same session code works as a local app on the phone:

```typescript
// v3 way — local app (same session API, no MentraApp / no server)
// The phone OS runtime creates the session and calls this:
export default function onSession(session: MentraSession) {
  session.transcription.on((data) => {
    session.display.showText(data.text);
  });
}
```

### Session-Level Compat Shim

`MentraSession` in v3 exposes new managers. But old code uses `session.events.*`, `session.layouts.*`, etc. The shim strategy:

| Old accessor                                                 | Shim approach                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `session.events.onTranscription(handler)`                    | `LegacyEventShim` — delegates to `session.transcription.on(handler)`                                            |
| `session.events.onTranscriptionForLanguage(lang, handler)`   | `LegacyEventShim` — delegates to `session.transcription.forLanguage(lang, handler)` (strips BCP-47 → ISO 639-1) |
| `session.events.onTranslationForLanguage(src, tgt, handler)` | `LegacyEventShim` — delegates to `session.translation.fromTo(src, tgt, handler)` (strips BCP-47)                |
| `session.events.onButtonPress(handler)`                      | `LegacyEventShim` — delegates to `session.device.onButtonPress(handler)`                                        |
| `session.events.onPhoneNotifications(handler)`               | `LegacyEventShim` — delegates to `session.phone.notifications.on(handler)`                                      |
| `session.events.onAudioChunk(handler)`                       | `LegacyEventShim` — delegates to `session.mic.onChunk(handler)`                                                 |
| `session.layouts.showTextWall(text)`                         | `session.layouts` is a getter that returns `session.display` (alias)                                            |
| `session.simpleStorage`                                      | Getter that returns `session.storage`                                                                           |
| `session.capabilities`                                       | Getter that returns `session.device.capabilities`                                                               |
| `session.onTranscription(handler)`                           | Direct deprecated methods on session — delegate to managers                                                     |
| `session.subscribe(stream)`                                  | `LegacyEventShim` — logs warning, internally handled by managers                                                |
| `session.getSettings()` / `.getSetting(key)`                 | Delegate to `session.storage.getAll()` / `.get(key)`                                                            |
| `session.getWifiStatus()`                                    | Delegate to `session.device.wifiConnected.value`                                                                |

The `LegacyEventShim` is a single object exposed as `session.events` that maps every old `session.events.*` method to the corresponding v3 manager call. It's one file, ~200 lines of pure delegation, logs a deprecation warning on first access. Removed entirely in v3.1.

**Key principle:** The v3 `MentraSession` implementation has NO awareness of the shim. The shim wraps the session from the outside. The new managers are the real implementation. The shim is applied in the `AppServer` compat constructor, not in `MentraApp`.

Actually — correction. The shim should be on `MentraSession` itself so that even `MentraApp` users who happen to use old method names get warnings. The session exposes both the new managers AND the deprecated accessors, but the deprecated ones are just getters that delegate. This means:

```typescript
class MentraSession {
  // ─── v3 managers (the real API) ───────────────
  readonly transcription: TranscriptionManager;
  readonly translation: TranslationManager;
  readonly display: DisplayManager;
  readonly camera: CameraModule;
  readonly speaker: SpeakerManager;
  readonly mic: MicManager;
  readonly device: DeviceManager;
  readonly phone: PhoneManager;
  readonly location: LocationManager;
  readonly led: LedModule;
  readonly storage: StorageManager;
  readonly permissions: PermissionsManager;
  readonly dashboard: DashboardManager;
  readonly time: TimeUtils;

  // ─── v2 compat (deprecated getters, removed in v3.1) ───
  /** @deprecated Use session.display */
  get layouts() {
    return this.display;
  }

  /** @deprecated Use session.speaker */
  get audio() {
    return this.speaker;
  }

  /** @deprecated Use session.storage */
  get simpleStorage() {
    return this.storage;
  }

  /** @deprecated Use session.storage */
  get settings() {
    return this._legacySettings;
  }

  /** @deprecated Use managers directly */
  get events() {
    return this._legacyEvents;
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

## Transcription Manager (New for v3.0)

Replaces `session.events.onTranscription*` with a focused manager. Supports multiple simultaneous language-specific handlers — each `forLanguage()` call is independent, returns its own cleanup function.

### API

```typescript
interface TranscriptionConfig {
  /** Language hints — advisory input for accuracy, NOT filters.
   *  Uses ISO 639-1 codes: 'en', 'ja', 'es', etc.
   *  Default: auto-detect (no hints). */
  languageHints?: string[];

  /** Custom vocabulary for better recognition of domain-specific terms.
   *  e.g., ['MentraOS', 'HIPAA', 'kubectl'] */
  vocabulary?: string[];

  /** Enable/disable speaker diarization.
   *  Default: true (Soniox gives it for free). */
  diarization?: boolean;
}

interface TranscriptionEvent {
  text: string;
  isFinal: boolean;
  language: string; // ISO 639-1 detected language
  speakerId?: string;
  utteranceId?: string;
  confidence?: number;
  startTime: number;
  endTime: number;
  duration?: number;
  metadata?: TranscriptionMetadata;
}

class TranscriptionManager {
  /** Subscribe to ALL transcription events (auto-detect, all languages). */
  on(handler: (data: TranscriptionEvent) => void): () => void;

  /** Subscribe to transcription for specific language(s).
   *  Each call is independent — multiple can be active simultaneously.
   *  Accepts a single language or array. Returns cleanup function. */
  forLanguage(lang: string | string[], handler: (data: TranscriptionEvent) => void): () => void;

  /** Configure hints, vocabulary, diarization. Applies to all active subscriptions.
   *  Can be called mid-session. */
  configure(config: TranscriptionConfig): void;

  /** Stop all transcriptions and unsubscribe all handlers. */
  stop(): void;
}
```

### Usage

```typescript
// Simplest — zero config, auto-detect, diarization included
session.transcription.on((data) => {
  console.log(`[${data.language}] ${data.speakerId}: ${data.text}`);
});

// Language-specific — each call is independent, both active simultaneously
const stopEnglish = session.transcription.forLanguage("en", (data) => {
  showOnLeftPanel(data.text);
});
const stopJapanese = session.transcription.forLanguage("ja", (data) => {
  showOnRightPanel(data.text);
});

// Stop just one — Japanese keeps running
stopEnglish();

// Multiple languages, one handler
session.transcription.forLanguage(["en", "ja", "es"], (data) => {
  console.log(`[${data.language}] ${data.text}`);
});

// Configure hints (applies to all active subscriptions)
session.transcription.configure({
  languageHints: ["en", "ja"],
  vocabulary: ["MentraOS", "Soniox"],
});

// Stop everything
session.transcription.stop();
```

### Wire protocol mapping

```
session.transcription.on(handler)
  → subscribe("transcription:auto")

session.transcription.forLanguage("en", handler)
  → subscribe("transcription:en")

session.transcription.forLanguage(["en", "ja"], handler)
  → subscribe("transcription:en") + subscribe("transcription:ja")
  → handler called for both, data.language tells you which
```

### Legacy shim

```typescript
// v2 code:
session.events.onTranscription(handler);
// LegacyEventShim maps to:
session.transcription.on(handler);

// v2 code:
session.events.onTranscriptionForLanguage("en-US", handler, opts);
// LegacyEventShim maps to:
session.transcription.forLanguage("en", handler);
// (strips region suffix from BCP-47 → ISO 639-1)
```

---

## Translation Manager (New for v3.0)

The 039 spec deferred translation to v3.1. We're pulling it into v3.0 because it follows the same pattern as transcription and developers expect parity. Supports multiple simultaneous target languages — each `to()` call is independent.

### API

```typescript
interface TranslationEvent {
  /** Translated text. */
  text: string;

  /** Whether this is a final translation (vs interim). */
  isFinal: boolean;

  /** Detected source language (ISO 639-1). */
  sourceLanguage: string;

  /** Target language (ISO 639-1). */
  targetLanguage: string;

  /** Original (untranslated) text. */
  originalText?: string;

  /** Utterance grouping ID. */
  utteranceId?: string;

  /** Confidence score (0-1). */
  confidence?: number;

  startTime: number;
  endTime: number;
}

class TranslationManager {
  /** Subscribe to ALL active translation events. */
  on(handler: (data: TranslationEvent) => void): () => void;

  /** Auto-detect source, translate to one or more targets.
   *  Each call is independent — multiple can be active simultaneously.
   *  Accepts a single language or array. Returns cleanup function. */
  to(target: string | string[], handler: (data: TranslationEvent) => void): () => void;

  /** Explicit source, translate to one or more targets.
   *  Same independence and cleanup semantics as to(). */
  fromTo(source: string, target: string | string[], handler: (data: TranslationEvent) => void): () => void;

  /** Stop all translations and unsubscribe all handlers. */
  stop(): void;
}
```

### Usage

```typescript
// Simplest — auto-detect source, translate to Spanish
session.translation.to("es", (data) => {
  session.display.showText(data.text);
});

// Multiple targets simultaneously — both active, independent
const stopSpanish = session.translation.to("es", (data) => {
  showOnLeftPanel(data.text);
});
const stopJapanese = session.translation.to("ja", (data) => {
  showOnRightPanel(data.text);
});

// Stop just Spanish — Japanese keeps running
stopSpanish();

// Multiple targets in one call — handler gets called for each
session.translation.to(["es", "ja", "fr"], (data) => {
  // data.targetLanguage tells you which one
  console.log(`[${data.targetLanguage}] ${data.text}`);
});

// Explicit source and target
session.translation.fromTo("en", "ja", (data) => {
  session.display.showText(data.text);
});

// Explicit source, multiple targets
session.translation.fromTo("en", ["es", "ja"], (data) => {
  console.log(`[${data.targetLanguage}] ${data.text}`);
});

// Stop everything
session.translation.stop();
```

### Wire protocol mapping

```
session.translation.to("es", handler)
  → subscribe("translation:auto-es")

session.translation.to(["es", "ja"], handler)
  → subscribe("translation:auto-es") + subscribe("translation:auto-ja")
  → handler called for both, data.targetLanguage tells you which

session.translation.fromTo("en", "ja", handler)
  → subscribe("translation:en-ja")
```

The cloud doesn't need to change. Same subscription strings, same DataStream messages.

### Legacy shim

```typescript
// v2 code:
session.events.onTranslationForLanguage("en-US", "es-ES", handler);

// LegacyEventShim maps to:
session.translation.fromTo("en", "es", handler);
// (strips region suffix from BCP-47 → ISO 639-1)
```

---

## Transport Abstraction

`MentraSession` doesn't care HOW messages are sent and received. On a cloud server, it's a WebSocket. On the phone, it's a native bridge. In tests, it's a mock. The session accepts an injectable transport:

```typescript
interface Transport {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  close(): void;
  readonly readyState: number;
}
```

A real WebSocket satisfies this. A React Native bridge adapter satisfies this. A mock for testing satisfies this. `MentraSession` never imports `WebSocket` directly — it receives a `Transport` from the host environment.

For cloud apps, `MentraApp` creates a `WebSocketTransport` when the webhook arrives. For local apps, the phone OS runtime creates a `NativeBridgeTransport` when the app is loaded. The session doesn't know or care which one it got.

This also means the session layer has **zero Node.js/Bun/server dependencies** — no `ws`, no `http`, no `fs`, no `Hono`. Pure JavaScript that runs in any JS engine (V8, JSC, Hermes, QuickJS).

---

## Message Dispatch Refactor

The current `handleMessage()` is a 412-line if/else chain. Replace with a registry pattern:

```typescript
// In MentraSession constructor:
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

For `DATA_STREAM` messages (which carry transcription, translation, notifications, etc. all under the same message type), the handler dispatches further based on the stream type inside the data payload. Multiple managers can register for the same prefix — `DataStreamRouter` calls all matching handlers (e.g., two `forLanguage("en")` calls both get the English transcription data). This sub-dispatch lives in a `DataStreamRouter` and works identically regardless of whether the `DataStream` message came from a cloud WebSocket or a local on-device transcription engine:

```typescript
// DataStreamRouter handles the DATA_STREAM message type
class DataStreamRouter {
  private handlers = new Map<string, (data: any) => void>();

  register(streamPrefix: string, handler: (data: any) => void) {
    this.handlers.set(streamPrefix, handler);
  }

  handle(msg: DataStreamMessage) {
    // msg.streamType might be "transcription:en", "translation:en-ja", etc.
    for (const [prefix, handler] of this.handlers) {
      if (msg.streamType.startsWith(prefix)) {
        handler(msg.data);
        return;
      }
    }
  }
}

// TranscriptionManager registers:
dataStreamRouter.register("transcription", (data) => this.emit(data));

// TranslationManager registers:
dataStreamRouter.register("translation", (data) => this.emit(data));

// PhoneManager registers:
dataStreamRouter.register("phone_notification", (data) => this.notifications.emit(data));
```

---

## Route Namespacing + Cloud Compat

Per 039 §24, SDK endpoints move behind `/api/_mentraos/`. But the cloud currently sends webhooks to `${publicUrl}/webhook`, tool calls to `${publicUrl}/tool`, etc.

**Strategy:** v3 SDK mounts both:

```typescript
// Primary (v3)
app.post("/api/_mentraos/webhook", webhookHandler);
app.post("/api/_mentraos/tool", toolHandler);
// ... etc.

// Legacy aliases (for current cloud)
app.post("/webhook", webhookHandler); // same handler, no deprecation warning (cloud sends these)
app.post("/tool", toolHandler);
// ... etc.
```

The cloud can migrate to the new paths at its own pace. Once all cloud deployments send to `/api/_mentraos/*`, the legacy aliases can be removed. This is a cloud-side change, not an SDK concern — the SDK just mounts both.

---

## Local Runtime & App Distribution

### The vision

Today, apps run on a remote server. The cloud is the middleman — glasses → cloud → app server → cloud → glasses. If the internet goes down, nothing works.

v3 enables a second mode: **apps that run on the phone itself**. The phone is already physically connected to the glasses (Bluetooth). It already has mic audio, GPS, camera feed, notifications. A captions app shouldn't need to bounce audio to a remote server and back when the phone can transcribe locally.

### How it works

The app is a JavaScript bundle hosted at a URL — the same `publicUrl` already registered in the dev console. Today the cloud sends webhooks to that URL. In local mode, the phone downloads the JS bundle from that URL, caches it, and runs it in a lightweight JS engine (JavaScriptCore / Hermes).

The developer's code is identical:

```typescript
// This same code works as a cloud app AND a local app
session.transcription.on((data) => {
  session.display.showText(data.text);
});
```

The only difference is WHERE it runs and HOW the session is established:

- **Cloud app:** `MentraApp` receives a webhook → creates `MentraSession` with `WebSocketTransport`
- **Local app:** Phone OS runtime loads the JS bundle → creates `MentraSession` with `NativeBridgeTransport`

The phone's OS runtime routes messages to the right place:

- `display` → Bluetooth to glasses
- `camera` → glasses camera via Bluetooth
- `mic` → glasses mic via Bluetooth
- `transcription` → on-device (Whisper) OR cloud (Soniox), transparent to the app
- `location` → phone GPS
- `phone` → phone notifications/calendar
- `storage` → local storage on phone

### App distribution

Two paths, like every app platform:

**Store path (default, recommended):**

1. Developer submits bundle to MentraOS dev console (already exists)
2. We host it on our CDN — fast, globally cached
3. Review process can scan the bundle (permissions, no malicious code)
4. Users install from the MentraOS app on their phone
5. Updates: developer pushes new version → review → users get it automatically

**Self-host / sideload path (development, enterprise, testing):**

1. Developer enters their own URL in the dev console (or dev settings on phone)
2. Phone fetches bundle from that URL directly
3. No review — developer's responsibility
4. Great for development (localhost / ngrok), enterprise internal apps, beta testing

Update model is like a PWA:

1. Phone downloads bundle on first install, caches locally
2. Works offline after that — bundle is cached, JS engine is local, glasses are Bluetooth
3. Periodically checks for new version (or on app launch)
4. New version available → downloads in background → swaps on next launch
5. Developer just deploys to their URL — same workflow as updating a website

### What this means for v3 SDK

The local runtime is a separate epic — it requires mobile team work for the JS engine, native bindings, bundle loader, and Bluetooth routing. But v3 must not block it. The architectural constraints:

1. **`MentraSession` + all managers: zero server/Node.js/Bun dependencies.** No `ws`, `http`, `fs`, `Hono` imports. Pure JS that runs in any engine.
2. **Transport is injectable** — `Transport` interface, not hardcoded `new WebSocket()`.
3. **Package exports include a server-free entrypoint** — `@mentra/sdk/session` imports only the session + managers, no Hono.
4. **Same message types everywhere** — a `DataStream` with transcription data looks identical whether it came from cloud Soniox or on-device Whisper. A `DisplayRequest` is the same over WebSocket or native bridge.
5. **Managers must not assume cloud** — e.g., `TranscriptionManager` doesn't know if transcription is running in the cloud or locally. It just sends/receives messages through the transport.

### Hybrid apps

An app can be hybrid — run locally for low-latency features (display, camera, immediate UI) but hit the cloud for heavy features (LLM, complex transcription, RTMP streaming). The phone OS runtime handles the routing transparently. The app developer doesn't choose per-feature — the OS decides based on availability and the app's declared capabilities.

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

|                                | Before       | After                         |
| ------------------------------ | ------------ | ----------------------------- |
| `AppSession` → `MentraSession` | ~2,423 lines | ~500 lines                    |
| `AppServer`                    | ~1,006 lines | ~150 lines (compat shim)      |
| `MentraApp` (new)              | —            | ~400 lines                    |
| Total new managers             | —            | ~1,200 lines across ~10 files |
| Dead code removed              | —            | ~650 lines                    |

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

**Goal:** `MentraSession` exists with transport abstraction. `MentraApp` works. `AppServer` shim wraps it. Existing apps still run.

1. Define `Transport` interface
2. Rename `AppSession` → `MentraSession`, accept `Transport` in constructor
3. Create `WebSocketTransport` (wraps `ws` — used by `MentraApp` only, not in session layer)
4. Create `MentraApp` class (Hono server, callback hooks, route namespacing)
5. Create `AppServer` compat shim (wraps `MentraApp`, maps overrides → callbacks)
6. Slim config — remove deprecated fields
7. Verify captions app runs with zero changes via `AppServer` shim
8. Add `toErrorMessage()` utility, route namespacing with legacy aliases
9. Set up `@mentra/sdk/session` entrypoint (no Hono, no server deps)

### Phase 2: Manager extraction (~5 days)

**Goal:** `AppSession` shrinks to ~500 lines. All managers exist and work.

2. **`TranscriptionManager`** — new, replaces `events.onTranscription*`, supports `forLanguage(string | string[])`, multiple simultaneous (~1.5 days)
3. **`TranslationManager`** — new, replaces `events.onTranslation*`, supports `to(string | string[])` / `fromTo()`, multiple simultaneous (~1.5 days)
4. **`DisplayManager`** — rename from `LayoutManager`, add `showText(string|string[])`, `wrap()`, device info (~0.5 day)
5. **`SpeakerManager`** — rename from `AudioManager`, output only (play, TTS) (~0.25 day)
6. **`MicManager`** — new, takes audio input from `EventManager` (~0.5 day)
7. **`DeviceManager`** — new, absorbs hardware events + WiFi + capabilities from session (~0.5 day)
8. **`PhoneManager`** — new, absorbs phone events with sub-scoped notifications/calendar (~0.5 day)
9. **`PermissionsManager`** — new, centralized permission checks (~0.25 day)
10. **`DashboardManager`** — redesigned, `.showText()` + `.clear()` only (~0.25 day)
11. **`TimeUtils`** — new, timezone + formatting (~0.25 day)
12. **`StorageManager`** — rename from `SimpleStorage` (~0.1 day)

### Phase 3: Message dispatch refactor (~1.5 days)

**Goal:** `handleMessage` goes from 412-line if/else to ~30-line dispatch map.

1. Create `DataStreamRouter`
2. Each manager registers its handlers
3. Wire up in `MentraSession` constructor
4. Delete old `handleMessage`

### Phase 4: Compat shim layer (~1.5 days)

**Goal:** `session.events.*`, `session.layouts.*`, `session.on*()` all still work with warnings.

1. Create `LegacyEventShim` — maps every `session.events.*` call to the corresponding manager
2. Add deprecated getters on `MentraSession` (`layouts`, `audio`, `simpleStorage`, `settings`, `capabilities`)
3. Add deprecated direct methods on `MentraSession` (`onTranscription`, `onButtonPress`, etc.)
4. Export `AppSession` as a type alias for `MentraSession` (so `import { AppSession }` still works)
5. Each deprecated path logs once-per-session warning with migration hint
6. BCP-47 → ISO 639-1 auto-mapping in shim (strip `-US`, `-JP` suffixes)

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
3. Delete all deprecated getters on `MentraSession`
4. Delete `AppSession` / `TpaSession` type aliases
5. Delete legacy route aliases
6. Publish `3.1.0`

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
| 8   | **Local runtime JS engine**                                                | Which JS engine for on-device apps? JSC (already on iOS), Hermes (already in RN on Android), or QuickJS (lightweight, embeddable)? Need mobile team input.                                                                             |
| 9   | **Local runtime API surface**                                              | Which cloud features need local equivalents? Transcription (on-device Whisper), display (Bluetooth), camera, audio are obvious. LLM, RTMP streaming probably stay cloud-only. Need to define the boundary.                             |
| 10  | **Align with head of client**                                              | He's building something on the mobile side. Need to coordinate so we don't end up with two incompatible session APIs. The transport abstraction and `MentraSession` should be the shared contract.                                     |
| 11  | **App store review process**                                               | What do we review in submitted bundles? Permissions match? No native API abuse? Bundle size limits? TBD — platform team concern, not SDK.                                                                                              |
| 12  | **Hybrid app routing**                                                     | How does the phone OS decide whether to route a feature locally or to the cloud? Per-feature capability flags? Developer declares in manifest? Automatic based on connectivity? Needs its own spike.                                   |

---

## File Structure (Proposed)

```
packages/sdk/src/
├── index.ts                          # Public exports (full: server + session)
├── session.ts                        # Session-only entrypoint (no server deps)
├── server/
│   └── MentraApp.ts                  # Hono server, callback hooks, webhook handling
├── compat/
│   ├── AppServer.ts                  # v2 compat shim (class inheritance → callbacks)
│   ├── LegacyEventShim.ts           # v2 compat: session.events.* → managers
│   └── deprecated-aliases.ts        # AppSession type alias, session.onTranscription() etc.
├── transport/
│   ├── Transport.ts                  # Transport interface (send, onMessage, close, etc.)
│   └── WebSocketTransport.ts         # WebSocket implementation (used by MentraApp only)
├── session/
│   ├── MentraSession.ts              # Slim orchestrator (~500 lines), accepts Transport
│   ├── DataStreamRouter.ts           # Message dispatch for DATA_STREAM subtypes
│   └── managers/
│       ├── TranscriptionManager.ts   # NEW — forLanguage(string | string[])
│       ├── TranslationManager.ts     # NEW — to(string | string[]), fromTo()
│       ├── DisplayManager.ts         # Renamed from LayoutManager + wrap() integration
│       ├── CameraModule.ts           # Existing, minor cleanup
│       ├── SpeakerManager.ts         # Renamed from AudioManager, output only
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

### Package exports

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./session": "./dist/session.js"
  }
}
```

- `import { MentraApp, MentraSession } from "@mentra/sdk"` — full package, includes server
- `import { MentraSession } from "@mentra/sdk/session"` — session only, zero server deps, runs anywhere JS runs

The `session` entrypoint is what the phone OS runtime would use to create sessions for local apps. It imports nothing from `server/` or `transport/WebSocketTransport.ts`. The phone runtime provides its own `NativeBridgeTransport` that implements the `Transport` interface.

```

```
