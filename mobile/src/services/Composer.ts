import {ClientAppletInterface, saveLocalAppRunningState, useAppletStatusStore} from "@/stores/applets"
import {storage} from "@/utils/storage/storage"
import {printDirectory} from "@/utils/storage/zip"
import {Directory, Paths, File} from "expo-file-system"
import {unzip} from "react-native-zip-archive"
import {AsyncResult, Result, result as Res} from "typesafe-ts"
import semver from "semver"
import type {AppletPermission, AppPermissionType} from "@/../../cloud/packages/types/src"
import {HardwareRequirement, HardwareRequirementLevel, HardwareType} from "@/../../cloud/packages/types/src"

const ALLOWED_PERMISSION_TYPES: ReadonlySet<AppPermissionType> = new Set<AppPermissionType>([
  "MICROPHONE",
  "CAMERA",
  "CALENDAR",
  "LOCATION",
  "BACKGROUND_LOCATION",
  "READ_NOTIFICATIONS",
  "POST_NOTIFICATIONS",
])
export interface LmaPermission {
  type: string
  description: string
}

/**
 * Normalize the `permissions` field from a miniapp.json manifest.
 *
 * New miniapps ship `[{type, required?, description?}]` objects. A few older
 * installed bundles may have `["MICROPHONE", ...]` plain strings. Accept both.
 */
export function normalizeManifestPermissions(
  raw: Array<string | {type: string; required?: boolean; description?: string}> | undefined,
): AppletPermission[] {
  if (!Array.isArray(raw)) return []
  const out: AppletPermission[] = []
  for (const p of raw) {
    if (typeof p === "string") {
      if (ALLOWED_PERMISSION_TYPES.has(p as AppPermissionType)) {
        out.push({type: p as AppPermissionType, required: true})
      }
    } else if (p && typeof p === "object" && typeof p.type === "string") {
      if (ALLOWED_PERMISSION_TYPES.has(p.type as AppPermissionType)) {
        out.push({
          type: p.type as AppPermissionType,
          ...(typeof p.required === "boolean" ? {required: p.required} : {}),
          ...(typeof p.description === "string" ? {description: p.description} : {}),
        })
      }
    }
  }
  return out
}

/**
 * Convert declared hardwareRequirements from a miniapp.json manifest into the
 * runtime `HardwareRequirement[]` shape, and always append `{EXIST, REQUIRED}`
 * so the launcher shows "Glasses Required" for local miniapps when no glasses
 * are connected (matches cloud behavior at refreshApplets for remote apps).
 *
 * Malformed entries are dropped with a single warning per package so the rest
 * of the manifest still works.
 */
export function buildHardwareRequirements(
  raw: Array<{type: string; level: string; description?: string}> | undefined,
  packageName: string,
): HardwareRequirement[] {
  const out: HardwareRequirement[] = []
  const validTypes = new Set(Object.values(HardwareType) as string[])
  const validLevels = new Set(Object.values(HardwareRequirementLevel) as string[])

  if (!Array.isArray(raw)) {
    if (raw !== undefined) {
      console.warn(
        `COMPOSER: ${packageName} has invalid hardwareRequirements (not an array); treating as []`,
      )
    }
  } else {
    let warned = false
    for (const r of raw) {
      if (
        !r ||
        typeof r !== "object" ||
        typeof r.type !== "string" ||
        typeof r.level !== "string" ||
        !validTypes.has(r.type) ||
        !validLevels.has(r.level)
      ) {
        if (!warned) {
          console.warn(
            `COMPOSER: ${packageName} has malformed hardwareRequirements entry; skipping invalid entries`,
            r,
          )
          warned = true
        }
        continue
      }
      out.push({
        type: r.type as HardwareType,
        level: r.level as HardwareRequirementLevel,
        ...(typeof r.description === "string" ? {description: r.description} : {}),
      })
    }
  }

  // Always require glasses to be connected for any local miniapp.
  out.push({type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED})
  return out
}

interface InstalledInfo {
  // version: string
  name: string
  logoUrl: string
}

interface InstalledLma {
  packageName: string
  versions: Record<string, InstalledInfo>
}

async function downloadAndInstallMiniApp(url: string) {
  let downloadedZipPath: string = ""

  // create the download directory if it doesn't exist
  const downloadDir = new Directory(Paths.cache, "lma_downloads")
  try {
    if (!downloadDir.exists) {
      downloadDir.create()
    }
  } catch (error) {
    console.error("ZIP: Error creating download directory", error)
    throw "CREATE_DOWNLOAD_DIR_FAILED"
  }

  try {
    const output = await File.downloadFileAsync(url, downloadDir)
    downloadedZipPath = output.uri
  } catch (error) {
    let errorMessage = error + ""
    if (errorMessage.includes("already exists")) {
      console.log("ZIP: File already exists, skipping download")
      downloadedZipPath = `${Paths.cache.uri}/lma_downloads/${url.split("/").pop()}`
    } else {
      console.error("ZIP: Error downloading zip file", error)
      throw "DOWNLOAD_FAILED"
    }
  }

  console.log("ZIP: done downloading, starting unzip")

  const unzipDir = new Directory(Paths.cache, "lma_unzip")
  try {
    if (!unzipDir.exists) {
      unzipDir.create()
    } else {
      // delete the directory, then create it
      unzipDir.delete()
      unzipDir.create()
    }
  } catch (error) {
    console.error("ZIP: Error creating or deleting the unzip directory", error)
    throw "CREATE_CACHE_DIR_FAILED"
  }

  let res = null
  try {
    console.log("ZIP: unzipping", downloadedZipPath)
    console.log("ZIP: unzip directory", unzipDir.uri)
    res = await unzip(downloadedZipPath, unzipDir.uri)
    // console.log(unzipOutput.exists) // true
    // console.log(unzipOutput.uri) // path to the unzipped file, e.g., '${cacheDirectory}/pdfs/sample.pdf'
  } catch (error) {
    console.error("Error unzipping zip file", error)
    throw "UNZIP_FAILED"
  }

  console.log("ZIP: done unzipping", res)

  // get the package name and info from the app.json file:
  let packageName = null
  let version = null
  let folderName = null
  let appDir
  try {
    // console.log("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@")
    // printDirectory(unzipDir)

    const firstFile = unzipDir.list()[0] // this should be the folder containing the app.json file
    folderName = firstFile.name
    console.log("ZIP: folder name", folderName)

    // TODO: we shouldn't be fault tolerant here, but I can't seem to tell the difference between how these zip files were created
    // it seems sometimes an extra folder is created, and sometimes it's not.
    if (folderName === "icon.png" || folderName === "app.json") {
      // there's no additional folder, so we should use the unzipDir directly
      appDir = unzipDir
    } else {
      appDir = new Directory(unzipDir, folderName)
    }
  } catch (error) {
    console.error("Error getting the app directory", error)
    throw "GET_APP_DIR_FAILED"
  }

  try {
    // read firstFile/app.json:
    const appJsonFile = new File(appDir, "app.json")
    const appJson = JSON.parse(appJsonFile.textSync())
    packageName = appJson.packageName
    version = appJson.version

    console.log("ZIP: package name", packageName)
    console.log("ZIP: version", version)
  } catch (error) {
    console.error("Error reading the app.json file", error)
    throw "READ_APP_JSON_FAILED"
  }

  // move the contents of this folder to Documents/lmas/<version>/<packageName>

  const basePackageDir = new Directory(Paths.document, "lmas", packageName)
  try {
    if (!basePackageDir.exists) {
      basePackageDir.create({intermediates: true})
    }
  } catch (error) {
    console.error("Error creating the base package directory", error)
    throw "CREATE_PACKAGE_DIR_FAILED"
  }

  // create the version directory
  const versionDir = new Directory(basePackageDir, version)
  try {
    if (!versionDir.exists) {
      versionDir.create()
    } else {
      // delete the directory, then create it
      versionDir.delete()
      versionDir.create()
    }
  } catch (error) {
    console.error("Error creating the version directory", error)
    throw "CREATE_VERSION_DIR_FAILED"
  }

  // move the contents of the folder to the destination directory
  try {
    const contents = appDir.list()
    for (const item of contents) {
      item.move(versionDir)
    }
  } catch (error) {
    console.error("Error moving the contents of the folder to the destination directory", error)
    throw "INSTALL_CONTENTS_FAILED"
  }

  console.log("ZIP: local mini app installed at", versionDir.uri)
  printDirectory(versionDir, 2)
}

class Composer {
  private installedLmas: ClientAppletInterface[] = []
  private refreshNeeded: boolean = false
  private pcmSub: any = null

  private static instance: Composer | null = null
  private constructor() {
    this.initialize()
  }

  public static getInstance(): Composer {
    if (!Composer.instance) {
      Composer.instance = new Composer()
    }
    return Composer.instance
  }

  // read local storage to find which mini apps are installed and running
  // if any mini app needs online or offlline transcriptions, we need to feed them the necessary data
  public async initialize() {
    // Scan Paths.document/lmas/ and populate appletStatusStore with installed miniapps.
    // Called explicitly from MantleManager.init() on every app launch.
    try {
      const applets = await this.getLocalApplets()
      console.log(`COMPOSER: initialize() found ${applets.length} installed miniapps`)
    } catch (error) {
      console.error("COMPOSER: initialize() error:", error)
    }
  }

  /**
   * Returns the on-disk path for a given miniapp bundle version.
   */
  public getBundleDir(packageName: string, version: string): string {
    return `${Paths.document.uri}/lmas/${packageName}/${version}`
  }

  /**
   * Read and parse the miniapp manifest (miniapp.json with app.json fallback)
   * from a given bundle directory.
   */
  public getMiniappManifest(packageName: string, version: string): any {
    const bundleDir = new Directory(Paths.document, "lmas", packageName, version)
    try {
      const miniappJsonFile = new File(bundleDir, "miniapp.json")
      if (miniappJsonFile.exists) {
        return JSON.parse(miniappJsonFile.textSync())
      }
    } catch (e) {
      console.warn("COMPOSER: Error reading miniapp.json, trying app.json fallback", e)
    }
    try {
      const appJsonFile = new File(bundleDir, "app.json")
      if (appJsonFile.exists) {
        return JSON.parse(appJsonFile.textSync())
      }
    } catch (e) {
      console.warn("COMPOSER: Error reading app.json fallback", e)
    }
    return null
  }

  /**
   * Alias for installMiniApp — download and install a miniapp bundle from a URL.
   */
  public installFromUrl(url: string): AsyncResult<void, Error> {
    return this.installMiniApp(url)
  }

  // download the mini app from the url and unzip it to the app's cache directory/lma/<packageName>
  public installMiniApp(url: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      await downloadAndInstallMiniApp(url)
      console.log("COMPOSER: Downloaded and installed mini app")
      this.refreshNeeded = true
      await useAppletStatusStore.getState().refreshApplets()
    })
  }

  public uninstallMiniApp(packageName: string, version?: string): AsyncResult<void, Error> {
    return Res.try_async(async () => {
      if (version) {
        const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
        lmaDir.delete()
        console.log("COMPOSER: Uninstalled mini app version", version)
        // when uninstalling a version, if we have no versions left, delete the package directory:
        const packageDir = new Directory(Paths.document, "lmas", packageName)
        if (packageDir.exists && packageDir.list().length === 0) {
          packageDir.delete()
        }
      } else {
        // No version specified — remove all versions (entire package directory)
        const packageDir = new Directory(Paths.document, "lmas", packageName)
        if (packageDir.exists) {
          packageDir.delete()
        }
        console.log("COMPOSER: Uninstalled all versions of mini app", packageName)
      }
      this.refreshNeeded = true
      await useAppletStatusStore.getState().refreshApplets()
    })
  }

  public getPackageNames(): string[] {
    try {
      const lmasDir = new Directory(Paths.document, "lmas")
      if (!lmasDir.exists) {
        // console.log("COMPOSER: No lmas directory found, returning empty array")
        return []
      }
      let lmas = lmasDir.list()
      // keep only package directories that contain at least one version directory/file
      lmas = lmas.filter((lma): lma is Directory => lma instanceof Directory && lma.list().length > 0)
      return lmas.map((lma) => lma.name)
    } catch (error) {
      console.error("COMPOSER: Error getting locally installed package names", error)
      return []
    }
  }

  public getAppletInstalledVersions(packageName: string): string[] {
    try {
      const lmaDir = new Directory(Paths.document, "lmas", packageName)
      const lma = lmaDir.list()
      console.log("COMPOSER: Local applet", lma)
      return lma.map((lma) => lma.name)
    } catch (error) {
      console.error("COMPOSER: Error getting local applet versions", error)
      return []
    }
  }

  public async getActiveAppletVersion(packageName: string): Promise<string> {
    let res = storage.load<string>(`${packageName}_active_version`)
    if (res.is_ok()) {
      return res.value
    }
    // if no active version is set, set it to the latest version:
    let versions = this.getAppletInstalledVersions(packageName)
    // Dev versions take precedence over semver-installed versions — re-scanning
    // a dev miniapp replaces the package directory entirely in practice, so
    // having both side-by-side is unusual, but if it happens dev wins. Pick
    // the newest dev-* by lexicographic sort (timestamp suffix).
    const devVersions = versions
      .filter((v) => v.startsWith("dev-"))
      .sort()
      .reverse()
    if (devVersions.length > 0) {
      await this.setActiveAppletVersion(packageName, devVersions[0])
      return devVersions[0]
    }
    // No dev versions — semver path. Filter out any non-semver entries to be safe.
    versions = versions.filter((v) => semver.valid(v))
    versions.sort((a, b) => semver.rcompare(a, b))
    await this.setActiveAppletVersion(packageName, versions[0])
    return versions[0]
  }

  public setActiveAppletVersion(packageName: string, version: string): Result<void, Error> {
    return storage.save(`${packageName}_active_version`, version)
  }

  public getAppletMetadata(packageName: string, version: string): InstalledInfo {
    try {
      const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
      // Read miniapp.json (the new manifest filename). app.json was the old
      // name; greenfield, no need to fall back.
      const miniappJsonFile = new File(lmaDir, "miniapp.json")
      const manifest = JSON.parse(miniappJsonFile.textSync())
      const logoUrl = new File(lmaDir, "icon.png").uri
      return {name: manifest.name, logoUrl: logoUrl}
    } catch (error) {
      console.error("COMPOSER: Error getting local miniapp metadata", error)
      return {name: "error", logoUrl: ""}
    }
  }

  /**
   * Returns the absolute path to the latest `dev-*` version directory for
   * the given package, or null if none exist. Used by the local route's
   * cached-fallback mount path when the dev server is unreachable.
   */
  public getLatestDevBundlePath(packageName: string): string | null {
    try {
      const pkgDir = new Directory(Paths.document, "lmas", packageName)
      if (!pkgDir.exists) return null
      const devDirs = pkgDir
        .list()
        .filter((d): d is Directory => d instanceof Directory && d.name.startsWith("dev-"))
        .map((d) => d.name)
        .sort()
        .reverse()
      if (devDirs.length === 0) return null
      return new Directory(pkgDir, devDirs[0]).uri
    } catch (error) {
      console.error("COMPOSER: Error getting latest dev bundle path", error)
      return null
    }
  }
  // return {packageName: string, versions: string[]}
  public getInstalledAppletsInfo(): InstalledLma[] {
    const packageNames = this.getPackageNames()
    const appletsInfo: InstalledLma[] = []
    for (const packageName of packageNames) {
      const versionStrings = this.getAppletInstalledVersions(packageName)
      const installedVersion: InstalledLma = {packageName, versions: {}}

      for (const versionString of versionStrings) {
        const info: InstalledInfo = this.getAppletMetadata(packageName, versionString)
        installedVersion.versions[versionString] = info
      }
      appletsInfo.push(installedVersion)
    }
    // console.log("COMPOSER: Applets info", appletsInfo)
    return appletsInfo
  }

  public async getLocalApplets(): Promise<ClientAppletInterface[]> {
    if (!this.refreshNeeded && this.installedLmas.length > 0) {
      // return this.installedLmas
      // this is the source of truth for running state:
      return useAppletStatusStore.getState().apps.filter((a) => a.local)
    }

    try {
      const installedLmasInfo = await this.getInstalledAppletsInfo()
      // console.log("COMPOSER: Installed Lmas Info", installedLmasInfo)
      // use the latest version for now (will be overriddable later via <packageName>_version_key)
      // build the installedLmas array:
      const lmas: ClientAppletInterface[] = []
      for (const lmaInfo of installedLmasInfo) {
        let versionString = await this.getActiveAppletVersion(lmaInfo.packageName)
        let versionInfo = lmaInfo.versions[versionString]

        // Read manifest (miniapp.json with app.json fallback, via the shared
        // helper). Extract permissions + hardwareRequirements.
        const manifest = this.getMiniappManifest(lmaInfo.packageName, versionString) as
          | {
              permissions?: Array<string | {type: string; required?: boolean; description?: string}>
              hardwareRequirements?: Array<{type: string; level: string; description?: string}>
            }
          | null

        const permissions = normalizeManifestPermissions(manifest?.permissions)
        const hardwareRequirements = buildHardwareRequirements(
          manifest?.hardwareRequirements,
          lmaInfo.packageName,
        )

        // Dev miniapps live in the same lmas/ tree as installed ones, but
        // their version directory name starts with "dev-". Surface them via
        // the existing applet store with isMiniappDev=true so UI code that
        // already reads the flag (badge, lifecycle, bug-report skip) works.
        const isMiniappDev = versionString.startsWith("dev-")
        let devUrl: string | undefined
        if (isMiniappDev) {
          const devUrlRes = storage.load<string>(`${lmaInfo.packageName}_dev_url`)
          if (devUrlRes.is_ok()) devUrl = devUrlRes.value
        }

        lmas.push({
          packageName: lmaInfo.packageName,
          version: versionString,
          running: false,
          local: true,
          healthy: true,
          loading: false,
          offline: false,
          hidden: false,
          offlineRoute: "",
          name: versionInfo.name,
          webviewUrl: "",
          logoUrl: versionInfo.logoUrl,
          type: "standard",
          permissions,
          hardwareRequirements,
          ...(isMiniappDev ? {isMiniappDev: true} : {}),
          ...(devUrl ? {devUrl} : {}),
          onStart: () => saveLocalAppRunningState(lmaInfo.packageName, true),
          onStop: () => saveLocalAppRunningState(lmaInfo.packageName, false),
        })
      }

      this.installedLmas = lmas
      this.refreshNeeded = false

      // console.log("COMPOSER: Installed Lmas", this.installedLmas)
      return this.installedLmas
    } catch (error) {
      console.error("Error getting local applets", error)
      return this.installedLmas
    }
  }

  public getLocalMiniAppHtml(packageName: string, version: string): Result<string, Error> {
    return Res.try(() => {
      const lmaDir = new Directory(Paths.document, "lmas", packageName, version)
      const htmlFile = new File(lmaDir, "index.html")
      return htmlFile.textSync()
    })
  }

  // public startStop(applet: ClientAppletInterface, status: boolean): AsyncResult<void, Error> {
  //   return Res.try_async(async () => {})
  // }

  // manage global state for apps and mic data / transcriptions:
  public async updateOfflineSTT() {
    // const offlineCaptionsRunning = await useSettingsStore.getState().getSetting(SETTINGS.offline_captions_running.key)
    // const offlineTranslationRunning = await useSettingsStore
    //   .getState()
    //   .getSetting(SETTINGS.offline_translation_running.key)
    // if (offlineCaptionsRunning) {
    // }
  }
}

const composer = Composer.getInstance()
export default composer
