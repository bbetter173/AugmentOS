# Dev Applets as Installed Apps — Implementation Plan

Implementation plan for [`miniapp-dev-applets-as-installed-apps-spec.md`](./miniapp-dev-applets-as-installed-apps-spec.md). The spec is fully decided; this doc is the *how*.

The headline goal: a QR-scanned dev miniapp behaves exactly like an installed app. Persisted across app restarts, kept on the home screen and switcher, backgrounded JS keeps running on close, and a cached bundle is served as a graceful fallback when the laptop dev server is unreachable.

This is the largest single piece of remaining work in the miniapp-improvements queue. Worth landing in 5 separate PRs because the surfaces are nearly independent.

---

## Architecture overview

```
┌─────────────────── DEVELOPER LAPTOP ───────────────────┐
│  mentra-miniapp dev (CLI)                              │
│   ├── user's server.ts          (port 3000, miniapp)   │
│   └── sidecar dev-server.ts     (port 3001)            │
│         ├── /__mentra_dev (WebSocket — live reload)    │
│         ├── /__mentra_dev/health                       │
│         └── /__mentra_dev/files  ← NEW: file manifest  │
└────────────────────────┬───────────────────────────────┘
                         │ HTTP/WS over LAN
┌────────────────────────┴───────────────────────────────┐
│                       PHONE                             │
│                                                         │
│  Scanner / URL-load route                              │
│   └─> registerDevApplet() — persisted to MMKV          │
│       └─> bundle download (in background)              │
│                                                         │
│  Home tray + AppSwitcher                               │
│   └─> render with orange-dot indicator                 │
│       └─> tap launches /applet/local                   │
│                                                         │
│  /applet/local route                                   │
│   ├─ freshness check (HEAD on devUrl/miniapp.json)     │
│   ├─ reachable: mountDev(devUrl) — live reload         │
│   ├─ unreachable + cache exists: mount(file://cache)   │
│   └─ unreachable + no cache: full-screen offline       │
│                                                         │
│  App boot                                              │
│   └─> loadPersistedDevApplets() restores tiles         │
│                                                         │
│  Long-press tile → Remove                              │
│   └─> drop persisted entry + delete cache dirs         │
└────────────────────────────────────────────────────────┘
```

---

## File map

```
mobile/src/
├── services/
│   ├── Composer.ts                  EXISTING — small filter for dev-* dirs
│   ├── DevAppletPersistence.ts      NEW — MMKV-backed persisted-applet store
│   ├── DevAppletBundleCache.ts      NEW — download bundle from manifest endpoint
│   └── DevServerBridge.ts           (no changes)
├── stores/
│   └── applets.ts                   EXISTING — extend register/unregister, add load
├── components/
│   ├── home/AppSwitcher.tsx         EXISTING — orange-dot rendering
│   └── miniapps/
│       ├── CapsuleMenu.tsx          EXISTING — pass-through dev flag
│       └── DevAppletBadge.tsx       NEW — orange-dot indicator (shared)
├── app/
│   ├── miniapps/settings/
│   │   ├── miniapp-developer-scanner.tsx   EXISTING — call registerDevApplet w/ persist
│   │   └── miniapp-developer-url.tsx       EXISTING — same
│   └── applet/
│       ├── local.tsx                EXISTING — freshness check, fallback to cache
│       └── dev-offline.tsx          NEW — full-screen offline screen
└── i18n/en.ts                       EXISTING — new copy strings

sdk/miniapp-cli/src/
└── dev-server.ts                    EXISTING — add /__mentra_dev/files endpoint
```

12 files touched, 4 new.

---

## Decomposition (5 PRs)

### PR 1 — Persistence layer (1-2 days)

**Goal:** dev applets survive app restarts.

`DevAppletPersistence.ts` — singleton service over `mobile/src/utils/storage`:

```ts
interface PersistedDevApplet {
  packageName: string
  name: string
  devUrl: string
  iconUrl?: string
  hardwareRequirements: HardwareRequirement[]
  registeredAt: number
  lastReachableAt?: number
  cachedBundleVersion?: string  // marker into Composer.getBundleDir; null if no cache yet
}

class DevAppletPersistence {
  list(): PersistedDevApplet[]
  get(packageName: string): PersistedDevApplet | null
  save(entry: PersistedDevApplet): void          // upsert
  remove(packageName: string): void
  setLastReachable(packageName: string, ts: number): void
  setCachedBundleVersion(packageName: string, version: string | null): void
}
```

Storage key: `miniapp_dev_persisted` (single array). On load, also migrate the existing `miniapp_dev_recent` MMKV key from `miniapp-developer-url.tsx` — read-old, write-new, delete-old.

**`stores/applets.ts` changes:**

- Extend `registerDevApplet(...)` to call `devAppletPersistence.save(...)` after the in-memory `set(...)`.
- Add `loadPersistedDevApplets()` action — called from app boot:
  - Iterate the persisted entries.
  - For each, push a `ClientAppletInterface` with `running: false`, `isMiniappDev: true`, `compatibility: ...`.
  - Tile is visible but not running until the user taps it.
- Extend `unregisterDevApplet(...)` to call `devAppletPersistence.remove(...)`.

**App-boot wire-up:**

Add `useAppletStatusStore.getState().loadPersistedDevApplets()` to wherever the app boots applets — likely `MantleManager.init()` or sibling. Confirm during work.

**Migration:**

`miniapp-developer-url.tsx` currently has its own `RECENT_KEY` MMKV storage. Drop that path — the persistence service is the single source of truth. The Recent list on the URL screen reads from `devAppletPersistence.list()` filtered to most-recent.

**Acceptance:**
- Scan QR → kill MentraOS app → reopen → tile is on home screen.
- `useAppletStatusStore.getState().apps` after boot includes the dev applet (with `running: false`).
- Old `miniapp_dev_recent` data appears in the new persisted list on first read.

---

### PR 2 — Lifecycle fix (0.5 day)

**Goal:** dev applets stay backgrounded on close like normal apps.

Single change in `mobile/src/app/applet/local.tsx`:

Today's `handleClose`:

```ts
const handleClose = () => {
  miniappHost.unmount(packageName)
  if (devUrl) {
    useAppletStatusStore.getState().unregisterDevApplet(packageName)  // ← drop this
  }
  goBackRef.current()
}
```

becomes:

```ts
const handleClose = () => {
  miniappHost.setBackground(packageName)   // not unmount
  goBackRef.current()
}
```

Now closing a dev miniapp behaves identically to backgrounding any other miniapp: WebView lives in the 1×1 off-screen holder, JS continues, switcher tile stays visible. Removal happens only via long-press (PR 5).

`miniappHost.unmount(...)` is still called from elsewhere (terminate / error / explicit removal). No other lifecycle changes.

**Acceptance:**
- Tap minus button on dev miniapp → returns to home, tile still in switcher, JS still running.
- Re-open from home tile → foregrounds the existing WebView (no remount).

---

### PR 3 — Bundle caching (5-7 days, the big one)

**Goal:** dev miniapp keeps working when the laptop dev server is unreachable.

#### Sidecar endpoint — `sdk/miniapp-cli/src/dev-server.ts`

Add `GET /__mentra_dev/files` returning:

```json
{
  "files": [
    "/index.html",
    "/main.js",
    "/styles.css",
    "/miniapp.json",
    "/icon.png",
    "/fonts/inter.woff2"
  ]
}
```

Generate by walking the project root. Exclude:
- `node_modules/`, `dist/` (unless served), `.git/`, `.env*`
- The `__mentra_dev` paths themselves (don't include the sidecar in the cache).

Walk strategy: BFS from project root, breadth limit ~5 levels, file count limit ~500. Beyond that we warn and truncate — the developer's project is doing something unusual.

#### Phone-side bundle cache — `mobile/src/services/DevAppletBundleCache.ts` (new)

```ts
class DevAppletBundleCache {
  /**
   * Download the file manifest from the dev server, fetch each file,
   * write to Paths.document/lmas/<packageName>/dev-<timestamp>/<path>.
   * Returns the bundle version directory name on success.
   *
   * Idempotent: if a snapshot is already in flight for the same package,
   * returns the same promise.
   */
  async download(packageName: string, devUrl: string, devPort: number): Promise<{version: string} | null>

  /** Returns the path to the latest cached bundle, or null. */
  getLatestBundlePath(packageName: string): string | null

  /** Delete all `dev-*` directories for this package. */
  clear(packageName: string): void

  /** Garbage-collect older `dev-*` dirs, keeping the latest two. */
  gc(packageName: string): void
}
```

Implementation notes:

- Bundle directory: `Paths.document.uri/lmas/<packageName>/dev-<timestamp>/`. Reuses Composer's on-disk layout but with a prefix that distinguishes dev caches.
- File fetch: `fetch(devUrl + relPath)`, write to disk via `expo-file-system`. Preserve relative paths (subdirectories).
- Concurrency: 4 parallel fetches.
- Sequencing: write each file as it arrives; mark the snapshot complete only after the last write succeeds.
- On failure midway: leave the partial directory but don't update `cachedBundleVersion`. Next attempt creates a fresh `dev-<timestamp>` and the partial one gets gc'd.

GC runs on every successful download — keeps the latest two `dev-*` dirs (current + previous fallback). Oldest dropped.

#### Composer integration

Composer's `getInstalledAppletsInfo` and `getAppletInstalledVersions` scan `lmas/<packageName>/` for version subdirectories. Add a filter to skip `dev-*` entries — those are surfaced through the persisted-applet path, not as installed local applets:

```ts
.filter((name) => !name.startsWith("dev-"))
```

Apply in both `getAppletInstalledVersions` (line ~386) and the active-version lookup chain so dev-* never appears as an "active version" for an installed-applet entry.

#### Mount strategy in `local.tsx`

```ts
;(async () => {
  if (!devUrl) {
    // ...existing version-based path stays unchanged
    return
  }

  // 1. Freshness check (max 500ms)
  const reachable = await checkDevServerReachable(devUrl, 500)

  if (reachable) {
    // 2a. Live mount, kick off background refresh of the cache
    const manifest = await miniappHost.mountDev(packageName, devUrl, {...})
    if (devPort) {
      devServerBridge.connect(packageName, devUrl, +devPort)
      void devAppletBundleCache.download(packageName, devUrl, +devPort).then((v) => {
        if (v) devAppletPersistence.setCachedBundleVersion(packageName, v.version)
      })
    }
    devAppletPersistence.setLastReachable(packageName, Date.now())
    useAppletStatusStore.getState().registerDevApplet({...})
    return
  }

  // 2b. Try cache fallback
  const cachedPath = devAppletBundleCache.getLatestBundlePath(packageName)
  if (cachedPath) {
    miniappHost.mount(packageName, `file://${cachedPath}/index.html`, {...})
    showToast("Dev server offline — running cached version (cached N days ago)")
    useAppletStatusStore.getState().registerDevApplet({...})
    return
  }

  // 2c. No cache — show offline screen
  push("/applet/dev-offline", {packageName, name: appName, iconUrl})
})()
```

`checkDevServerReachable(url, timeoutMs)` does `HEAD <devUrl>/miniapp.json` with an `AbortController` for the timeout. Returns boolean.

`showToast` is whatever the codebase uses (likely `react-native-toast-message` or an existing helper — confirm during work).

#### Offline screen — `mobile/src/app/applet/dev-offline.tsx` (new)

Receives `packageName, name, iconUrl` via search params. Renders:

```
┌────────────────────────────────────┐
│        [icon]                      │
│        Live Captions               │
│                                    │
│        Dev server offline          │
│        Last reached: 2 days ago    │
│                                    │
│   [Try again]  [Re-scan QR]        │
└────────────────────────────────────┘
```

"Try again" re-runs the freshness check; on success, replaces with `/applet/local`. "Re-scan QR" pushes to the scanner.

#### Acceptance

- First load with reachable dev server: WebView hits live URL, cache downloads in background, `cachedBundleVersion` updated.
- Kill dev server, kill phone app, restart phone app, tap tile: cache fallback mounts. Toast appears.
- Kill dev server, tap tile of *uncached* dev applet: offline screen appears.
- Long-press → Remove (PR 5): cache directories wiped.
- Live reload still works through `__mentra_dev` WebSocket when reachable.

---

### PR 4 — Orange-dot indicator (1 day)

**Goal:** distinguish dev applets visually from store-installed ones.

`components/miniapps/DevAppletBadge.tsx` (new):

```tsx
export function DevAppletBadge({size = 8}: {size?: number}) {
  return (
    <View
      style={{
        position: "absolute",
        top: -2,
        right: -2,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: "#F97316",  // orange-500
        borderWidth: 1,
        borderColor: "#fff",         // confirm against theme background
      }}
    />
  )
}
```

Render call sites — wrap each existing app-icon component with a relative-positioned container plus the badge when `applet.isMiniappDev`:

- `components/home/AppSwitcher.tsx` — switcher cards.
- Home tray icon component (find via search).
- `components/miniapps/CapsuleMenu.tsx` — more-actions sheet thumbnail.

The badge rides on the same render path everywhere; the spec calls this out as "hook into the shared app-icon component." Quick search to find where icons render and DRY into one component if there isn't one.

**Acceptance:**
- All three render surfaces (home, switcher, capsule menu) show the orange dot for `isMiniappDev` applets.
- Store-installed and offline apps unchanged.
- Dot positioning works on light + dark themes (verify the white border is visible on both).

---

### PR 5 — Removal flow + bug-report skip (1-2 days)

**Goal:** developers can remove dev applets they no longer want.

#### Long-press action sheet

Find where the current long-press handler lives (likely `components/home/HomeScreen` or in the AppSwitcher). For dev applets, expose a "Remove" option:

```tsx
// pseudocode
if (applet.isMiniappDev) {
  showActionSheet({
    options: ["Remove", "Cancel"],
    destructiveIndex: 0,
    onSelect: (i) => {
      if (i === 0) {
        useAppletStatusStore.getState().unregisterDevApplet(applet.packageName)
        devAppletBundleCache.clear(applet.packageName)
      }
    },
  })
}
```

`unregisterDevApplet` already drops the in-memory entry; PR 1 extended it to drop the persisted entry. Now also delete cache dirs.

#### Bug-report path

In `stores/applets.ts` `startApplet` failure path:

```ts
if (result.is_error()) {
  console.error(`Failed to start applet ${applet.packageName}: ${result.error}`)
  // Skip bug-report for dev applets — it's the developer's own code,
  // not actionable in our incident pipeline.
  if (!applet.isMiniappDev) {
    void submitMiniappStartFailedBugReport(applet, result.error, "initial_start")
  }
  ...
}
```

Same guard in `retryStartApp`.

**Acceptance:**
- Long-press a dev tile → action sheet → "Remove" → tile gone from home, switcher, persisted store.
- Cache directories deleted on filesystem (verify with `ls Paths.document/lmas/<pkg>/`).
- Failed start of a dev applet no longer creates an incident in admin/incidents.
- Long-press non-dev applets shows whatever menu they had before — no regression.

---

## Wire-protocol changes

**None.** All work above is at the SDK + phone-side layer; the existing wire protocol is sufficient. The new sidecar `/__mentra_dev/files` endpoint is HTTP-on-the-laptop, not part of the phone-miniapp protocol.

## Test plan

### Unit

- `DevAppletPersistence`: save / load / remove round-trip; migration from `miniapp_dev_recent`.
- `DevAppletBundleCache`: download with mocked fetch, gc keeps latest 2 dirs, clear deletes all dev-* dirs for package.
- `freshness check`: aborts within 500ms when server unreachable.

### Integration (manual on phone)

- Persist + relaunch round trip (PR 1).
- Lifecycle: close → background → reopen (PR 2).
- Cache flow: live → kill server → cached fallback (PR 3).
- Re-scan with same packageName updates entry + new cache snapshot (PR 3).
- Re-scan with different packageName adds a new tile (PR 3).
- Orange dot visible across all three surfaces (PR 4).
- Long-press removal cleans everything (PR 5).
- Live reload still works whenever server is reachable (PR 3 — regression check).

## Open items deferred to during-implementation

These were flagged in the spec but don't need pre-decision:

- **Bundle crawl strategy edge cases:** when a Vite/Next dev server can't enumerate files, the spec calls for falling back to walking the source tree. Implementation detail; resolve when a real Vite project hits the issue.
- **Cache freshness threshold:** confirmed in the spec as always-silent fallback. Toast says "cached N days ago" — `N` calculated as floor((now - lastReachableAt) / 1 day). Display "today" if N === 0.
- **Concurrent dev-server connection from two devices:** out of scope. Each phone has its own cache.
- **Toast helper choice:** find via search of `mobile/src/`; if multiple, use whatever the offline-mode banner uses.

## Sequencing recommendation

1. PR 1 (persistence) → unblocks everything else conceptually. Smallest. Land first.
2. PR 2 (lifecycle fix) → trivial 1-line change. Land alongside PR 1 or right after.
3. PR 3 (bundle caching) → biggest. Most uncertainty. Worth its own PR + testing window.
4. PR 4 (orange dot) → visual, independent. Land any time after PR 1.
5. PR 5 (removal + bug-report skip) → relies on PR 1's unregister extension. Land after.

**Total: 8-12 days of focused work.** Bundle caching dominates.

## Migration / breaking changes

- `miniapp_dev_recent` MMKV key: read-old, write-new, delete-old on first read of `DevAppletPersistence`. After upgrade, old key gone.
- `unregisterDevApplet` semantics changed: was called from `local.tsx` close path; now called only from explicit removal.

No SDK breaking changes. No version bump beyond the persistence migration.
