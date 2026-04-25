import {useEffect, useState} from "react"
import {ScrollView, TextInput, TextStyle, View, ViewStyle} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {storage} from "@/utils/storage/storage"

const RECENT_KEY = "miniapp_dev_recent"
const MAX_RECENT = 5

interface RecentDevApp {
  packageName: string
  name: string
  url: string
  timestamp: number
}

export default function MiniappDeveloperUrlScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack, push} = useNavigationHistory()
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(false)
  const [recent, setRecent] = useState<RecentDevApp[]>([])

  useEffect(() => {
    const result = storage.load<RecentDevApp[]>(RECENT_KEY)
    if (result.is_ok()) setRecent(result.value)
  }, [])

  const saveRecent = (items: RecentDevApp[]) => {
    setRecent(items)
    storage.save(RECENT_KEY, items)
  }

  const launchDevMiniapp = (entry: RecentDevApp) => {
    push("/applet/local", {
      packageName: entry.packageName,
      devUrl: entry.url,
      appName: entry.name,
    })
  }

  const handleLoadUrl = async () => {
    const trimmed = url.trim().replace(/\/+$/, "")
    if (!trimmed) {
      showAlert(translate("devSettings:miniappUrlEmptyTitle"), translate("devSettings:miniappUrlEmptyBody"), [
        {text: "OK"},
      ])
      return
    }
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      showAlert(translate("devSettings:miniappUrlInvalidTitle"), translate("devSettings:miniappUrlInvalidBody"), [
        {text: "OK"},
      ])
      return
    }

    setLoading(true)
    try {
      const res = await fetch(`${trimmed}/miniapp.json`)
      const manifest = await res.json()
      const entry: RecentDevApp = {
        packageName: manifest.packageName || "com.dev.unknown",
        name: manifest.name || "Dev Mini App",
        url: trimmed,
        timestamp: Date.now(),
      }
      const updated = [entry, ...recent.filter((r) => r.url !== entry.url)].slice(0, MAX_RECENT)
      saveRecent(updated)
      // Persist the dev URL keyed on packageName so Composer's
      // getLocalApplets sees it and so home-tile taps after a phone
      // restart can route to the live server.
      storage.save(`${entry.packageName}_dev_url`, entry.url)
      launchDevMiniapp(entry)
    } catch {
      showAlert(
        translate("devSettings:miniappUrlFetchErrorTitle"),
        translate("devSettings:miniappUrlFetchErrorBody", {url: trimmed}),
        [{text: "OK"}],
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("devSettings:miniappUrlTitle")} leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-6">
          <Group title={translate("devSettings:miniappUrlGroupTitle")}>
            <GlassView className="bg-primary-foreground rounded-2xl" style={themed($inputCard)}>
              <Text style={themed($label)} tx="devSettings:miniappUrlLabel" />
              <Text style={themed($subtitle)}>
                {translate("devSettings:miniappUrlSubtitlePrefix")}
                <Text style={themed($codeInline)} text="/miniapp.json" />
                {translate("devSettings:miniappUrlSubtitleSuffix")}
              </Text>
              <TextInput
                style={themed($urlInput)}
                placeholder="http://192.168.1.50:3000"
                placeholderTextColor={theme.colors.textDim}
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={!loading}
              />
              <Button
                tx={loading ? "devSettings:miniappUrlLoadingButton" : "devSettings:miniappUrlLoadButton"}
                onPress={handleLoadUrl}
                disabled={loading}
                preset="alternate"
                flexContainer={false}
              />
            </GlassView>
          </Group>

          {recent.length > 0 && (
            <Group title={translate("devSettings:miniappUrlRecentTitle")}>
              {recent.map((item) => (
                <RouteButton
                  key={item.url}
                  label={item.name}
                  subtitle={item.url}
                  onPress={() => launchDevMiniapp(item)}
                />
              ))}
            </Group>
          )}

          <Spacer height={theme.spacing.s12} />
        </View>
      </ScrollView>
    </Screen>
  )
}

const $inputCard: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s4,
  paddingVertical: spacing.s4,
  gap: spacing.s2,
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.text,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.textDim,
})

const $codeInline: ThemedStyle<TextStyle> = ({colors}) => ({
  fontFamily: "Courier",
  color: colors.text,
})

const $urlInput: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  borderColor: colors.primary,
  borderWidth: 1,
  borderRadius: spacing.s3,
  paddingHorizontal: 12,
  paddingVertical: 10,
  fontSize: 14,
  marginTop: 6,
  marginBottom: 6,
  color: colors.text,
})
