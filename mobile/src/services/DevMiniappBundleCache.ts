/**
 * @fileoverview DevMiniappBundleCache — snapshot a dev miniapp's files to disk.
 *
 * When a dev miniapp is mounted from a reachable dev server, this module
 * downloads the project's files (via the dev server's `/__mentra_dev/files`
 * manifest endpoint) and writes them into Composer's standard install layout:
 *
 *   Paths.document/lmas/<packageName>/dev-<timestamp>/<relPath>
 *
 * Composer's filesystem-backed install registry then surfaces the dev miniapp
 * automatically on next boot (or refresh). When the dev server is unreachable,
 * the local route reads `Composer.getLatestDevBundlePath(...)` and mounts via
 * `file://` — graceful degradation.
 *
 * Live mode (dev server reachable) still mounts via `mountDev(devUrl)` for
 * live reload + console bridge. The cache is fallback-only; live URL is
 * always preferred when available.
 */

import {Directory, File, Paths} from "expo-file-system"

const LOG_TAG = "DEV_BUNDLE"
const PARALLELISM = 4
const FETCH_TIMEOUT_MS = 10_000

/** Per-package in-flight snapshot Promises so concurrent calls share work. */
const inFlight = new Map<string, Promise<string | null>>()

/**
 * Snapshot the dev miniapp at `devUrl` into a fresh `dev-<timestamp>` directory.
 * Returns the version directory name on success, or null on failure.
 *
 * Idempotent per packageName: concurrent calls share the same Promise.
 *
 * @param packageName  the miniapp's reverse-DNS package
 * @param devUrl       the project's URL (e.g. http://192.168.1.50:3000)
 * @param devPort      the sidecar's port (e.g. 3001) — used for the file manifest
 */
export function snapshotDevBundle(
  packageName: string,
  devUrl: string,
  devPort: number,
): Promise<string | null> {
  const existing = inFlight.get(packageName)
  if (existing) return existing
  const promise = doSnapshot(packageName, devUrl, devPort)
  inFlight.set(packageName, promise)
  void promise.finally(() => inFlight.delete(packageName))
  return promise
}

async function doSnapshot(
  packageName: string,
  devUrl: string,
  devPort: number,
): Promise<string | null> {
  const sidecarBase = buildSidecarBaseUrl(devUrl, devPort)
  if (!sidecarBase) {
    console.warn(`${LOG_TAG}: ${packageName} cannot derive sidecar URL from ${devUrl}`)
    return null
  }

  // 1. Fetch the file manifest.
  let files: string[]
  try {
    const res = await fetchWithTimeout(`${sidecarBase}/__mentra_dev/files`, FETCH_TIMEOUT_MS)
    if (!res.ok) {
      console.warn(`${LOG_TAG}: ${packageName} manifest endpoint returned ${res.status}`)
      return null
    }
    const body = (await res.json()) as {files?: string[]}
    if (!Array.isArray(body.files)) {
      console.warn(`${LOG_TAG}: ${packageName} manifest endpoint returned unexpected shape`)
      return null
    }
    files = body.files
  } catch (e) {
    console.warn(`${LOG_TAG}: ${packageName} manifest fetch failed:`, e)
    return null
  }

  if (files.length === 0) {
    console.warn(`${LOG_TAG}: ${packageName} manifest is empty — nothing to snapshot`)
    return null
  }

  // 2. Build a fresh dev-<timestamp> directory.
  const version = `dev-${Date.now()}`
  let versionDir: Directory
  try {
    versionDir = new Directory(Paths.document, "lmas", packageName, version)
    versionDir.create({intermediates: true})
  } catch (e) {
    console.error(`${LOG_TAG}: ${packageName} failed to create version dir:`, e)
    return null
  }

  // 3. Fetch each file with bounded concurrency. Bail on first failure —
  // a partial snapshot is worse than no snapshot for this version (the cache
  // mount path expects a complete bundle including index.html).
  try {
    await runWithConcurrency(PARALLELISM, files, async (relPath) => {
      const fileUrl = joinUrl(devUrl, relPath)
      const res = await fetchWithTimeout(fileUrl, FETCH_TIMEOUT_MS)
      if (!res.ok) {
        throw new Error(`${fileUrl} → ${res.status}`)
      }
      const buf = await res.arrayBuffer()
      // Strip leading slash; expo-file-system File constructor takes
      // relative segments below the parent directory.
      const stripped = relPath.replace(/^\//, "")
      const target = new File(versionDir, ...stripped.split("/"))
      const parent = target.parentDirectory
      if (parent && !parent.exists) {
        parent.create({intermediates: true})
      }
      target.create({overwrite: true})
      target.write(new Uint8Array(buf))
    })
  } catch (e) {
    console.warn(`${LOG_TAG}: ${packageName} snapshot failed mid-download:`, e)
    try {
      versionDir.delete()
    } catch {
      /* ignore */
    }
    return null
  }

  // 4. GC older dev-* dirs, keep latest 2 (current + previous fallback).
  gcDevVersions(packageName, 2)

  console.log(`${LOG_TAG}: ${packageName} snapshot complete → ${version} (${files.length} files)`)
  return version
}

/**
 * Returns the absolute file:// path to the latest dev-* bundle for this
 * package, or null if none exist. Used by the local route's cached-fallback
 * mount path.
 */
export function getLatestDevBundlePath(packageName: string): string | null {
  try {
    const pkgDir = new Directory(Paths.document, "lmas", packageName)
    if (!pkgDir.exists) return null
    const devDirs = pkgDir
      .list()
      .filter((d): d is Directory => d instanceof Directory && d.name.startsWith("dev-"))
      .sort((a, b) => (a.name < b.name ? 1 : -1))
    if (devDirs.length === 0) return null
    return devDirs[0].uri
  } catch (e) {
    console.warn(`${LOG_TAG}: ${packageName} getLatestDevBundlePath error:`, e)
    return null
  }
}

/** Delete every dev-* directory for this package. Used during removal. */
export function clearDevBundles(packageName: string): void {
  try {
    const pkgDir = new Directory(Paths.document, "lmas", packageName)
    if (!pkgDir.exists) return
    for (const item of pkgDir.list()) {
      if (item instanceof Directory && item.name.startsWith("dev-")) {
        try {
          item.delete()
        } catch (e) {
          console.warn(`${LOG_TAG}: ${packageName} failed to delete ${item.name}:`, e)
        }
      }
    }
  } catch (e) {
    console.warn(`${LOG_TAG}: ${packageName} clearDevBundles error:`, e)
  }
}

/**
 * GC older dev-* directories beyond `keep`. Latest by lexicographic sort
 * (dev-<timestamp> sorts correctly because timestamps are zero-padded ms).
 */
function gcDevVersions(packageName: string, keep: number): void {
  try {
    const pkgDir = new Directory(Paths.document, "lmas", packageName)
    if (!pkgDir.exists) return
    const dirs = pkgDir
      .list()
      .filter((d): d is Directory => d instanceof Directory && d.name.startsWith("dev-"))
      .sort((a, b) => (a.name < b.name ? 1 : -1))
    for (let i = keep; i < dirs.length; i++) {
      try {
        dirs[i].delete()
      } catch (e) {
        console.warn(`${LOG_TAG}: ${packageName} GC failed to delete ${dirs[i].name}:`, e)
      }
    }
  } catch (e) {
    console.warn(`${LOG_TAG}: ${packageName} gcDevVersions error:`, e)
  }
}

/**
 * Convert a miniapp's devUrl (http://host:miniappPort) plus the sidecar port
 * into the sidecar's base URL (http://host:sidecarPort). Returns null on
 * unparseable input.
 */
function buildSidecarBaseUrl(devUrl: string, sidecarPort: number): string | null {
  try {
    const url = new URL(devUrl)
    return `${url.protocol}//${url.hostname}:${sidecarPort}`
  } catch {
    return null
  }
}

/** Join devUrl + relative path with a single slash. */
function joinUrl(devUrl: string, relPath: string): string {
  return `${devUrl.replace(/\/$/, "")}${relPath.startsWith("/") ? relPath : `/${relPath}`}`
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {signal: controller.signal})
  } finally {
    clearTimeout(timer)
  }
}

/** Run async tasks with bounded concurrency. */
async function runWithConcurrency<T>(
  parallelism: number,
  items: T[],
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runOne = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      await worker(items[i])
    }
  }
  const runners = Array.from({length: Math.min(parallelism, items.length)}, () => runOne())
  await Promise.all(runners)
}
