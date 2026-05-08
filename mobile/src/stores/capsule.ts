import {useCallback, useEffect, useRef} from "react"
import type {RefObject} from "react"
import {Image as RNImage, PixelRatio, Platform, View} from "react-native"
import {captureRef} from "react-native-view-shot"
import * as ImageManipulator from "expo-image-manipulator"
import {create} from "zustand"

import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useNavigationStore} from "@/stores/navigation"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {useAppStatusStore} from "@mentra/island"

export interface CapsuleRegistration {
  packageName: string
  viewShotRef: RefObject<View | null>
  appNameOverride?: string
  iconUrlOverride?: string
  /** Routes on which the visible capsule button should render. Empty/undefined = always visible while registered. */
  visibleOnRoutes?: string[]
  /** Called when the user taps the house/minus button. Captures screenshot + navigates back. */
  handleExit: (shouldGoBack?: boolean) => Promise<void> | void
}

interface CapsuleStore {
  active: CapsuleRegistration | null
  setActive: (reg: CapsuleRegistration | null) => void
}

export const useCapsuleStore = create<CapsuleStore>((set) => ({
  active: null,
  setActive: (reg) => set({active: reg}),
}))

interface UseRegisterCapsuleArgs {
  packageName: string
  viewShotRef: RefObject<View | null>
  appNameOverride?: string
  iconUrlOverride?: string
  visibleOnRoutes?: string[]
  /** Override the default screenshot+goBack behavior on Android back press. */
  onBackPress?: () => void
}

/**
 * Call from any miniapp screen that wants the global capsule button to appear
 * over its content. This hook:
 *   - Owns the screen-scoped useFocusEffect (must run inside a screen, not AllEffects).
 *   - Captures a screenshot via the screen's viewShotRef on back-navigation.
 *   - Registers metadata + the screenshot fn into useCapsuleStore so the
 *     globally-mounted <CapsuleMenu /> can render the visible button.
 */
export function useRegisterCapsule({
  packageName,
  viewShotRef,
  appNameOverride,
  iconUrlOverride,
  visibleOnRoutes,
  onBackPress,
}: UseRegisterCapsuleArgs) {
  const insets = useSaferAreaInsets()
  const {goBack} = useNavigationStore.getState()

  // Stable ref to insets.top so handleExit doesn't reallocate on every render.
  const insetsTopRef = useRef(insets.top)
  insetsTopRef.current = insets.top

  const handleExit = useCallback(
    async (shouldGoBack?: boolean) => {
      console.log("CAPSULE MENU: handleExit() called")

      if (Platform.OS === "ios") {
        let uri = await captureRef(viewShotRef, {
          format: "jpg",
          quality: 0.1,
          result: "tmpfile",
        })
        const {width, height} = await new Promise<{width: number; height: number}>((resolve, reject) => {
          RNImage.getSize(uri, (w, h) => resolve({width: w, height: h}), reject)
        })
        let amountToChop = insetsTopRef.current * PixelRatio.get()
        amountToChop = 0
        const context = ImageManipulator.ImageManipulator.manipulate(uri)
        context.crop({originX: 0, originY: amountToChop, width: width, height: height - amountToChop})
        const imageRef = await context.renderAsync()
        const cropped = await imageRef.saveAsync({
          format: ImageManipulator.SaveFormat.JPEG,
          compress: 0.1,
        })
        await useAppStatusStore.getState().saveScreenshot(packageName, cropped.uri)
      } else {
        captureRef(viewShotRef, {
          format: "jpg",
          quality: 0.5,
          result: "tmpfile",
        })
          .then((uri) => {
            useAppStatusStore.getState().saveScreenshot(packageName, uri)
          })
          .catch((e) => {
            console.warn("screenshot failed:", e)
          })
      }

      console.log("CAPSULE MENU: screenshot captured")

      if (shouldGoBack) {
        goBack()
      }
    },
    [packageName, viewShotRef, goBack],
  )

  // Always run focusEffectPreventBack with the same shape every render to keep
  // hook order stable inside that helper.
  focusEffectPreventBack(
    onBackPress
      ? () => {
          onBackPress()
        }
      : () => {
          let shouldGoBack = Platform.OS === "android"
          handleExit(shouldGoBack)
        },
    onBackPress ? false : true,
  )

  // Register / update / unregister the capsule entry in the store.
  const routesKey = visibleOnRoutes?.join("|") ?? ""
  useEffect(() => {
    useCapsuleStore.getState().setActive({
      packageName,
      viewShotRef,
      appNameOverride,
      iconUrlOverride,
      visibleOnRoutes,
      handleExit,
    })
    return () => {
      const current = useCapsuleStore.getState().active
      if (current?.packageName === packageName && current?.viewShotRef === viewShotRef) {
        useCapsuleStore.getState().setActive(null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageName, viewShotRef, appNameOverride, iconUrlOverride, routesKey, handleExit])
}
