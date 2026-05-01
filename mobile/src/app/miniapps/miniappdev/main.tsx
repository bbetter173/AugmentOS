import {useRef} from "react"
import {View} from "react-native"

import {Button, Screen} from "@/components/ignite"
import {MiniAppCapsuleMenu} from "@/components/miniapps/CapsuleMenu"
import ConnectedSimulatedGlassesInfo from "@/components/mirror/ConnectedSimulatedGlassesInfo"
import {Group} from "@/components/ui"
import GlassView from "@/components/ui/GlassView"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"
import {RouteButton} from "@/components/ui/RouteButton"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n/translate"
import {SETTINGS, useSetting} from "@/stores/settings"

export default function MiniappDevMain() {
  const viewShotRef = useRef<View>(null)
  const {push} = useNavigationHistory()
  const [localSttFallbackEnabled, setLocalSttFallbackEnabled] = useSetting(SETTINGS.local_stt_fallback_enabled.key)

  return (
    <>
      <MiniAppCapsuleMenu packageName="com.mentra.miniappdev" viewShotRef={viewShotRef} />
      <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef}>
        <View className="h-24" />

        <Group>
          <RouteButton
            label={translate("devSettings:miniappDevLoadUrlLabel")}
            subtitle={translate("devSettings:miniappDevLoadUrlSubtitle")}
            onPress={() => push("/miniapps/settings/miniapp-developer-url")}
          />
          <RouteButton
            label={translate("devSettings:miniappDevScanLabel")}
            subtitle={translate("devSettings:miniappDevScanSubtitle")}
            onPress={() => push("/miniapps/settings/miniapp-developer-scanner")}
          />
          <ToggleSetting
            label="Local STT Fallback"
            subtitle="Use on-device Sherpa when cloud transcription fails (requires downloaded language pack)"
            value={localSttFallbackEnabled}
            onValueChange={(value) => setLocalSttFallbackEnabled(value)}
          />
        </Group>
      </Screen>
    </>
  )
}
