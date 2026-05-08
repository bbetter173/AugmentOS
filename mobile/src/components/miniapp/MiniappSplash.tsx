/**
 * MiniappSplash — covers the WebView while it boots. Shows just the miniapp
 * icon centered on the host's background color. Styled to match AppIcon on
 * the home screen: 128px squircle with memory-disk image caching.
 *
 * Fades + scales in on mount so foregrounding feels like a soft zoom rather
 * than a hard cut.
 */

import {Image} from "expo-image"
import {SquircleView} from "expo-squircle-view"
import {useEffect} from "react"
import {StyleSheet} from "react-native"
import Animated, {useAnimatedStyle, useSharedValue, withTiming} from "react-native-reanimated"

import {useAppTheme} from "@/contexts/ThemeContext"

interface MiniappSplashProps {
  iconUrl?: string
  bgColor: string
}

const FADE_DURATION_MS = 200
const SCALE_FROM = 0.96

export default function MiniappSplash({iconUrl, bgColor}: MiniappSplashProps) {
  const {theme} = useAppTheme()
  const size = 128
  const borderRadius = theme.spacing.s3

  const opacity = useSharedValue(0)
  const scale = useSharedValue(SCALE_FROM)

  useEffect(() => {
    opacity.value = withTiming(1, {duration: FADE_DURATION_MS})
    scale.value = withTiming(1, {duration: FADE_DURATION_MS})
  }, [opacity, scale])

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{scale: scale.value}],
  }))

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.root, {backgroundColor: bgColor}, animatedStyle]}>
      {iconUrl && (
        <SquircleView
          cornerSmoothing={100}
          preserveSmoothing={true}
          style={{
            width: size,
            height: size,
            borderRadius,
            overflow: "hidden",
            alignItems: "center",
            justifyContent: "center",
          }}>
          <Image
            source={iconUrl}
            style={{width: "100%", height: "100%"}}
            contentFit="cover"
            transition={200}
            cachePolicy="memory-disk"
          />
        </SquircleView>
      )}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    justifyContent: "center",
  },
})
