/**
 * installMiniappFromUrl — generalizable "install a mini app from a URL"
 * pipeline. Layer 2 over Composer.installMiniApp(), shared across every
 * entry point that wants to install a packaged mini app onto the phone:
 *
 *   - QR scan with `mentra-miniapp://release?url=...` (CLI sideload)
 *   - "Install from URL" UI on the developer URL screen
 *   - Future deeplinks (`mentraos://install?url=...`)
 *   - Future store-side OTA updates
 *
 * What this does:
 *   1. Fetches <url>/miniapp.json to verify the URL points at a mini app
 *      and to read packageName/version/name for the success message.
 *   2. Calls composer.installMiniApp(<url>/bundle.zip) which downloads,
 *      unzips into lmas/<pkg>/<version>/, and fires refreshApplets.
 *   3. Returns a result so the caller can show the right success/error UX.
 *
 * What this does NOT do:
 *   - Permissions gate. Permissions are checked at LAUNCH time (startApplet
 *     → askPermissionsUI), same as installed cloud miniapps. Adding a gate
 *     here would be a duplicate flow.
 *   - Any prompts / confirmations. Caller decides whether to confirm before
 *     calling. Today's behavior: silent install + toast on success.
 */

import {AsyncResult, result as Res} from "typesafe-ts"

import composer from "@/services/Composer"

export interface InstalledMiniappInfo {
  packageName: string
  version: string
  name: string
}

/**
 * Install a packaged mini app from a base URL. The URL must serve:
 *   - GET /miniapp.json — the manifest
 *   - GET /bundle.zip   — the packaged miniapp (output of `mentra-miniapp pack`)
 *
 * On success returns the installed miniapp's identity (for "<name>
 * installed" messaging). On failure returns the underlying error.
 */
export function installMiniappFromUrl(baseUrl: string): AsyncResult<InstalledMiniappInfo, Error> {
  return Res.try_async(async () => {
    const trimmed = baseUrl.replace(/\/$/, "")

    const manifestRes = await fetch(`${trimmed}/miniapp.json`)
    if (!manifestRes.ok) {
      throw new Error(`Failed to fetch miniapp.json: ${manifestRes.status}`)
    }
    const manifest = (await manifestRes.json()) as Record<string, unknown>
    const packageName = manifest.packageName as string | undefined
    const version = manifest.version as string | undefined
    const name = (manifest.name as string | undefined) ?? packageName ?? "Mini app"
    if (!packageName) throw new Error("miniapp.json missing packageName")
    if (!version) throw new Error("miniapp.json missing version")

    const installRes = await composer.installMiniApp(`${trimmed}/bundle.zip`)
    if (installRes.is_error()) throw installRes.error

    return {packageName, version, name}
  })
}
