import {CameraView, useCameraPermissions} from "expo-camera"
import * as Haptics from "expo-haptics"
import {useEffect, useState} from "react"
import {StyleSheet, TextStyle, View, ViewStyle} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"

export default function MiniappDeveloperScannerScreen() {
  const {themed} = useAppTheme()
  const {goBack, replace} = useNavigationHistory()
  const [permission, requestPermission] = useCameraPermissions()
  const [scanned, setScanned] = useState(false)

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission()
    }
  }, [permission, requestPermission])

  const handleBarcodeScanned = async ({data}: {data: string}) => {
    if (scanned) return
    setScanned(true)

    try {
      let devUrl: string
      let packageName: string | undefined
      let name: string | undefined

      if (data.startsWith("mentra-miniapp://dev")) {
        const url = new URL(data)
        devUrl = decodeURIComponent(url.searchParams.get("url") || "")
        name = url.searchParams.get("name") || undefined
        packageName = url.searchParams.get("package") || undefined
      } else if (data.startsWith("http://") || data.startsWith("https://")) {
        devUrl = data
      } else {
        showAlert(
          translate("devSettings:miniappScanInvalidQrTitle"),
          translate("devSettings:miniappScanInvalidQrBody"),
          [{text: "OK", onPress: () => setScanned(false)}],
        )
        return
      }

      if (!devUrl) {
        showAlert(
          translate("devSettings:miniappScanInvalidQrTitle"),
          translate("devSettings:miniappScanInvalidQrNoUrl"),
          [{text: "OK", onPress: () => setScanned(false)}],
        )
        return
      }

      let iconPath: string | undefined
      try {
        const res = await fetch(`${devUrl}/miniapp.json`)
        const manifest = await res.json()
        packageName = packageName || manifest.packageName || "com.dev.unknown"
        name = name || manifest.name || "Dev Miniapp"
        iconPath = manifest.icon || manifest.iconUrl || manifest.logoUrl
      } catch {
        packageName = packageName || "com.dev.scanned"
        name = name || "Dev Miniapp"
      }

      // Resolve the icon to an absolute URL on the dev server. Supports either
      // a relative path ("icon.png") or an absolute URL.
      let iconUrl: string | undefined
      if (iconPath) {
        iconUrl = /^https?:\/\//.test(iconPath)
          ? iconPath
          : `${devUrl.replace(/\/$/, "")}/${iconPath.replace(/^\//, "")}`
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
      replace("/applet/local", {packageName, devUrl, appName: name, iconUrl})
    } catch (error) {
      showAlert("Error", String(error), [{text: "OK", onPress: () => setScanned(false)}])
    }
  }

  if (!permission) {
    return (
      <Screen preset="fixed">
        <Header
          title={translate("devSettings:miniappScanTitle")}
          leftIcon="chevron-left"
          onLeftPress={() => goBack()}
        />
        <View style={themed($centered)}>
          <Text style={themed($muted)} tx="devSettings:miniappScanCheckingPermission" />
        </View>
      </Screen>
    )
  }

  if (!permission.granted) {
    return (
      <Screen preset="fixed">
        <Header
          title={translate("devSettings:miniappScanTitle")}
          leftIcon="chevron-left"
          onLeftPress={() => goBack()}
        />
        <View style={themed($permissionContainer)}>
          <View style={themed($permissionCard)}>
            <Text style={themed($permissionTitle)} tx="devSettings:miniappScanPermissionTitle" />
            <Text style={themed($permissionBody)} tx="devSettings:miniappScanPermissionBody" />
            <Button
              tx={permission.canAskAgain ? "devSettings:miniappScanGrantAccess" : "devSettings:miniappScanOpenSettings"}
              onPress={async () => {
                if (permission.canAskAgain) {
                  await requestPermission()
                } else {
                  showAlert(
                    translate("devSettings:miniappScanPermissionDeniedTitle"),
                    translate("devSettings:miniappScanPermissionDeniedBody"),
                    [{text: "OK"}],
                  )
                }
              }}
              preset="alternate"
              flexContainer={false}
            />
          </View>
        </View>
      </Screen>
    )
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("devSettings:miniappScanTitle")} leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <View style={themed($instructions)}>
        <Text style={themed($instructionsHeadline)} tx="devSettings:miniappScanHeadline" />
        <Text style={themed($instructionsBody)} tx="devSettings:miniappScanBody" />
      </View>

      <View style={themed($cameraContainer)}>
        <CameraView
          style={themed($camera)}
          barcodeScannerSettings={{barcodeTypes: ["qr"]}}
          onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
        />

        <View style={themed($overlay)} pointerEvents="none">
          <View style={themed($reticle)} />
        </View>

        <View style={themed($hintContainer)} pointerEvents="none">
          <Text style={themed($hintText)} tx="devSettings:miniappScanHint" />
        </View>
      </View>
    </Screen>
  )
}

const $centered: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
})

const $muted: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  fontSize: 14,
})

const $permissionContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.s6,
  justifyContent: "center",
})

const $permissionCard: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  padding: spacing.s6,
  alignItems: "center",
  gap: spacing.s3,
})

const $permissionTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  fontWeight: "600",
  color: colors.text,
  textAlign: "center",
})

const $permissionBody: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 13,
  color: colors.textDim,
  textAlign: "center",
  marginBottom: spacing.s2,
  lineHeight: 18,
})

const $instructions: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s6,
  paddingTop: spacing.s2,
  paddingBottom: spacing.s4,
  gap: spacing.s2,
})

const $instructionsHeadline: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "600",
  color: colors.text,
})

const $instructionsBody: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 13,
  lineHeight: 18,
  color: colors.textDim,
})

const $cameraContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flex: 1,
  marginHorizontal: spacing.s4,
  marginTop: spacing.s4,
  marginBottom: spacing.s12,
  maxHeight: 420,
  borderRadius: spacing.s4,
  overflow: "hidden",
  backgroundColor: colors.background,
})

const $camera: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $overlay: ThemedStyle<ViewStyle> = () => ({
  ...StyleSheet.absoluteFillObject,
  alignItems: "center",
  justifyContent: "center",
})

const $reticle: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  width: 240,
  height: 240,
  borderRadius: spacing.s4,
  borderWidth: 2,
  borderColor: colors.primary,
})

const $hintContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  position: "absolute",
  bottom: spacing.s6,
  left: 0,
  right: 0,
  alignItems: "center",
})

const $hintText: ThemedStyle<TextStyle> = () => ({
  color: "#fff",
  fontSize: 13,
  backgroundColor: "rgba(0,0,0,0.55)",
  paddingHorizontal: 12,
  paddingVertical: 6,
  borderRadius: 999,
  overflow: "hidden",
})
