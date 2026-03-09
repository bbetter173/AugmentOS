import {Image} from "expo-image"
import {StyleSheet, View} from "react-native"

import {SETTINGS, useSetting} from "@/stores/settings"

export function CustomBackground() {
  const [background] = useSetting<string>(SETTINGS.home_background.key)

  if (!background) return null

  return (
    <View className="absolute inset-0" pointerEvents="none">
      <Image source={{uri: background}} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
      <View className="absolute inset-0 bg-black/30" />
    </View>
  )
}
