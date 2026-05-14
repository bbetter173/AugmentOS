import {TextStyle, View, ViewStyle} from "react-native"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ThemedStyle} from "@/theme"

type InfoSectionItem = {
  label: string
  value?: string | number | null
}

type InfoSectionProps = {
  title: string
  items: InfoSectionItem[]
  style?: ViewStyle
}

export default function InfoSection({title, items, style}: InfoSectionProps) {
  const {themed} = useAppTheme()

  return (
    <View style={[themed($container), style]}>
      <Text text={title} weight="semibold" style={themed($title)} />
      {items.map((item) => (
        <View key={item.label} style={themed($row)}>
          <Text text={item.label} style={themed($label)} />
          <Text text={item.value == null ? "" : String(item.value)} style={themed($value)} />
        </View>
      ))}
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  padding: spacing.s4,
})

const $title: ThemedStyle<TextStyle> = ({spacing}) => ({
  marginBottom: spacing.s3,
})

const $row: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  gap: spacing.s4,
  paddingVertical: spacing.s2,
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
})

const $value: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  flexShrink: 1,
  textAlign: "right",
})
