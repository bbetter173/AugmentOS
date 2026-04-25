import {useEffect, useRef, useState} from "react"
import {useLocalSearchParams} from "expo-router"
import {View} from "react-native"
import {Text} from "@/components/ignite"
import {miniappHost} from "@/components/miniapp/MiniappHost"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import composer, {buildHardwareRequirements} from "@/services/Composer"
import devServerBridge from "@/services/DevServerBridge"
import {useAppletStatusStore} from "@/stores/applets"
import {storage} from "@/utils/storage/storage"
import {HardwareType} from "@/../../cloud/packages/types/src"

const REACHABILITY_TIMEOUT_MS = 500

export default function LocalMiniAppPage() {
  const {appName, packageName, version, devUrl, iconUrl, devPort} = useLocalSearchParams<{
    appName: string
    packageName: string
    version?: string
    devUrl?: string
    iconUrl?: string
    devPort?: string
  }>()
  const {goBack, replace, setForceGestureEnabled} = useNavigationHistory()

  // Keep a stable ref to the latest goBack so we don't re-fire the mount effect
  // every render just because useNavigationHistory returned a new function.
  const goBackRef = useRef(goBack)
  goBackRef.current = goBack
  const replaceRef = useRef(replace)
  replaceRef.current = replace

  useEffect(() => {
    if (!packageName) return

    const handleClose = () => {
      // Background the miniapp the same way installed apps are backgrounded:
      // WebView lives in 1×1 off-screen holder, JS keeps running, tile stays
      // visible in switcher / home tray. Dev miniapps are first-class
      // installed apps now (Composer-backed) so removal happens only via
      // explicit long-press → Remove, not on close.
      miniappHost.setBackground(packageName)
      goBackRef.current()
    }

    // Back press handler — if the WebView has history, pop it. Otherwise exit
    // to the Mentra home.
    const handleBack = () => {
      const wentBack = miniappHost.goBackInWebView(packageName)
      if (!wentBack) {
        goBackRef.current()
      }
    }

    let cancelled = false
    ;(async () => {
      const isDev = !!devUrl

      if (isDev) {
        // Live-vs-cached routing for dev miniapps.
        //
        //   reachable          → mountDev(devUrl) — live URL, live reload, bg cache refresh
        //   unreachable + cache → mount(file://lmas/<pkg>/dev-<latest>/index.html)
        //   unreachable + no cache → push to /applet/dev-offline
        //
        // The cache only gets read in the offline path; live URL is always
        // preferred when available because live reload + console bridge need
        // the WebView to load from devUrl.

        const portNum = resolveDevPort(devPort, packageName)
        const reachable = await checkDevServerReachable(devUrl, REACHABILITY_TIMEOUT_MS)
        if (cancelled) return

        if (reachable) {
          const manifest = await miniappHost.mountDev(packageName, devUrl, {
            developerMode: true,
            appName,
            iconUrl,
          })
          if (portNum !== null) {
            devServerBridge.connect(packageName, devUrl, portNum)
            // Background snapshot via Composer's standard install pipeline:
            // fetches the dev server's bundle.zip, unpacks into
            // lmas/<pkg>/dev-<timestamp>/, then GCs older dev-* dirs.
            // refreshApplets is auto-fired by installMiniApp so the new
            // version surfaces in the applet store next render.
            const sidecarBase = buildSidecarBaseUrl(devUrl, portNum)
            if (sidecarBase) {
              const versionOverride = `dev-${Date.now()}`
              void composer
                .installMiniApp(`${sidecarBase}/__mentra_dev/bundle.zip`, {versionOverride})
                .then((res) => {
                  if (res.is_error()) {
                    console.warn(`Dev miniapp snapshot failed for ${packageName}:`, res.error)
                  } else {
                    composer.gcDevVersions(packageName, 2)
                  }
                })
            }
          }
          storage.save(`${packageName}_dev_last_reachable`, Date.now())

          // buildHardwareRequirements drops malformed entries and appends the
          // EXIST requirement; registerDevApplet appends EXIST again but the
          // compatibility check dedups it via the HardwareType.EXIST lookup,
          // so the duplicate is harmless. Strip it here so the list stays clean.
          const hwFromManifest = buildHardwareRequirements(manifest?.hardwareRequirements, packageName)
          const hwWithoutExist = hwFromManifest.filter((h) => h.type !== HardwareType.EXIST)
          useAppletStatusStore.getState().registerDevApplet({
            packageName,
            name: appName || packageName,
            devUrl,
            iconUrl,
            hardwareRequirements: hwWithoutExist,
          })
        } else {
          // Cached fallback. Composer's helper resolves to the latest
          // dev-<timestamp>/ for this package, or null if none.
          const cachedPath = composer.getLatestDevBundlePath(packageName)
          if (cachedPath) {
            const bundleUri = `${cachedPath}/index.html`
            miniappHost.mount(packageName, bundleUri, {
              developerMode: true,
              appName,
              iconUrl,
            })
            // Register the entry so it appears in the switcher even though
            // the manifest came from disk (we don't re-read it here; the
            // manifest is in the cached bundle and Composer's getLocalApplets
            // covers the boot-time path).
            useAppletStatusStore.getState().registerDevApplet({
              packageName,
              name: appName || packageName,
              devUrl,
              iconUrl,
              hardwareRequirements: [],
            })
          } else {
            // No cache, no server — full-screen offline takeover.
            replaceRef.current("/applet/dev-offline", {packageName, name: appName, iconUrl})
            return
          }
        }
      } else if (version) {
        const bundleDir = composer.getBundleDir(packageName, version)
        const bundleUri = `${bundleDir}/index.html`
        miniappHost.mount(packageName, bundleUri, {developerMode: false, appName, iconUrl})
      }

      if (cancelled) return
      miniappHost.setForeground(packageName, {onClose: handleClose, onBack: handleBack})
    })()

    return () => {
      cancelled = true
      // Background on navigate away, don't unmount — keep it alive
      miniappHost.setBackground(packageName)
    }
  }, [packageName, version, devUrl, devPort, appName, iconUrl])

  // Track WebView navigation state so we know whether "back" should pop the
  // WebView stack or exit the miniapp.
  const [webViewCanGoBack, setWebViewCanGoBack] = useState(false)
  useEffect(() => {
    if (!packageName) return
    return miniappHost.subscribeCanGoBack(packageName, setWebViewCanGoBack)
  }, [packageName])

  // Dynamically toggle gesture handling based on webview navigation state:
  // - Page 0 (no history): force-enable React Navigation's native swipe-back
  //   so user can exit miniapp.
  // - Has history: WebView's allowsBackForwardNavigationGestures handles
  //   in-webview swipe; React Navigation's gesture stays blocked by the
  //   focusEffectPreventBack inside MiniAppCapsuleMenu.
  useEffect(() => {
    setForceGestureEnabled(!webViewCanGoBack)
    return () => setForceGestureEnabled(false)
  }, [webViewCanGoBack, setForceGestureEnabled])

  if (!packageName) {
    return <Text>Missing required parameters</Text>
  }

  // The actual WebView + CapsuleMenu render inside MiniappHost at app root so
  // they survive navigation. This route is just a hook for setForeground /
  // setBackground as the user navigates in/out.
  return <View style={{flex: 1, backgroundColor: "transparent"}} pointerEvents="box-none" />
}

/**
 * Resolve the dev server's sidecar port. Search params take precedence (fresh
 * QR scan); fall back to the persisted MMKV key (home-tile-tap path).
 */
function resolveDevPort(searchParam: string | undefined, packageName: string): number | null {
  if (searchParam) {
    const n = parseInt(searchParam, 10)
    if (Number.isFinite(n)) return n
  }
  const stored = storage.load<number>(`${packageName}_dev_port`)
  if (stored.is_ok()) return stored.value
  return null
}

/**
 * Convert a dev miniapp's URL (`http://host:miniappPort`) plus the sidecar
 * port into the sidecar's base URL (`http://host:sidecarPort`). Returns
 * null if the URL can't be parsed.
 */
function buildSidecarBaseUrl(devUrl: string, sidecarPort: number): string | null {
  try {
    const url = new URL(devUrl)
    return `${url.protocol}//${url.hostname}:${sidecarPort}`
  } catch {
    return null
  }
}

/**
 * HEAD against the dev server's miniapp.json with a hard timeout. Returns
 * true iff the dev server responded with a non-error status before the
 * timeout fired.
 */
async function checkDevServerReachable(devUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${devUrl.replace(/\/$/, "")}/miniapp.json`, {
      method: "HEAD",
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
