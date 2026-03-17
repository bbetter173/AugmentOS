# Spike: Client SDK — Local Runtime on Mobile

**Issue:** 048
**Related:** [SDK v3 spike](./spike.md), [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md)
**Status:** Spike / Brainstorm
**Date:** 2026-03-17

---

## Overview

**What this doc covers:** How to run MentraOS mini apps locally on the phone — same `MentraSession` API, no cloud round-trip — including JS engine options, native bindings, bundle loading, background execution, and app distribution.

**What this doc does NOT cover:** The SDK v3 refactor itself (see [spike.md](./spike.md)). This doc assumes `MentraSession` exists with a `Transport` interface and zero server dependencies.

**Why this matters:** Today, every app round-trips through the cloud: glasses → cloud → app server → cloud → glasses. A captions app shouldn't need internet to display live transcription when the phone can transcribe locally. Local apps unlock offline operation, lower latency, and new categories of apps that need real-time response.

---

## JS Engine Options

### The candidates

| Engine                   | Already in RN?                       | Background?            | Size                            | iOS     | Android | Notes                                                                   |
| ------------------------ | ------------------------------------ | ---------------------- | ------------------------------- | ------- | ------- | ----------------------------------------------------------------------- |
| **Hermes**               | ✅ Default since RN 0.70             | ✅ Yes (native thread) | ~3MB                            | ✅      | ✅      | Bytecode precompilation for instant startup. Meta-maintained.           |
| **JavaScriptCore (JSC)** | ✅ On iOS (system), optional Android | ✅ Yes                 | 0 (iOS system) / ~5MB (Android) | ✅      | ✅      | iOS ships it; Android needs a bundled copy.                             |
| **QuickJS**              | ❌ Must embed                        | ✅ Yes                 | ~210KB                          | ✅      | ✅      | Tiny, embeddable C library. Full ES2023. Used in embedded systems.      |
| **V8 (react-native-v8)** | ❌ Optional                          | ✅ Yes                 | ~8MB                            | ❌ Poor | ✅      | Overkill for this use case. iOS support is weak.                        |
| **Node.js Mobile**       | ❌ Separate binary                   | ✅ Yes                 | ~20MB                           | ✅      | ✅      | Full Node API but extremely heavy. `nodejs-mobile-react-native` exists. |

### Recommendation: Hermes

**Hermes is the clear winner.** Reasons:

1. **Already bundled.** React Native uses Hermes as its default engine. The binary is already in the app. No additional size cost.

2. **Bytecode precompilation.** Hermes can compile JS to `.hbc` (Hermes bytecode) files ahead of time. First-run startup is near-instant — no parsing needed. The app store CDN could serve precompiled `.hbc` files.

3. **JSI (JavaScript Interface).** Hermes uses JSI for its native bridge — synchronous, zero-serialization C++ calls between JS and native. This is how we'd expose `session.display.showText()` as a native call that sends a Bluetooth command to the glasses with no async overhead.

4. **Separate context isolation.** We can create a dedicated Hermes runtime instance for mini apps, separate from the main RN UI thread. If a mini app crashes, the MentraOS UI stays alive. Similar to Chrome's V8 isolates per tab.

5. **Meta-maintained, actively developed.** Not going anywhere.

### Why not the others?

- **JSC:** Good on iOS (system library, free), but on Android you have to bundle it separately. Hermes is already there on both platforms. No bytecode precompilation.
- **QuickJS:** Incredibly small and fast, but we'd have to build and maintain the native module integration ourselves. Hermes gives us this for free via RN's existing infrastructure.
- **V8:** Too heavy, iOS support is poor, and we don't need its JIT — Hermes's AOT bytecode is better for mobile startup.
- **Node.js Mobile:** 20MB binary for full Node API. We don't need `fs`, `http`, `net`, etc. Our session layer is pure JS.

---

## Background Execution

Running JS in the background on mobile is the hardest problem. Both iOS and Android aggressively kill background processes to save battery.

### How MentraOS gets around this

**MentraOS is a Bluetooth accessory app.** Both iOS and Android grant extended background execution rights to apps that maintain active Bluetooth connections:

- **iOS:** `UIBackgroundModes: bluetooth-central` and `bluetooth-peripheral` in Info.plist. The app stays alive as long as the BLE connection to the glasses is active. Core Bluetooth framework handles reconnection.
- **Android:** Foreground Service with `FOREGROUND_SERVICE_CONNECTED_DEVICE` type. The notification tray shows "MentraOS is connected to your glasses." The process stays alive.

The mini app JS runtime runs in the same process as the MentraOS app. It stays alive as long as the Bluetooth connection does — which is always, while the user is wearing glasses.

### Execution model

```
MentraOS App Process
├── Main Thread (React Native UI)
│   └── App management, settings screens, etc.
│
├── MentraOS Runtime Thread (native)
│   ├── Hermes JS Engine Instance (dedicated)
│   │   ├── Mini App A bundle
│   │   ├── Mini App B bundle
│   │   └── ...
│   │
│   └── JSI Bindings → Native APIs
│
├── Bluetooth Thread (already exists)
│   └── BLE connection to glasses
│
└── Audio Thread (already exists)
    └── Mic input processing
```

The Runtime Thread is a native thread (not the RN JS thread) that hosts its own Hermes instance. Mini app bundles are loaded into this instance. JSI bindings expose native capabilities (Bluetooth, GPS, audio, etc.) as synchronous calls from JS.

**Key: the mini app Hermes instance is separate from the RN UI Hermes instance.** They share no state. Communication between them (if needed) goes through native modules, not JS globals.

---

## Native Bindings via JSI

JSI (JavaScript Interface) is React Native's low-level C++ bridge. It allows JS to call native functions synchronously — no async serialization, no JSON.stringify/parse, no bridge queue.

### How `MentraSession` managers map to native bindings

| Manager                                   | JSI Binding                           | Native Implementation                                  |
| ----------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `session.display.showText(text)`          | `nativeDisplay.showText(text)`        | BLE write to glasses display characteristic            |
| `session.display.showCard({title, body})` | `nativeDisplay.showCard(title, body)` | BLE write (formatted as DisplayRequest)                |
| `session.display.clear()`                 | `nativeDisplay.clear()`               | BLE write (clear command)                              |
| `session.speaker.play(url)`               | `nativeSpeaker.play(url)`             | Download audio, stream via BLE audio channel           |
| `session.speaker.speak(text)`             | `nativeSpeaker.speak(text)`           | On-device TTS → BLE audio                              |
| `session.mic.onChunk(handler)`            | `nativeMic.onChunk(callback)`         | BLE audio input → PCM chunks → JS callback             |
| `session.transcription.on(handler)`       | `nativeTranscription.on(callback)`    | On-device Whisper → transcription events → JS callback |
| `session.camera.takePhoto()`              | `nativeCamera.takePhoto()`            | BLE camera command → wait for BLE photo data           |
| `session.location.onUpdate(handler)`      | `nativeLocation.onUpdate(callback)`   | CoreLocation / FusedLocation → JS callback             |
| `session.phone.notifications.on(handler)` | `nativeNotifications.on(callback)`    | NotificationListenerService / UNNotificationCenter     |
| `session.phone.calendar.on(handler)`      | `nativeCalendar.on(callback)`         | EventKit / CalendarProvider                            |
| `session.storage.get(key)`                | `nativeStorage.get(key)`              | SQLite / AsyncStorage (synchronous via JSI)            |
| `session.device.batteryLevel`             | `nativeDevice.getBatteryLevel()`      | BLE read from glasses battery characteristic           |

### The Transport adapter

In the spike, we defined a `Transport` interface:

```typescript
interface Transport {
  send(data: string): void
  onMessage(handler: (data: string) => void): void
  onClose(handler: (code: number, reason: string) => void): void
  close(): void
  readonly readyState: number
}
```

For cloud apps, this is a `WebSocketTransport`. For local apps, the native runtime creates a `NativeBridgeTransport` that routes messages through JSI bindings:

```typescript
// Implemented in native (C++ via JSI), exposed to JS
class NativeBridgeTransport implements Transport {
  send(data: string): void {
    // Parse the message, route to the appropriate native handler
    // e.g., DisplayRequest → BLE write, SubscriptionUpdate → start/stop native streams
  }

  onMessage(handler: (data: string) => void): void {
    // Register callback for native → JS messages
    // e.g., transcription results, button presses, battery updates
  }

  onClose(handler: (code: number, reason: string) => void): void {
    // Called when glasses disconnect
  }

  close(): void {
    // Cleanup
  }

  get readyState(): number {
    return 1 // Always "open" while glasses are connected
  }
}
```

**The `MentraSession` doesn't know whether it's talking to a cloud WebSocket or a local JSI bridge.** Same message types, same protocol. The session code is literally identical.

---

## Bundle Loading & Caching

### How bundles get onto the phone

**Store path (recommended):**

1. Developer submits JS bundle to MentraOS dev console
2. We compile to Hermes bytecode (`.hbc`) on our build servers
3. Host on CDN (fast, globally cached)
4. Phone downloads `.hbc` on app install
5. Cached in app sandbox — works offline after first download
6. Version check on app launch (or periodic background check)

**Self-host / sideload path (development):**

1. Developer runs local dev server (like `bun run dev`)
2. Phone fetches raw JS from developer's URL (ngrok / local network)
3. Hermes compiles to bytecode on-device (slightly slower first run)
4. Cached locally until developer pushes a new version

### Update model

Like a PWA with service workers:

1. On app launch, check the bundle URL for a new version (ETag / Last-Modified / version.json)
2. If unchanged → use cached `.hbc` immediately (instant startup)
3. If changed → download new bundle in background
4. Swap on next app launch (not mid-session — avoid runtime inconsistency)
5. Rollback: keep the previous `.hbc` in case the new one crashes on startup

### Bundle format

```
my-app-bundle/
├── manifest.json          # Package name, version, permissions, entry point
├── index.hbc              # Hermes bytecode (compiled from index.js)
├── index.js               # Source JS (fallback if .hbc is missing or invalid)
└── assets/                # Optional: images, sounds, etc.
```

```json
// manifest.json
{
  "packageName": "com.example.captions",
  "version": "1.2.0",
  "entry": "index.hbc",
  "permissions": ["microphone", "display"],
  "minOsVersion": "2.0.0"
}
```

### Security

Bundles from the store are signed with our key. The phone verifies the signature before loading. Self-hosted bundles in dev mode skip verification (but show a "dev mode" indicator in the UI).

Bundles run in a sandboxed Hermes context — no access to the filesystem, network, or native APIs beyond what the JSI bindings expose. The permission system (from `manifest.json`) controls which bindings are available.

---

## App Lifecycle

### How a local app starts

```
1. User opens MentraOS app (or glasses connect automatically)
2. MentraOS reads installed apps from local DB
3. For each app marked "auto-start":
   a. Load cached .hbc bundle into Hermes runtime
   b. Create NativeBridgeTransport
   c. Create MentraSession with transport
   d. Call the app's entry point: onSession(session)
4. App is now running — receiving events, sending display commands
```

### How a local app's entry point looks

```typescript
// index.ts — compiled to index.hbc
import {MentraSession} from "@mentra/sdk/session"

// The runtime calls this when the session is ready
export default function onSession(session: MentraSession) {
  session.transcription.on((data) => {
    session.display.showText(data.text)
  })
}

// Optional: called when the session ends (glasses disconnect, app stopped)
export function onStop(session: MentraSession) {
  console.log("bye")
}
```

This is the same pattern as cloud apps:

```typescript
// Cloud app (for comparison)
const app = new MentraApp({packageName: "...", apiKey: "..."})

app.onSession((session) => {
  session.transcription.on((data) => {
    session.display.showText(data.text)
  })
})
```

The only difference: cloud apps use `MentraApp` (Hono server that creates sessions from webhooks). Local apps export `onSession` and the phone runtime calls it directly.

---

## On-Device Transcription

The biggest feature unlock for local apps is on-device transcription. Today, audio goes: glasses mic → phone → cloud (Soniox) → cloud → phone → glasses display. That's 4 network hops for every utterance.

With local transcription: glasses mic → phone (Whisper) → glasses display. Zero network hops.

### Options

| Model                         | Size           | Speed                   | Quality             | Notes                                                          |
| ----------------------------- | -------------- | ----------------------- | ------------------- | -------------------------------------------------------------- |
| **Whisper.cpp (tiny)**        | ~75MB          | Real-time on iPhone 12+ | Good for English    | C++ library, runs on CPU. `whisper.rn` package exists for RN.  |
| **Whisper.cpp (base)**        | ~150MB         | Near-real-time          | Better multilingual | May need Neural Engine / GPU on older phones.                  |
| **Whisper.cpp (small)**       | ~500MB         | Slower                  | Best quality        | Too large for always-on. Use for offline when quality matters. |
| **Apple Speech Framework**    | 0 (system)     | Real-time               | Good                | iOS only. Free, low power. Limited language support.           |
| **Google Speech (on-device)** | ~50MB per lang | Real-time               | Good                | Android only. Downloaded per language.                         |
| **Soniox (cloud)**            | 0              | Real-time               | Best                | Requires internet. Current production system.                  |

### Recommendation: hybrid

- **Default (online):** Soniox via cloud — best quality, all languages
- **Fallback (offline):** Whisper.cpp tiny via `whisper.rn` — good enough for English captions
- **iOS bonus:** Apple Speech Framework as a zero-download option
- **Android bonus:** Google on-device speech for supported languages

The `session.transcription` API is identical regardless of which backend is used. The phone OS runtime decides which one based on:

1. Network connectivity (offline → local model)
2. Language (supported by local model? → use it)
3. User preference (settings: "prefer local" / "prefer cloud" / "auto")

The mini app developer never knows or cares which transcription engine is running.

---

## Hybrid Apps: Local + Cloud

A mini app doesn't have to be 100% local or 100% cloud. It can be hybrid:

- **Low-latency features run locally:** display updates, camera capture, audio playback, button responses
- **Heavy features hit the cloud:** LLM inference, complex transcription (rare languages), RTMP streaming, server-side storage

Example: an AI assistant app that shows live captions locally (Whisper) but sends the transcript to an LLM in the cloud for responses:

```typescript
export default function onSession(session: MentraSession) {
  // Local: real-time captions via on-device Whisper
  session.transcription.on((data) => {
    session.display.showText(data.text)

    if (data.isFinal) {
      // Cloud: send to LLM for a response
      askCloudLLM(data.text).then((response) => {
        session.speaker.speak(response)
      })
    }
  })
}

async function askCloudLLM(text: string): Promise<string> {
  const res = await fetch("https://api.example.com/chat", {
    method: "POST",
    body: JSON.stringify({message: text}),
  })
  const data = await res.json()
  return data.reply
}
```

**`fetch` is available in Hermes** — mini apps can make HTTP requests to their own servers. The SDK doesn't need to mediate this. The phone's network stack handles it normally.

---

## What Needs to Exist on the Mobile Side

This is a rough breakdown of the native work needed to support local apps:

### Native modules to build

| Module                    | Purpose                                                    | Complexity | Notes                                                                            |
| ------------------------- | ---------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| **MentraRuntime**         | Hermes instance management, bundle loading, lifecycle      | High       | Core of the system. Manages app contexts.                                        |
| **NativeBridgeTransport** | JSI bridge implementing the Transport interface            | High       | Routes all message types between JS and native.                                  |
| **NativeDisplay**         | Formats DisplayRequest messages, sends via BLE             | Medium     | BLE write to glasses display characteristic. Already partially exists in mobile. |
| **NativeMic**             | Receives BLE audio from glasses, delivers PCM chunks to JS | Medium     | Already exists in mobile for cloud audio path.                                   |
| **NativeSpeaker**         | Plays audio on glasses via BLE audio channel               | Medium     | TTS integration + audio streaming.                                               |
| **NativeCamera**          | BLE camera commands + receives photo data                  | Medium     | Already exists in mobile for cloud photo path.                                   |
| **NativeTranscription**   | On-device Whisper / Apple Speech / Google Speech           | High       | `whisper.rn` exists but needs integration.                                       |
| **NativeLocation**        | CoreLocation / FusedLocation → JS callbacks                | Low        | Standard RN pattern, mostly boilerplate.                                         |
| **NativeNotifications**   | Phone notification access → JS callbacks                   | Medium     | Platform-specific APIs. Already piped to cloud today.                            |
| **NativeCalendar**        | Calendar events → JS callbacks                             | Low        | Already piped to cloud today via CalendarManager.                                |
| **NativeStorage**         | Per-app sandboxed key-value storage via JSI                | Low        | SQLite or MMKV via JSI (synchronous reads).                                      |
| **BundleLoader**          | Download, cache, verify, and load .hbc bundles             | Medium     | HTTP client + file cache + signature verification.                               |

### Estimated effort

| Phase                                                 | Work                    | Days         |
| ----------------------------------------------------- | ----------------------- | ------------ |
| MentraRuntime + NativeBridgeTransport + BundleLoader  | Core infrastructure     | ~10          |
| NativeDisplay + NativeMic + NativeSpeaker             | Basic I/O               | ~5           |
| NativeCamera                                          | Photo capture           | ~3           |
| NativeTranscription (Whisper integration)             | On-device transcription | ~5           |
| NativeLocation + NativeNotifications + NativeCalendar | Phone data              | ~3           |
| NativeStorage                                         | Persistence             | ~1           |
| Testing + integration with SDK v3 `MentraSession`     | End-to-end              | ~5           |
| App store / bundle management UI in MentraOS app      | User-facing             | ~3           |
| **Total**                                             |                         | **~35 days** |

This is parallel to the SDK v3 work. The SDK v3 refactor (~14 days) produces the `MentraSession` + `Transport` interface that the mobile runtime consumes. The mobile work builds the native side that implements that interface.

---

## Alignment with Head of Client

**Critical:** The head of client is reportedly building something on the mobile side for local apps. If they design their own session management with different method names, different event patterns, different manager structure — we end up with two SDKs that do the same thing differently.

**The contract is `MentraSession` + `Transport`.**

- The SDK team (this spike) defines `MentraSession`, the managers, the message types, and the `Transport` interface.
- The mobile team implements `NativeBridgeTransport` and the native modules that fulfill the JSI bindings.
- Both teams use the same message protocol. A `DataStream` with transcription data looks identical whether it came from cloud Soniox or on-device Whisper. A `DisplayRequest` is the same over WebSocket or JSI bridge.

**Action item:** Share this spike + the SDK v3 spike with the head of client. Align on `MentraSession` as the shared contract before either team builds further.

---

## Open Questions

| #   | Question                                      | Notes                                                                                                                                                                                                         |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Hermes context isolation**                  | Can we run multiple mini app bundles in a single Hermes instance (separate realms), or do we need one Hermes instance per app? Separate instances are safer but heavier.                                      |
| 2   | **JSI bindings for `fetch`**                  | Does Hermes in a standalone context (not RN) have `fetch` built in? Or do we need to polyfill it via JSI? Need to test.                                                                                       |
| 3   | **Hermes bytecode versioning**                | Hermes bytecode format changes between versions. If we precompile on the server, we need to match the Hermes version on the phone. How do we handle version mismatches? Fallback to raw JS?                   |
| 4   | **App sandboxing**                            | How strict is the sandbox? Can a mini app `import` anything, or only what the runtime provides? Should we whitelist specific modules?                                                                         |
| 5   | **Memory limits**                             | What's the memory budget per mini app? Hermes contexts are lightweight but transcription models are not. Need to measure.                                                                                     |
| 6   | **Hot reload for development**                | Can we support Metro-like hot reload for local app development? Hermes supports HMR in the RN context — does it work in a standalone context?                                                                 |
| 7   | **Multi-app concurrency**                     | Can multiple mini apps run simultaneously? If so, how do they share the display? Priority system? (Same question as cloud apps — the OS dashboard already handles this.)                                      |
| 8   | **`whisper.rn` production readiness**         | The `whisper.rn` package exists but how production-ready is it? Battery impact? Thermal throttling? Need benchmarks on target devices.                                                                        |
| 9   | **iOS App Store review**                      | Will Apple approve an app that downloads and executes arbitrary JS bundles? This is what React Native already does (CodePush, OTA updates). But it's worth verifying our specific use case won't get flagged. |
| 10  | **Shared vs. dedicated Bluetooth connection** | The main MentraOS app already has a BLE connection to the glasses. Does the mini app runtime share this connection, or does it open its own? Sharing is more efficient; dedicated is more isolated.           |
