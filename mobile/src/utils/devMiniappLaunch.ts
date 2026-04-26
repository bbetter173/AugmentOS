/**
 * decideDevLaunchRoute — pre-flight reachability for dev miniapp launches.
 *
 * Every entry point that wants to launch a dev miniapp (home tile,
 * QR scan, URL screen, dev-offline "Try again" button) calls this BEFORE
 * navigating, so we land on the right destination in a single transition:
 *
 *   reachable   → push("/applet/local", ...)        // live mount
 *   unreachable → push("/applet/dev-offline", ...)  // offline takeover
 *
 * Without this, /applet/local mounted on every tap, ran the freshness
 * check inside its async effect, and replaced to /applet/dev-offline if
 * the server was down — a visible flash of the local route on the way
 * to dev-offline. Pre-flighting at the call site keeps the route a
 * pure mount destination.
 */

import {storage} from "@/utils/storage/storage"

const REACHABILITY_TIMEOUT_MS = 500

export type DevLaunchDecision = "live" | "offline"

/**
 * HEAD against the dev server's miniapp.json with a hard timeout. Returns
 * "live" if the server responded with a non-error status before the
 * timeout fired; "offline" otherwise.
 *
 * Side effect: on success, writes <packageName>_dev_last_reachable so the
 * dev-offline screen can show "Last reached: N min ago" the next time
 * the user lands there.
 */
export async function decideDevLaunchRoute(
  packageName: string,
  devUrl: string,
): Promise<DevLaunchDecision> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS)
  try {
    const res = await fetch(`${devUrl.replace(/\/$/, "")}/miniapp.json`, {
      method: "HEAD",
      signal: controller.signal,
    })
    if (res.ok) {
      storage.save(`${packageName}_dev_last_reachable`, Date.now())
      return "live"
    }
    return "offline"
  } catch {
    return "offline"
  } finally {
    clearTimeout(timer)
  }
}
