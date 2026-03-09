// components/ui/OptionList.tsx
import {TouchableOpacity, ViewStyle} from "react-native"
import {View} from "react-native"

import {Icon, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {Group} from "@/components/ui/Group"
import {useAppTheme} from "@/contexts/ThemeContext"
import {Badge} from "@/components/ui"

interface Option<T extends string> {
  key: T
  label: string
  subtitle?: string
  badge?: string
}

interface OptionListProps<T extends string> {
  options: Option<T>[]
  selected: T
  onSelect: (key: T) => void
  title?: string
  style?: ViewStyle
}

const OptionItem = <T extends string>({
  option,
  selected,
  onSelect,
  style,
}: {
  option: Option<T>
  selected: T
  onSelect: (key: T) => void
  style?: ViewStyle
}) => {
  const {theme} = useAppTheme()

  return (
    <TouchableOpacity onPress={() => onSelect(option.key)}>
      <GlassView className="flex-row justify-between items-center py-5 px-6 bg-primary-foreground" style={style}>
        <View className="gap-1 flex-col">
          <View className="flex-row items-center gap-2">
            <Text text={option.label} className="text-text" />
            {option.badge && <Badge text={option.badge} />}
          </View>
          {option.subtitle && <Text text={option.subtitle} className="text-muted-foreground text-sm" />}
        </View>
        <Icon
          name="check"
          size={24}
          color={selected === option.key ? theme.colors.primary : theme.colors.palette.transparent}
        />
      </GlassView>
    </TouchableOpacity>
  )
}

export const OptionList = <T extends string>({options, selected, onSelect, title, style}: OptionListProps<T>) => (
  <Group title={title} style={style}>
    {options.map((option) => (
      <OptionItem key={option.key} option={option} selected={selected} onSelect={onSelect} />
    ))}
  </Group>
)
