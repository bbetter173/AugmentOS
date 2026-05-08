/**
 * Compositor — renders the foregrounded local miniapp over /home.
 *
 * Subscribes to the island apps store's `foreground` flag (set by the press
 * path's MiniappCatalog.navigateForApp). When an app becomes foreground the
 * Compositor:
 *   1. Calls launchLocalMiniapp() to mount + setForeground on MiniappHost
 *   2. Renders MiniappHost inside an Animated.View overlay above /home
 *   3. Renders <CapsuleMenu forceShow /> for the active miniapp
 *   4. Owns the iOS-style left-edge swipe-to-back gesture; on commit, clears
 *      foreground (host overlay slides off, miniapp keeps running in
 *      background — same as the old setBackground behavior)
 *
 * MiniappHost continues to handle WebView lifecycle (mount/mountDev/unmount,
 * runtime registration, splash). The route at /applet/local is now legacy —
 * the press path doesn't push it; only the QR scanner still uses it.
 */

import {useEffect, useRef} from "react"
import {Dimensions, Platform, View} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"
import Animated, {runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming} from "react-native-reanimated"

import MiniappHost, {miniappHost} from "@/components/miniapp/MiniappHost"
import CapsuleMenu from "@/effects/CapsuleMenu"
import {launchLocalMiniapp} from "@/services/miniapps/launchLocalMiniapp"
import {useAppStatusStore, useForegroundMiniApp} from "@mentra/island"

const EDGE_HIT_WIDTH = 24
const COMMIT_FRACTION = 0.4
const COMMIT_DURATION_MS = 220

export default function Compositor() {
  const foregroundApp = useForegroundMiniApp()
  const lastForegroundPkgRef = useRef<string | null>(null)

  useEffect(() => {
    const prev = lastForegroundPkgRef.current
    const next = foregroundApp?.packageName ?? null
    if (prev === next) return

    if (prev && prev !== next) {
      miniappHost.setBackground(prev)
    }
    if (foregroundApp) {
      void launchLocalMiniapp(foregroundApp, {
        onClose: () => useAppStatusStore.getState().clearForeground(),
        onBack: () => handleBack(foregroundApp.packageName),
      })
    }

    lastForegroundPkgRef.current = next
  }, [foregroundApp])

  const swipeTranslateX = useSharedValue(0)
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{translateX: swipeTranslateX.value}],
  }))

  const isForeground = foregroundApp != null
  const screenWidth = Dimensions.get("window").width
  const commitThreshold = screenWidth * COMMIT_FRACTION

  const swipeGesture = Gesture.Pan()
    .activeOffsetX(10)
    .failOffsetY([-15, 15])
    .onUpdate((e) => {
      if (Platform.OS !== "ios") return
      swipeTranslateX.value = Math.max(0, e.translationX)
    })
    .onEnd((e) => {
      if (Platform.OS !== "ios") {
        if (e.translationX > commitThreshold) {
          runOnJS(commitClose)()
        }
        return
      }
      if (e.translationX > commitThreshold) {
        swipeTranslateX.value = withTiming(screenWidth, {duration: COMMIT_DURATION_MS}, (finished) => {
          if (finished) runOnJS(commitClose)()
        })
      } else {
        swipeTranslateX.value = withSpring(0, {damping: 20, stiffness: 200, overshootClamping: true})
      }
    })

  // Reset translation whenever we re-enter foreground so a fresh launch
  // doesn't paint at the previous swipe-out offset.
  useEffect(() => {
    if (isForeground) swipeTranslateX.value = 0
  }, [isForeground, swipeTranslateX])

  return (
    <Animated.View
      pointerEvents={isForeground ? "auto" : "box-none"}
      style={[
        {position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 9999, elevation: 9999},
        animatedStyle,
      ]}>
      <MiniappHost />
      {isForeground && (
        <GestureDetector gesture={swipeGesture}>
          <View
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: EDGE_HIT_WIDTH,
              zIndex: 10000,
            }}
          />
        </GestureDetector>
      )}
      {isForeground && <CapsuleMenu forceShow={true} />}
    </Animated.View>
  )
}

function commitClose() {
  useAppStatusStore.getState().clearForeground()
}

function handleBack(packageName: string) {
  const wentBack = miniappHost.goBackInWebView(packageName)
  if (!wentBack) {
    useAppStatusStore.getState().clearForeground()
  }
}
