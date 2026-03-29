# Tech Debt: Database Layer — Findings from MongoDB Audit

Discovered during the 062 MongoDB latency investigation. These are code quality and performance issues that should be addressed regardless of whether MongoDB is the primary crash cause.

---

## TD-1: `.lean()` missing on 82% of read queries

**Severity:** Medium
**Impact:** CPU waste on every non-lean read. Mongoose hydrates full Documents with change tracking, getters/setters, and prototype chain. For read-only operations this is pure overhead — roughly 2x CPU per query vs lean.

**Current state:** 44 of ~250+ read queries use `.lean()` (18%). The 206 remaining instantiate full Mongoose Documents unnecessarily.

**Worst offenders:**

- `User.findOne()` — 0 of 30+ reads use lean
- `Organization.findById()` — 0 of 10+ reads use lean
- `App.findOne({ packageName })` in hot paths — 3 of 8 use lean

**Fix:** Add `.lean()` to every `find/findOne/findById` that doesn't call `.save()` afterwards. Bulk find-and-replace with manual audit of each call site.

**Risk:** Low. Only breaks if code calls `.save()` or Mongoose methods on the returned doc. Audit each site.

---

## TD-2: `User.save()` on hot paths instead of atomic `$set`

**Severity:** High
**Impact:** Full document write on every call. Under concurrency (multiple sessions for the same user, or rapid state changes), this causes Mongoose `VersionError` and can silently drop updates. Also sends the entire user document over the wire instead of just the changed field.

**Call sites:**

- `user.model.ts:L336` — `setLocation` (runs on every location update from phone)
- `user.model.ts:L342` — `addRunningApp` (runs on every app start)
- `user.model.ts:L362` — `removeRunningApp` (runs on every app stop)
- `user.model.ts:L449` — `updateAppSettings` (runs on settings change)
- `location.service.ts:L176` — device location persist

**Fix:** Replace `.save()` with `User.updateOne({ _id }, { $set: { field: value } })` or `$push/$pull` for array operations. Atomic, no version conflicts, sends minimal data.

**Risk:** Low. Atomic updates are safer than `.save()` under concurrency.

---

## TD-3: N+1 query patterns

**Severity:** Medium
**Impact:** Multiple sequential DB round-trips where one batch query would suffice. Each round-trip blocks the event loop for the full RTT.

**Call sites:**

- `admin.routes.ts:L234-291` — fetches submitted apps, then loops calling `Organization.findById()` for each. Should batch with `Organization.find({ _id: { $in: orgIds } })`.
- `organization.service.ts:L769-820` (`deleteOrg`) — loops through members calling individual queries per member.
- `app-enrichment.service.ts` — already uses batch pattern (good example to follow).

**Fix:** Collect IDs first, batch query, then map results. Pattern exists in `app-enrichment.service.ts`.

**Risk:** Low.

---

## TD-4: `App.findOne({ packageName })` duplicated across 20+ files

**Severity:** Medium (maintainability)
**Impact:** No single point of control for app lookups. Can't add caching, logging, or lean() in one place. Every new feature copy-pastes the same query.

**Call sites:** `app.service.ts`, `AppManager.ts`, `SubscriptionManager.ts`, `app-message-handler.ts`, `sdk.auth.service.ts`, `streams.routes.ts`, `onboarding.routes.ts`, `permissions.routes.ts`, `developer.routes.ts`, `admin.routes.ts`, `console.apps.service.ts`, `developer.service.ts`, `store.service.ts`, `public/permissions.api.ts`, `system-app.api.ts`

**Fix:** Create `AppCache` or `AppRepository` service that:

1. Loads all apps at boot (~2MB)
2. Serves `getByPackageName()` from memory
3. Refreshes on a timer or on write
4. All call sites use `appCache.getByPackageName()` instead of `App.findOne()`

**Risk:** Cache staleness — new apps take up to refresh interval to appear. Acceptable for a 1,314-doc, 2MB collection.

---

## TD-5: `AUGMENTOS_AUTH_JWT_SECRET` read independently in 12+ files

**Severity:** Low (maintainability)
**Impact:** Each file does `const SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || ""` independently. No single source of truth. If the env var name changes, 12 files need updating.

**Call sites:** `admin.routes.ts`, `account.routes.ts`, `app-settings.routes.ts`, `apps.routes.ts`, `auth.routes.ts`, `developer.routes.ts`, `error-report.routes.ts`, `gallery.routes.ts`, `hardware.routes.ts`, `organization.routes.ts`, `permissions.routes.ts`, `photos.routes.ts`, `store.auth.api.ts`, `incident-logs.api.ts`, `incident-processor.service.ts`, `bun-websocket.ts`, `websocket.service.ts`, `generateCoreToken.ts`, `invite.service.ts`, `developer.service.ts`, `cli.middleware.ts`, `client.middleware.ts`, `console.middleware.ts`

**Fix:** Create `config/auth.ts` that exports the secret. All files import from there.

**Risk:** None.

---

## TD-6: No connection pooling configuration

**Severity:** Low
**Impact:** Mongoose uses default connection pool settings. With 65 sessions generating concurrent queries, the pool may be undersized, causing queries to queue.

**Current state:** `mongoose.connect(url)` with no pool options.

**Fix:** Add `mongoose.connect(url, { maxPoolSize: 20, minPoolSize: 5, socketTimeoutMS: 30000 })`. Tune based on observed concurrent query patterns.

**Risk:** Low.

---

## TD-7: Direct `.collection()` access bypasses Mongoose

**Severity:** Low
**Impact:** `mongodb.connection.ts:L68` uses `mongoose.connection.db.collection("test").insertOne()` as a health check. This bypasses Mongoose middleware, plugins (including our slow-query plugin), and error handling.

**Fix:** Use a Mongoose model or remove the test insert (the connection itself is the health check).

**Risk:** None.

---

## TD-8: `strict: false` on App schema

**Severity:** Low (data quality)
**Impact:** `app.model.ts` sets `strict: false`, allowing any arbitrary field to be stored on app documents. This is why some docs are 97KB — they may contain unvalidated data blobs.

**Current state:** The largest app doc is 97KB (`com.augmentos.livecaptions`). Average is 1.5KB. The 97KB doc takes 60x longer to transfer over the wire than the average.

**Fix:** Audit what fields are actually stored, add them to the schema, set `strict: true`. May need a migration to clean existing docs.

**Risk:** Medium — could break features that rely on storing arbitrary fields.

---

## Priority Order

| #   | Item                              | Effort | Impact on crashes                                  | Impact on maintainability |
| --- | --------------------------------- | ------ | -------------------------------------------------- | ------------------------- |
| 1   | TD-4: App cache/repository        | Medium | 🔴 High — eliminates all apps RTT on hot paths     | 🔴 High                   |
| 2   | TD-2: Atomic updates on hot paths | Small  | 🟡 Medium — reduces write RTT and concurrency bugs | 🟡 Medium                 |
| 3   | TD-1: Add .lean() everywhere      | Small  | 🟡 Medium — reduces CPU per query                  | 🟡 Medium                 |
| 4   | TD-3: Fix N+1 patterns            | Small  | 🟢 Low — cold paths mostly                         | 🟡 Medium                 |
| 5   | TD-5: Centralize JWT secret       | Small  | 🟢 None                                            | 🟡 Medium                 |
| 6   | TD-6: Connection pool config      | Small  | 🟢 Low                                             | 🟢 Low                    |
| 7   | TD-7: Remove test insert          | Tiny   | 🟢 None                                            | 🟢 Low                    |
| 8   | TD-8: Strict schema               | Medium | 🟢 Low                                             | 🟡 Medium                 |
