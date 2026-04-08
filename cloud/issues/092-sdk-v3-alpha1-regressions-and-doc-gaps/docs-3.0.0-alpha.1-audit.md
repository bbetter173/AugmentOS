# Docs 3.0.0-alpha.1 Audit: Decisions and Findings

## Overview

**What this doc covers:** Every issue, decision, and correction found while reviewing the v3 SDK documentation. This is the living record of what we found and what we decided, so nothing gets lost between chat sessions.
**Why this doc exists:** We audited every docs page against the actual SDK source code and found problems ranging from wrong method names to missing pages to confusing config options. This doc tracks each finding and the decision made.
**Who should read this:** Anyone working on the v3 docs or SDK API surface.

## Config Option Decisions

### `cookieSecret` -- remove from docs

The `MiniAppServer` constructor automatically applies `createAuthMiddleware` using the `apiKey` as the cookie signing secret. Developers do not need to call `createAuthMiddleware` themselves or configure `cookieSecret`. This was confirmed in issue 082.

**Decision:** Remove `cookieSecret` from all docs. Remove any examples showing manual `createAuthMiddleware` setup. Auth is automatic.

### `verbose` -- deprecate in favor of `logLevel`

The SDK currently exposes both `verbose: boolean` and `logLevel: string` in the MiniAppServer config. They overlap: `verbose: true` shows SDK internals, `logLevel: "debug"` also shows SDK internals and implies verbose.

**Decision:**
- Keep `logLevel` as the single config option. Values: `"error"`, `"warn"`, `"info"`, `"debug"`.
- Default to `"warn"` (errors and warnings only, clean terminal).
- `"info"` shows developer's own `session.logger.info()` calls.
- `"debug"` shows everything including SDK internals.
- Deprecate `verbose` internally (keep it working, map to `logLevel: "debug"`). Remove from docs.
- `MENTRA_LOG_LEVEL` env var stays as an override. Config takes priority over env var.

### `createAuthMiddleware` -- remove from v3 docs

Developers should NOT be told to call `createAuthMiddleware` manually. It is built into `MiniAppServer`. The webview-authentication page should only show `getMentraAuth(c)` for reading the authenticated user in route handlers.

### `subscribeToGestures` -- deprecate, add array overload to `onTouchEvent`

The current API has three ways to handle touch/gesture events:

1. `onTouchEvent(handler)` -- all gestures, one call. Good.
2. `onTouchEvent("double_tap", handler)` -- one gesture, one call. Good.
3. `subscribeToGestures(["a", "b"])` -- multiple gestures, no handler. Bad.

Option 3 breaks the pattern. It subscribes without a handler. The developer must make a separate `onTouchEvent` call to actually receive events. Two calls to do one thing.

**Decision:**
- Deprecate `subscribeToGestures(gestures[])`
- Add array overload to `onTouchEvent`: `onTouchEvent(gestures: string[], handler)` so this works:
  ```typescript
  session.device.onTouchEvent(["single_tap", "double_tap"], (e) => {
    console.log(e.gesture);
  });
  ```
- Docs only show the `onTouchEvent` pattern. Never show `subscribeToGestures`.

The principle: if you are subscribing to events, the subscription and the handler are always in the same call. You never "subscribe" without a handler. `configure()` on transcription/translation is different because it sets processing config, not event subscriptions.

### CORS section -- remove entirely

The `react-webviews.mdx` page has an entire CORS section showing Express-style `import cors from "cors"` and `app.use(cors({...}))`. This is wrong for v3:

1. The webview is served from the same Bun process as the API (same origin). No CORS needed.
2. Even if CORS were needed, Hono has built-in CORS middleware. The Express `cors` package is irrelevant.

**Decision:** Remove the entire CORS section from `react-webviews.mdx`. If a note about CORS is needed, one sentence: "CORS is not needed because the webview and API are served from the same URL. If you do need cross-origin support, use Hono's built-in `cors()` middleware."

### `npm install` / `yarn add` -- replace with `bun add` everywhere

Every instance of `npm install` and `yarn add` in the v3 docs should be `bun add`. Bun is required for v3. We use the Bun runtime, Bun fullstack dev server, Bun bundler. Showing npm/yarn is misleading.

**Decision:** Global find-and-replace across all v3 doc pages:
- `npm install` -> `bun add`
- `yarn add` -> remove
- No more "or" alternatives. Just `bun add`.

### Express references -- remove from v3 pages

The `react-webviews.mdx` prerequisites mention "different domain that allows CORS requests from your frontend." This is the Express-era mental model where frontend and backend are separate servers. In v3, they are the same server.

**Decision:** Remove all Express-era assumptions from v3 pages. The v3 architecture is: one Bun process, one URL, serves both the webview (via Bun fullstack HTML routes) and the API (via Hono fetch fallback). The only place Express should appear is in "Migrating from v2" sections.

## Sidebar Structure Decisions

### App Lifecycle Overview -- moved to Getting Started

This is a conceptual "what is a mini app" page, not an API reference. It belongs in the Getting Started section where new developers land first.

### Webviews -- moved after MiniAppServer

Webviews are part of the server architecture story. The developer needs to understand: "I run a Bun server, it serves my webview AND connects to the cloud." Webviews right after MiniAppServer tells that story.

### Device -- placed right after MentraSession

The device is the physical glasses in front of them. After learning "you get a session," the next thing to learn is "here is the hardware you are talking to." Device before any specific feature (display, transcription, etc.).

### Hardware & Capabilities -- folded into Device

These are subsets of `session.device` (`device.capabilities`, `device.state`). They are not separate concepts. The 4 old `hw/` pages are consolidated into `device/hardware-capabilities.mdx`.

### Simple Storage (v2) -- moved to v2 Legacy

It was listed under the v3 section. It is a v2 API. It belongs in v2 Legacy.

### Naming -- match managers, not hardware

- "Speech to Text" becomes "Transcription" (it is `session.transcription`)
- "Audio Chunks" stays as "Microphone" (it is `session.mic`)
- "Speakers" becomes "Speaker" (singular, it is `session.speaker`)
- Every sidebar entry maps 1:1 to a `MentraSession` property

### Icons -- every entry gets one

No more visual imbalance. Device gets a glasses icon. Every manager entry has an icon. See docs-plan.md for the full icon list.

## Page-Level Findings

### Missing pages (created)

| Manager | File | Status |
|---------|------|--------|
| DeviceManager | `device/overview.mdx` | Created |
| Hardware Capabilities | `device/hardware-capabilities.mdx` | Created |
| PhoneManager | `phone.mdx` | Created |
| TimeUtils | `time.mdx` | Created |
| Bun Fullstack Dev Server | TBD | Not yet created |

### Pages with wrong API patterns (need rewrite)

| Page | Problem | Status |
|------|---------|--------|
| `display/dashboard.mdx` | v2 `content.writeToMain()` throughout | Not started |
| `camera/README.mdx` | All v2 method names (`requestPhoto`, `startLivestream`) | Not started |
| `camera/photo-capture.mdx` | v2 `requestPhoto()` instead of v3 `takePhoto()` | Not started |
| `led/overview.mdx` | Documents 4 non-existent methods (`blink`, `solid`, `turnOn`, `turnOff`) | Not started |
| `speakers/*.mdx` | Two pages need merging into one, missing `stop()` | Not started |

### Pages needing targeted fixes

| Page | Fix needed | Status |
|------|-----------|--------|
| `app-lifecycle-overview.mdx` | Links point to v2 pages | Not started |
| `app-server.mdx` | Remove `cookieSecret`, add `logLevel`, remove manual auth middleware examples | Not started |
| `microphone/audio-chunks.mdx` | Add `stop()`, `hasPermission` | Not started |
| `camera/streaming.mdx` | Add `checkExistingStream()` | Not started |
| `permissions.mdx` | Fix LOCATION/CAMERA examples to v3, fix CALENDAR syntax error | Not started |
| `storage.mdx` | Add `clear()`, `keys()`, `has()`, `setMultiple()`, `flush()` | Not started |
| `location.mdx` | Add `stop()` | Not started |
| `webview-authentication.mdx` | Remove manual `createAuthMiddleware` setup, show auto auth | Not started |
| 4 hw/ pages | Remove from sidebar (content folded into Device) | Done (sidebar updated) |
| Simple Storage | Moved to v2 Legacy | Done (sidebar updated) |

## Documentation Tone Rules

- No em-dashes. Use commas, periods, or "or" instead.
- Bun is required. No npm. No Node. Developers use Bun.
- Link to Hono docs for HTTP routing. Do not re-explain Hono.
- Link to Bun fullstack docs for the dev server. Explain why we use it.
- Every code example uses v3 callback pattern: `app.onSession((session) => {...})`
- No class inheritance patterns anywhere in v3 docs.
- No `AppSession` type. Only `MentraSession`.
- Import pattern: `import { MiniAppServer, type MentraSession } from "@mentra/sdk"`
- Every manager page follows: what it is, quick example, full API, common patterns.

## API Surface Decisions

### Phone battery -- remove

`session.phone.battery` and `session.phone.onBatteryUpdate()` are typed but no client ever sends the data. Not a regression (never worked). Remove from the API surface entirely. Do not document.

### Dashboard mode events -- intentional removal

`onDashboardModeChange` was never fully built. Not a regression. Do not restore.

### App-to-app communication -- intentional removal

The entire subsystem (`discoverAppUsers`, `broadcastToAppUsers`, `sendDirectMessage`, rooms) never worked and was never used. Intentionally removed. Not coming back.

### Custom photo webhook URL -- intentional removal for now

`customWebhookUrl` and `authToken` on photo options removed from v3. May revisit later if there is developer demand.

### Camera FOV/ROI -- separate issue, redesign later

The v2 `setFov()` implementation was rushed. Do not copy it to v3. Track as a separate issue and design a proper API. See issue 092 spike.

### LED blink -- accidental regression, restore

`blink()` / multi-cycle patterns dropped from v3. The wire protocol supports `offtime` and `count`. Restore this capability.

### Permission error/denied events -- accidental regression, restore

`onPermissionError` and `onPermissionDenied` dropped from v3. The cloud still sends these messages. Restore on `PermissionsManager`.

### PCM16 encoding -- bug, fix

The v3 `AudioOutputStreamImpl.write()` passes raw PCM through without encoding to MP3. The v2 version encoded via lamejs. The type signature promises PCM support but the implementation does not deliver. Fix before developers use audio streaming with Gemini/OpenAI.

## Stale Docs Findings

These are specific issues found while manually reviewing the published docs:

### `react-webviews.mdx`
- Entire CORS section is Express-era, wrong for v3 (remove)
- `npm install @mentra/react` should be `bun add @mentra/react`
- `yarn add @mentra/react` should be removed
- Prerequisites mention "different domain that allows CORS requests" (not applicable in v3)
- Description meta tag mentions "CORS configuration" (remove)

### `bridge-api.mdx`
- `npm install @mentra/react` should be `bun add @mentra/react`

### `webview-authentication.mdx`
- Shows manual `createAuthMiddleware` setup (automatic in v3, remove)
- Express migration section is fine (intentionally showing v2 for comparison)

### `app-server.mdx`
- Still lists `cookieSecret` as a config option (remove)
- Missing `logLevel` config option
- May still show manual auth middleware examples

### General (all v3 pages)
- Every `npm install` should be `bun add`
- Every `yarn add` should be removed
- No Express patterns outside of "Migrating from v2" sections

## Related Issues

| Issue | Relationship |
|-------|-------------|
| 082 | Auth middleware is automatic (confirmed, drives cookieSecret removal) |
| 092 | Parent issue for all regressions and doc gaps |
| 093 | `mentra docs` CLI command for LLM doc access |