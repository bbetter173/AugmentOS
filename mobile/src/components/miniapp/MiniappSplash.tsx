/**
 * MiniappSplash — covers the WebView while it boots. Shows just the miniapp
 * icon centered on the host's background color. Styled to match AppIcon on
 * the home screen: 128px squircle with memory-disk image caching.
 */

import {Image} from "expo-image"
import {SquircleView} from "expo-squircle-view"
import {StyleSheet, View} from "react-native"

import {useAppTheme} from "@/contexts/ThemeContext"

interface MiniappSplashProps {
  iconUrl?: string
  bgColor: string
}

export default function MiniappSplash({iconUrl, bgColor}: MiniappSplashProps) {
  const {theme} = useAppTheme()
  const size = 128
  const borderRadius = theme.spacing.s3

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.root, {backgroundColor: bgColor}]}>
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
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    justifyContent: "center",
  },
})
