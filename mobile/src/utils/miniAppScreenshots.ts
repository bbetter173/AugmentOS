import {RefObject, useCallback} from "react"
import {Platform, View} from "react-native"
import {captureRef} from "react-native-view-shot"

import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppletStatusStore} from "@/stores/applets"

export async function captureAndSaveMiniAppScreenshot(
  viewShotRef: RefObject<View | null>,
  packageName: string | null | undefined,
) {
  if (!packageName || !viewShotRef.current) {
    return
  }

  try {
    const uri = await captureRef(viewShotRef, {
      format: "jpg",
      quality: 0.5,
    })
    await useAppletStatusStore.getState().saveScreenshot(packageName, uri)
  } catch (error) {
    console.warn("screenshot failed:", error)
  }
}

export function useMiniAppScreenshotBackHandler(
  viewShotRef: RefObject<View | null>,
  resolvePackageName: () => string | null | undefined,
) {
  const {goBack} = useNavigationHistory()

  const saveScreenshot = useCallback(async () => {
    await captureAndSaveMiniAppScreenshot(viewShotRef, resolvePackageName())
  }, [resolvePackageName, viewShotRef])

  const goBackWithScreenshot = useCallback(async () => {
    await saveScreenshot()
    goBack()
  }, [goBack, saveScreenshot])

  focusEffectPreventBack(() => {
    void (async () => {
      await saveScreenshot()
      if (Platform.OS === "android") {
        goBack()
      }
    })()
  }, true)

  return {
    saveScreenshot,
    goBackWithScreenshot,
  }
}
