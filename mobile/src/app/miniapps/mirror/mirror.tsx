import {useRef} from "react"
import {View} from "react-native"

import {Screen} from "@/components/ignite"
import {MiniAppCapsuleMenu} from "@/components/miniapps/CapsuleMenu"
import {Group} from "@/components/ui"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"

export default function GallerySettingsScreen() {
  const viewShotRef = useRef<View>(null)
  return (
    <>
      <MiniAppCapsuleMenu packageName="com.mentra.mirror" viewShotRef={viewShotRef} />
      <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef}>
        <View className="h-24" />
        <Group>
          <GlassesDisplayMirror fallbackMessage="Glasses mirror" />
        </Group>
      </Screen>
    </>
  )
}
