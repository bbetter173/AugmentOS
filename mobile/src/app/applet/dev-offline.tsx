import {Image} from "expo-image"
import {useLocalSearchParams} from "expo-router"
import {SquircleView} from "expo-squircle-view"
import {StyleSheet, TextStyle, View, ViewStyle} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useApplets} from "@/stores/applets"
import {ThemedStyle} from "@/theme"
import {decideDevLaunchRoute} from "@/utils/devMiniappLaunch"
import {storage} from "@/utils/storage/storage"

/**
 * Shown when a dev miniapp is launched while the dev server is unreachable.
 * Visual language matches MiniappSplash — same 128px squircle icon, same
 * centered minimalism — so it reads as "the miniapp tried to load and
 * couldn't" rather than a settings screen with an error.
 *
 *   "Try again"  — re-launch the miniapp; if the dev server is now reachable,
 *                  the local route mounts live and silently snapshots the
 *                  bundle to disk so future offline launches can fall back.
 *   "Re-scan QR" — open the scanner; new QR replaces the old dev URL.
 */
export default function DevMiniappOfflineScreen() {
  const {packageName, name, iconUrl} = useLocalSearchParams<{
    packageName: string
    name?: string
    iconUrl?: string
  }>()
  const {goBack, replace, push} = useNavigationHistory()
  const {theme, themed} = useAppTheme()
  const apps = useApplets()

  // Fall back to the store entry's logoUrl/name if the route didn't carry
  // them. The store entry is populated by Composer.getLocalApplets from the
  // on-disk icon.png + miniapp.json — works even when the dev server is down.
  const fromStore = packageName ? apps.find((a) => a.packageName === packageName) : undefined
  const resolvedIconUrl = iconUrl || fromStore?.logoUrl || undefined
  const resolvedName = name || fromStore?.name

  const lastReachable = packageName ? storage.load<number>(`${packageName}_dev_last_reachable`) : null

  const lastReachableLabel =
    lastReachable && lastReachable.is_ok() ? formatRelative(lastReachable.value) : "never"

  const onTryAgain = async () => {
    if (!packageName) return
    const devUrlRes = storage.load<string>(`${packageName}_dev_url`)
    if (!devUrlRes.is_ok()) {
      push("/miniapps/settings/miniapp-developer-scanner")
      return
    }
    // Pre-flight reachability before deciding the route. If still down,
    // stay on the offline screen (no-op) so the user can try again or
    // re-scan. If up, replace into /applet/local.
    const launchResult = await decideDevLaunchRoute(packageName, devUrlRes.value)
    if (launchResult.decision === "live") {
      replace("/applet/local", {
        packageName,
        devUrl: devUrlRes.value,
        appName: name,
        iconUrl,
      })
    }
    // else: stay put — the "Last reached" line stays accurate, user can
    // tap again or re-scan.
  }

  const onRescan = () => {
    push("/miniapps/settings/miniapp-developer-scanner")
  }

  const displayName = resolvedName ?? packageName ?? "Dev mini app"

  return (
    <Screen preset="fixed">
      <Header title={displayName} leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <View style={[styles.root, {backgroundColor: theme.colors.background}]}>
        {resolvedIconUrl ? (
          <SquircleView
            cornerSmoothing={100}
            preserveSmoothing={true}
            style={styles.icon}>
            <Image
              source={resolvedIconUrl}
              style={styles.iconImage}
              contentFit="cover"
              transition={200}
              cachePolicy="memory-disk"
            />
          </SquircleView>
        ) : null}

        <Text style={themed($title)} text={displayName} />
        <Text style={themed($subtitle)} text="Dev server offline" />
        <Text style={themed($detail)} text={`Last reached: ${lastReachableLabel}`} />

        <View style={themed($buttonColumn)}>
          <Button text="Try again" onPress={onTryAgain} preset="alternate" />
          <Button text="Re-scan QR" onPress={onRescan} preset="default" />
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

const ICON_SIZE = 128

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  icon: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: 24,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  iconImage: {
    width: "100%",
    height: "100%",
  },
})

const $title: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 20,
  fontWeight: "600",
  color: colors.text,
  textAlign: "center",
})

const $subtitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 15,
  color: colors.text,
  textAlign: "center",
  marginTop: spacing.s2,
})

const $detail: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 13,
  color: colors.textDim,
  textAlign: "center",
  marginTop: spacing.s1,
  marginBottom: spacing.s6,
})

const $buttonColumn: ThemedStyle<ViewStyle> = ({spacing}) => ({
  width: "100%",
  maxWidth: 320,
  gap: spacing.s3,
})
