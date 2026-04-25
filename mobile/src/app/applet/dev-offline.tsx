import {Image, ImageStyle, TextStyle, View, ViewStyle} from "react-native"
import {useLocalSearchParams} from "expo-router"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ThemedStyle} from "@/theme"
import {storage} from "@/utils/storage/storage"

/**
 * Shown when a dev miniapp is launched while the dev server is unreachable
 * AND no cached bundle exists for it. Offers two paths back to working state:
 *
 *   "Try again"  — re-launch the miniapp; if the dev server is now reachable,
 *                  the local route mounts live and silently snapshots the
 *                  bundle to disk so future offline launches can fall back.
 *   "Re-scan QR" — open the scanner; new QR replaces the old dev URL.
 *
 * The 99% offline path is "user has a cached bundle from a prior live session"
 * — that path mounts silently. This screen is only the never-reached-it-yet
 * edge case.
 */
export default function DevMiniappOfflineScreen() {
  const {packageName, name, iconUrl} = useLocalSearchParams<{
    packageName: string
    name?: string
    iconUrl?: string
  }>()
  const {goBack, replace, push} = useNavigationHistory()
  const {themed} = useAppTheme()

  const lastReachable = packageName
    ? storage.load<number>(`${packageName}_dev_last_reachable`)
    : null

  const lastReachableLabel =
    lastReachable && lastReachable.is_ok()
      ? formatRelative(lastReachable.value)
      : "never"

  const onTryAgain = () => {
    if (!packageName) return
    const devUrl = storage.load<string>(`${packageName}_dev_url`)
    if (!devUrl.is_ok()) {
      push("/miniapps/settings/miniapp-developer-scanner")
      return
    }
    // Re-route through /applet/local; it'll re-do the freshness check.
    replace("/applet/local", {
      packageName,
      devUrl: devUrl.value,
      appName: name,
      iconUrl,
    })
  }

  const onRescan = () => {
    push("/miniapps/settings/miniapp-developer-scanner")
  }

  return (
    <Screen preset="fixed">
      <Header
        title={name ?? packageName ?? "Dev mini app"}
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
      />
      <View style={themed($container)}>
        <View style={themed($card)}>
          {iconUrl ? <Image source={{uri: iconUrl}} style={themed($icon)} /> : null}
          <Text style={themed($title)} text={name ?? packageName ?? "Dev mini app"} />
          <Text style={themed($subtitle)}>Dev server offline</Text>
          <Text style={themed($detail)}>{`Last reached: ${lastReachableLabel}`}</Text>
          <View style={themed($buttonRow)}>
            <Button text="Try again" onPress={onTryAgain} preset="alternate" flexContainer={false} />
            <Button text="Re-scan QR" onPress={onRescan} preset="default" flexContainer={false} />
          </View>
        </View>
      </View>
    </Screen>
  )
}

function formatRelative(timestamp: number): string {
  const now = Date.now()
  const ms = now - timestamp
  if (ms < 60_000) return "just now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(ms / 86_400_000)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.s6,
  alignItems: "center",
  justifyContent: "center",
})

const $card: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  padding: spacing.s6,
  alignItems: "center",
  gap: spacing.s2,
  width: "100%",
  maxWidth: 360,
})

const $icon: ThemedStyle<ImageStyle> = ({spacing}) => ({
  width: 64,
  height: 64,
  borderRadius: spacing.s3,
  marginBottom: spacing.s2,
})

const $title: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  fontWeight: "600",
  color: colors.text,
  textAlign: "center",
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 15,
  color: colors.text,
  textAlign: "center",
})

const $detail: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 13,
  color: colors.textDim,
  textAlign: "center",
  marginBottom: spacing.s4,
})

const $buttonRow: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  gap: spacing.s3,
  marginTop: spacing.s2,
})
