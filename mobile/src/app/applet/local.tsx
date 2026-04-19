import {useEffect, useRef, useState} from "react"
import {useLocalSearchParams} from "expo-router"
import {View} from "react-native"
import {Text} from "@/components/ignite"
import {miniappHost} from "@/components/miniapp/MiniappHost"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import composer from "@/services/Composer"

export default function LocalMiniAppPage() {
  const {appName, packageName, version, devUrl, iconUrl} = useLocalSearchParams<{
    appName: string
    packageName: string
    version?: string
    devUrl?: string
    iconUrl?: string
  }>()
  const {goBack, setForceGestureEnabled} = useNavigationHistory()

  // Keep a stable ref to the latest goBack so we don't re-fire the mount effect
  // every render just because useNavigationHistory returned a new function.
  const goBackRef = useRef(goBack)
  goBackRef.current = goBack

  useEffect(() => {
    if (!packageName) return

    const handleClose = () => {
      miniappHost.unmount(packageName)
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

    // mountDev is async (fetches manifest before registering the app), so we
    // need to chain setForeground after it resolves — otherwise foreground is
    // set before the app exists in the map and gets dropped.
    let cancelled = false
    ;(async () => {
      if (devUrl) {
        await miniappHost.mountDev(packageName, devUrl, {developerMode: true, appName, iconUrl})
      } else if (version) {
        const bundleDir = composer.getBundleDir(packageName, version)
        const bundleUri = `file://${bundleDir}/index.html`
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
  }, [packageName, version, devUrl])

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
