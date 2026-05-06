import {useRef} from "react"
import {View} from "react-native"

import {Button, Screen} from "@/components/ignite"
import {MiniAppCapsuleMenu} from "@/components/miniapps/CapsuleMenu"
import ConnectedSimulatedGlassesInfo from "@/components/mirror/ConnectedSimulatedGlassesInfo"
import {Group} from "@/components/ui"
import GlassView from "@/components/ui/GlassView"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"

export default function GallerySettingsScreen() {
  const viewShotRef = useRef<View>(null)
  return (
    <>
      <MiniAppCapsuleMenu packageName="com.mentra.mirror" viewShotRef={viewShotRef} />
      <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef}>
        <View className="h-24" />

        <Group>
          {/* <GlassView className="bg-neutral-50 p-5"> */}
            <GlassesDisplayMirror fallbackMessage="Glasses mirror" />
            {/* <TouchableOpacity style={{position: "absolute", bottom: 10, right: 10}} onPress={navigateToFullScreen}>
              <Icon name="fullscreen" size={24} color={theme.colors.secondary_foreground} />
            </TouchableOpacity> */}
          {/* </GlassView> */}
        </Group>
      </Screen>
    </>
  )
}
