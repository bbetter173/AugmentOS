import {GalleryScreen} from "@/components/glasses/Gallery/GalleryScreen"
import {Screen} from "@/components/ignite"
import {cameraPackageName} from "@/stores/applets"
import {useMiniAppScreenshotBackHandler} from "@/utils/miniAppScreenshots"
import {useRef} from "react"
import {View} from "react-native"

export default function AsgGallery() {
  const viewShotRef = useRef<View>(null)
  const {goBackWithScreenshot} = useMiniAppScreenshotBackHandler(viewShotRef, () => cameraPackageName)

  return (
    <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef}>
      <GalleryScreen
        onExit={() => {
          void goBackWithScreenshot()
        }}
      />
    </Screen>
  )
}
