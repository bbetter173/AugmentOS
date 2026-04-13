import {useEffect} from "react"
import {useLocalSearchParams} from "expo-router"
import {Platform, View} from "react-native"
import {Text} from "@/components/ignite"
import {miniappHost} from "@/components/miniapp/MiniappHost"
import {MiniAppCapsuleMenu} from "@/components/miniapps/CapsuleMenu"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useRef} from "react"
import composer from "@/services/Composer"

export default function LocalMiniAppPage() {
  const {appName, packageName, version, devUrl} = useLocalSearchParams<{
    appName: string
    packageName: string
    version?: string
    devUrl?: string
  }>()
  const viewShotRef = useRef<View>(null)
  const {goBack} = useNavigationHistory()

  useEffect(() => {
    if (!packageName) return

    if (devUrl) {
      const injectedJS = `window.MentraOS = {packageName: ${JSON.stringify(packageName)}, platform: '${Platform.OS}', miniappDeveloperMode: true}; true;`
      miniappHost.mountDev(packageName, devUrl, injectedJS)
    } else if (version) {
      const bundleDir = composer.getBundleDir(packageName, version)
      const bundleUri = `file://${bundleDir}/index.html`
      const injectedJS = `window.MentraOS = {packageName: ${JSON.stringify(packageName)}, platform: '${Platform.OS}'}; true;`
      miniappHost.mount(packageName, bundleUri, injectedJS)
    }

    miniappHost.setForeground(packageName)

    return () => {
      // Background on navigate away, don't unmount — keep it alive
      miniappHost.setBackground(packageName)
    }
  }, [packageName, version, devUrl])

  const handleClose = () => {
    if (packageName) {
      miniappHost.unmount(packageName)
    }
    goBack()
  }

  if (!packageName) {
    return <Text>Missing required parameters</Text>
  }

  return (
    <View style={{flex: 1}}>
      <MiniAppCapsuleMenu packageName={packageName} viewShotRef={viewShotRef} onMinusPress={handleClose} />
    </View>
  )
}
