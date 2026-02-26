# Cloud v3 — Maintainability

> **Status**: Draft
> **Date**: 2025-07-17
> **Related**: [overview.md](./overview.md) · [039-sdk-v3-api-surface](../039-sdk-v3-api-surface/v2-v3-api-map.md)

## What is this doc?

This doc catalogs maintainability issues in the MentraOS cloud codebase — dead code, duplicated code, god objects, naming confusion, and technical debt that make the codebase harder to work in than it needs to be.

## Why it matters

The cloud codebase has grown organically. Express and Hono route files are fully duplicated (38 files doing the same thing). Azure transcription code is dead but still wired in. Core services are 1000+ line god objects with TODO comments about splitting them. Auth middleware is misnamed and mixes concerns. Every change carries the risk of touching something that looks alive but isn't, or missing a second copy of something that exists in two places.

This slows down every engineer on every task. Cleaning this up is prerequisite work for shipping SDK v3 and for making the other improvements (reliability, observability, testing) practical.

## System context

See [overview.md](./overview.md) for full system architecture. This doc focuses on the **cloud** component — the Bun/Hono server that sits between mobile clients and mini apps.

---

## Issues

### 1. Express is dead — mass delete

The cloud is mid-migration from Express to Hono. **Every single route file is duplicated:**

- `src/routes/*.ts` — 19 Express route files
- `src/api/hono/routes/*.ts` — 19 Hono route files (same names, same logic)
- `src/api/console/*.ts` — Express console APIs
- `src/api/hono/console/*.ts` — Hono console APIs (duplicated again)

**Decision: Mass delete all Express code.** The Hono routes are already written and working. Express was only kept as a reference in case of Hono bugs, but it's been stable. Delete `src/routes/`, the Express console APIs, Express middleware, Express dependency from `package.json`, and any Express-specific imports/types.

### 2. Azure transcription provider is dead code

Soniox is the only transcription provider in active use. Azure is still fully wired in:

- `AzureTranscriptionProvider.ts` — ~680 lines, full implementation
- `ProviderSelector.ts` — 273 lines of provider selection logic between Azure and Soniox
- `TranscriptionManager.ts` — Azure initialization, Azure fallback logic, Soniox→Azure failover paths
- `microsoft-cognitiveservices-speech-sdk` — dependency in package.json
- Env vars: `AZURE_SPEECH_REGION`, `AZURE_SPEECH_KEY` still referenced

This isn't deprecated — it's dead. Soniox handles all transcription. Azure should be removed entirely, not kept as a fallback. Removing Azure + simplifying ProviderSelector will cut ~1000 lines and significantly simplify TranscriptionManager (currently 2,201 lines).

### 3. Alibaba transcription provider — China-only, stays

- `AlibabaTranscriptionProvider.ts` — ~617 lines
- Only initialized when `IS_CHINA` flag is set
- Uses its own WebSocket connection to Alibaba's API
- Has a `TODO: Do i need to close the websocket here?????` in the message handler

**Decision: Keep.** China cloud deployment is WIP, separate engineer is responsible. Provider stays, but the TODO and code quality issues should be cleaned up.

### 4. `app.service.ts` is a god object (1,122 lines)

Single file handles: app CRUD, app store operations, developer operations, tool calls, settings push, API key management, app publishing, organization lookups. Has **8+ `TODO(isaiah)` comments** about splitting it:

- `TODO(isaiah): Move this to the new AppManager within new UserSession class.`
- `TODO(isaiah): Move this logic to a new developer service to declutter the app service.` (×5)
- `TODO(isaiah): Consider splitting this into multiple services (appstore.service, developer.service, tools.service)`

This needs to be split into at least: `app-store.service.ts`, `developer.service.ts`, `tools.service.ts`.

### 5. Dashboard mini app needs to die — cloud takes over

Already decided in [039 D31](../039-sdk-v3-api-surface/v2-v3-api-map.md#16-dashboard). The cloud work required:

- **Kill the Dashboard mini app** and **rewrite `DashboardManager`** (~894 lines) — kill the 4-quadrant `SystemContent` model (`topLeft`, `topRight`, `bottomLeft`, `bottomRight`). Replace with system header + full-width body layout. Compose as TextWall using display-utils, send to `ViewType.DASHBOARD`.
- **Kill `SYSTEM_DASHBOARD_PACKAGE_NAME`** privileged app concept — no more special-case routing for the dashboard app.
- **Move existing code from Dashboard mini app into cloud** — weather (OpenWeatherMap), notification summarization (LLM agent), calendar formatting, etc. All this logic already exists in the mini app, just needs to be relocated into the DashboardManager rewrite.

### 6. SDK route paths hardcoded in multiple places

Cloud hardcodes SDK endpoint paths (`/webhook`, `/tool`, `/health`, `/settings`, `/photo-upload`, `/mentra-auth`) in:

- `AppManager.ts` — webhook calls
- `app.service.ts` — tool calls, stop webhook
- `PhotoManager.ts` — photo upload
- `app-settings.routes.ts` — settings push
- `system-app.api.ts` — tool invocation

For SDK v3 these move to `/api/_mentraos/*`. **Decision: mount both old and new paths during transition**, then drop old paths when v2 SDK apps are sunset.

### 7. Auth middleware is confused

- `validateSupabaseToken` in `developer.routes.ts` is named wrong — it actually validates a MentraOS JWT (`coreToken`), not a Supabase token. Has a TODO acknowledging this.
- `unifiedAuthMiddleware` in `apps.routes.ts` mixes client auth, system app auth, and third-party app auth into one middleware. TODO says it should be split.
- `currentOrgId` comes from a request header and is blindly trusted without validation. TODO says it should be validated or moved to a query param.

### 8. Settings system — needs deprecation cleanup

Settings is being deprecated in favor of Storage (039 D29). Cloud-side cleanup:

- `app-settings.routes.ts` — settings push endpoint (exists in both Express and Hono)
- Settings schema management in app service
- Settings-related event broadcasting to connected apps
- MentraOS system settings (`metricSystemEnabled`, `brightness`, etc.) — these are OS-level and need a new home (probably `UserSession` or `DeviceState`)

### 9. Multi-user app communication is deprecated — remove entirely

`app-communication.routes.ts` has the entire `discoverUsers` implementation commented out. The feature is dead and deprecated.

**Decision: Remove entirely.** Delete `app-communication.routes.ts` (both Express and Hono versions), remove all app-to-app APIs from the SDK (see 039 §20 — `discoverAppUsers`, `broadcastToAppUsers`, `sendDirectMessage`, `joinAppRoom`, `leaveAppRoom`, `onAppMessage`, `onAppUserJoined`, `onAppUserLeft`, `onAppRoomUpdated` — all removed).

### 10. `developer.routes.ts` — 1000+ lines, uses `console.log`

- Over 1000 lines in a single route file
- Has a TODO at the top: `TODO(isaiah): refactor this code to use this logger instead of console.log, console.error, etc.`
- Handles developer CRUD, app management, organization management, image uploads (via multer) — all in one file
- Should be split alongside the `app.service.ts` god object cleanup

### 11. `DoubleTextWall` column composition bug

The `ColumnComposer` in `@mentra/display-utils` has a known bug where characters can overflow from the right quadrant to the left side of the screen (off by ~1 character in pixel alignment). This is the bug that partly motivated moving the dashboard away from `DoubleTextWall`. Still needs to be fixed since mini apps may use `showDoubleText()`.

### 12. Dead/stale code scattered throughout

- `REGION` env var falls back to `AZURE_SPEECH_REGION` in the logger — Azure remnant
- `import { systemApps } from './system-apps'` commented out in `app.service.ts`
- Export data endpoint returns empty arrays with TODOs: `apps: [], // TODO: Add installed apps`
- `audio.routes.ts` has a TODO about improving the audio manager for last-10-seconds retrieval
- `transcripts.routes.ts` has a TODO about `startTime/endTime` filter handling
- Various `onMentraosSettingsChange` / `onMentraosSettingChange` duplicate methods in the SDK that need to be removed
- `DisplayManager6.1.ts` — has a version number in the filename

### 13. No consistent error handling pattern

Hono routes use `try/catch` with `c.json({error}, X)` in ad-hoc patterns. No centralized error handler, no standard error response shape, no error codes. Each route file reinvents error handling.

### 14. WebSocket → REST migration leftovers

The cloud previously used WebSocket for some SDK communication paths that have since moved to REST. There may be dead WebSocket handling code paths that no longer receive traffic. Needs an audit to identify and remove.

---

## Largest files in services/ (for context)

| File                              | Lines | Notes                                           |
| --------------------------------- | ----- | ----------------------------------------------- |
| `TranscriptionManager.ts`         | 2,201 | Biggest. Azure init/fallback logic inflates it  |
| `AppManager.ts`                   | 1,819 | App lifecycle, webhooks, connections            |
| `ManagedStreamingExtension.ts`    | 1,434 | Cloudflare stream management                    |
| `TranslationManager.ts`           | 1,359 | Translation streams                             |
| `app.service.ts`                  | 1,122 | God object (§4)                                 |
| `SonioxTranscriptionProvider.ts`  | 1,091 | Main transcription provider                     |
| `DisplayManager6.1.ts`            | 1,082 | Display management — version number in filename |
| `SonioxTranslationProvider.ts`    | 1,040 |                                                 |
| `CloudflareStreamService.ts`      | 997   |                                                 |
| `AppSession.ts`                   | 908   | Per-app session on cloud side                   |
| `organization.service.ts`         | 899   |                                                 |
| `DashboardManager.ts`             | 894   | Being rewritten (§5)                            |
| `AzureTranscriptionProvider.ts`   | 680   | Dead code (§2)                                  |
| `AlibabaTranscriptionProvider.ts` | 617   | China-only, stays (§3)                          |

---

## Prioritization

### Must-do for v3.0

| #   | Issue                                             | Why                                                                   |
| --- | ------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Mass delete Express code                          | Hono routes already working, can't maintain two sets of routes        |
| 2   | Kill Azure provider                               | Dead code, dependency weight, inflates TranscriptionManager           |
| 5   | Dashboard → OS service (rewrite DashboardManager) | Required for new dashboard API                                        |
| 6   | SDK route paths — mount both old + new            | SDK v3 needs `/api/_mentraos/*`, v2 needs old paths during transition |
| 9   | Remove multi-user app communication               | Deprecated, backend already broken, SDK removing all app-to-app APIs  |

### Should-do for v3.0

| #   | Issue                        | Why                                    |
| --- | ---------------------------- | -------------------------------------- |
| 8   | Settings deprecation cleanup | SDK v3 deprecates settings             |
| 12  | Dead/stale code sweep        | General hygiene                        |
| 7   | Auth middleware cleanup      | Security concern, naming confusion     |
| 11  | DoubleTextWall pixel bug     | Mini apps still use `showDoubleText()` |

### Can defer past v3.0

| #   | Issue                          | Why                            |
| --- | ------------------------------ | ------------------------------ |
| 4   | Split `app.service.ts`         | Big refactor, doesn't block v3 |
| 10  | Split `developer.routes.ts`    | Same                           |
| 13  | Error handling standardization | Nice to have, large scope      |
| 14  | WebSocket dead path audit      | Needs investigation first      |

---

## Open Questions

| #   | Question                                | Notes                                                                                                            |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Q1  | Where do MentraOS system settings live? | `metricSystemEnabled`, `brightness` — move to `UserSession`? `DeviceState`?                                      |
| Q2  | When to drop old SDK paths?             | Both old (`/webhook`) and new (`/api/_mentraos/webhook`) mounted during transition. When do we remove old paths? |
