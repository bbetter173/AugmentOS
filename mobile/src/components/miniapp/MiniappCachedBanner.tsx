import {useEffect, useState} from "react"
import {Animated, Pressable, View, ViewStyle} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"

import {Text} from "@/components/ignite"

const VISIBLE_MS = 5_000
const FADE_MS = 220

/**
 * Native overlay banner shown above the WebView when a dev miniapp is
 * mounted in cached mode (dev server unreachable at mount time).
 *
 * Auto-dismisses after 5 seconds; tap to dismiss earlier. Mounted as a
 * sibling of the WebView in MiniappHost — not injected into the miniapp's
 * DOM — so it never collides with the miniapp's own UI.
 */
export function MiniappCachedBanner() {
  const insets = useSafeAreaInsets()
  const [visible, setVisible] = useState(true)
  const [opacity] = useState(() => new Animated.Value(0))

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: FADE_MS,
      useNativeDriver: true,
    }).start()
    const timer = setTimeout(() => fadeOut(), VISIBLE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fadeOut = () => {
    Animated.timing(opacity, {
      toValue: 0,
      duration: FADE_MS,
      useNativeDriver: true,
    }).start(() => setVisible(false))
  }

  if (!visible) return null

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        $wrapper,
        {
          top: insets.top + 8,
          opacity,
        },
      ]}>
      <Pressable onPress={fadeOut} style={$pill} hitSlop={8}>
        <View style={$dot} />
        <Text style={$text} text="Running cached version — dev server offline" />
      </Pressable>
    </Animated.View>
  )
}

const $wrapper: ViewStyle = {
  position: "absolute",
  left: 12,
  right: 12,
  alignItems: "center",
  zIndex: 10000,
}

const $pill: ViewStyle = {
  flexDirection: "row",
  alignItems: "center",
  gap: 8,
  paddingHorizontal: 12,
  paddingVertical: 8,
  borderRadius: 999,
  backgroundColor: "rgba(20, 20, 20, 0.92)",
  shadowColor: "#000",
  shadowOpacity: 0.25,
  shadowRadius: 8,
  shadowOffset: {width: 0, height: 4},
  elevation: 6,
  maxWidth: 360,
}

const $dot: ViewStyle = {
  width: 8,
  height: 8,
  borderRadius: 4,
  backgroundColor: "#F97316", // orange-500, matches the dev-miniapp badge
}

const $text = {
  color: "#fff",
  fontSize: 12,
  fontWeight: "600" as const,
  flexShrink: 1,
}
