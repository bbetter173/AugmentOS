import {useState} from "react"
import {View, Alert} from "react-native"
import {CameraView} from "expo-camera"

import {Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

export default function MiniappDeveloperScanner() {
  const {replace} = useNavigationHistory()
  const [scanned, setScanned] = useState(false)

  const handleBarCodeScanned = async ({data}: {data: string}) => {
    if (scanned) return
    setScanned(true)

    try {
      let devUrl: string
      let packageName: string | undefined
      let name: string | undefined

      // Parse mentra-miniapp://dev?url=...&name=...&package=...
      if (data.startsWith("mentra-miniapp://dev")) {
        const url = new URL(data)
        devUrl = decodeURIComponent(url.searchParams.get("url") || "")
        name = url.searchParams.get("name") || undefined
        packageName = url.searchParams.get("package") || undefined
      } else if (data.startsWith("http://") || data.startsWith("https://")) {
        devUrl = data
      } else {
        Alert.alert("Invalid QR", "Expected a mentra-miniapp:// or http:// URL")
        setScanned(false)
        return
      }

      if (!devUrl) {
        Alert.alert("Invalid QR", "No URL found in QR code")
        setScanned(false)
        return
      }

      // Fetch manifest for permissions + metadata
      try {
        const res = await fetch(`${devUrl}/miniapp.json`)
        const manifest = await res.json()
        packageName = packageName || manifest.packageName || "com.dev.unknown"
        name = name || manifest.name || "Dev Miniapp"
      } catch {
        packageName = packageName || "com.dev.scanned"
        name = name || "Dev Miniapp"
      }

      // Navigate to local miniapp route
      replace("/applet/local", {
        packageName,
        devUrl,
        appName: name,
      })
    } catch (error) {
      Alert.alert("Error", String(error))
      setScanned(false)
    }
  }

  return (
    <View style={{flex: 1}}>
      <CameraView
        style={{flex: 1}}
        barcodeScannerSettings={{barcodeTypes: ["qr"]}}
        onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
      />
      <View style={{position: "absolute", top: 60, left: 0, right: 0, alignItems: "center"}}>
        <Text style={{color: "#fff", fontSize: 18, backgroundColor: "rgba(0,0,0,0.5)", padding: 8, borderRadius: 8}}>
          Scan QR from dev server
        </Text>
      </View>
    </View>
  )
}
