import {SETTINGS, useSetting} from "@/stores/settings"
import {GlassView as GlassViewComponent, GlassViewProps, isLiquidGlassAvailable} from "expo-glass-effect"
import {Platform, View, ViewProps} from "react-native"
import {withUniwind} from "uniwind"

interface NewGlassViewProps extends ViewProps {
  transparent?: boolean
}

const GlassWithStyle = withUniwind(GlassViewComponent)

const GlassView = ({children, style, transparent = true, ...props}: GlassViewProps & NewGlassViewProps) => {
  const [iosGlassEffect] = useSetting(SETTINGS.ios_glass_effect.key)
  let boxShadowStyle = "0px 8px 32px 0px rgba(0, 0, 0, 0.08)"
  if (iosGlassEffect && isLiquidGlassAvailable()) {
    if (transparent) {
      return (
        <GlassWithStyle
          style={[style, {backgroundColor: "transparent", boxShadow: boxShadowStyle}]}
          {...props}
          className="shadow-2xl">
          {children}
        </GlassWithStyle>
      )
    }
    return (
      <GlassWithStyle style={[style, {boxShadow: boxShadowStyle}]} {...props}>
        {children}
      </GlassWithStyle>
    )
  }
  if (Platform.OS === "android") {
    return (
      <GlassWithStyle style={[style, {boxShadow: boxShadowStyle}]} {...props}>
        {children}
      </GlassWithStyle>
    )
  }
  return (
    <View style={[style, {boxShadow: boxShadowStyle}]} {...props}>
      {children}
    </View>
  )
}

export default withUniwind(GlassView)
