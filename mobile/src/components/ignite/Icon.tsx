import {createIconSet, MaterialCommunityIcons} from "@expo/vector-icons"
import glyphMap from "@assets/icons/tabler/glyph-map.json"
import type {ComponentType} from "react"
import {
  Bell,
  CircleUser,
  CircleX,
  Cog,
  Ellipsis,
  ExternalLink,
  FileType2,
  Fullscreen,
  Glasses,
  Grid3X3,
  Info,
  LayoutDashboard,
  Locate,
  Minus,
  PauseIcon,
  PlayIcon,
  PointerIcon,
  Share,
  Unlink,
  Unplug,
  UserRound,
  Wifi,
  WifiOff,
} from "lucide-react-native"
import {
  ColorValue,
  ImageStyle,
  StyleProp,
  TextStyle,
  TouchableOpacity,
  TouchableOpacityProps,
  View,
  ViewProps,
  ViewStyle,
} from "react-native"

import {GridIcon, HomeIcon, ShoppingBagIcon} from "@/components/icons"
import {useAppTheme} from "@/contexts/ThemeContext"

const TablerIcon = createIconSet(glyphMap, "tablerIcons", "tabler-icons.ttf")

const lucideIcons = {
  bell: Bell,
  "circle-user": CircleUser,
  "circle-x": CircleX,
  cog: Cog,
  ellipsis: Ellipsis,
  "external-link": ExternalLink,
  "file-type-2": FileType2,
  fullscreen: Fullscreen,
  glasses: Glasses,
  grid: GridIcon,
  "grid-3x3": Grid3X3,
  house: HomeIcon,
  "house-filled": HomeIcon,
  info: Info,
  "layout-dashboard": LayoutDashboard,
  locate: Locate,
  minus: Minus,
  pause: PauseIcon,
  play: PlayIcon,
  pointer: PointerIcon,
  share: Share,
  "shopping-bag": ShoppingBagIcon,
  "shopping-bag-filled": ShoppingBagIcon,
  unlink: Unlink,
  unplug: Unplug,
  "user-round": UserRound,
  "user-round-filled": UserRound,
  wifi: Wifi,
  "wifi-off": WifiOff,
}

const iconAliases = {
  alert: "alert-triangle",
  caretRight: "caret-right",
  hidden: "eye-off",
  spinner: "loader-2",
  view: "eye",
  warning: "alert-triangle",
} as const satisfies Record<string, TablerIconName>

const materialCommunityIcons = {
  "checkbox-blank-circle-outline": true,
  "check-circle": true,
  "download-circle-outline": true,
  "image-outline": true,
} as const

export const iconRegistry = {
  ...glyphMap,
  ...lucideIcons,
  ...iconAliases,
  ...materialCommunityIcons,
}

type TablerIconName = keyof typeof glyphMap
type LucideIconName = keyof typeof lucideIcons
type IconAlias = keyof typeof iconAliases
type MaterialCommunityIconName = keyof typeof materialCommunityIcons
export type IconTypes = keyof typeof iconRegistry

type BaseIconProps = {
  /** The name of the icon. */
  name?: IconTypes
  /** Legacy prop accepted by older call sites. */
  icon?: IconTypes
  /** An optional tint color for the icon. */
  color?: ColorValue
  /** An optional background color for the icon. */
  backgroundColor?: string
  /** An optional size for the icon. If not provided, the icon will be sized to the icon's resolution. */
  size?: number
  /** Style overrides for the icon image. */
  style?: StyleProp<ImageStyle>
  /** Style overrides for the icon container. */
  containerStyle?: StyleProp<ViewStyle>
}

type PressableIconProps = Omit<TouchableOpacityProps, "style"> & BaseIconProps
type IconProps = Omit<ViewProps, "style"> & BaseIconProps
type RenderableIconComponent = ComponentType<{
  style?: StyleProp<ImageStyle>
  size?: number
  color?: ColorValue
  fill?: ColorValue
}>

export function PressableIcon(props: PressableIconProps) {
  const {name, icon, color, size, containerStyle: $containerStyleOverride, ...pressableProps} = props

  const {theme} = useAppTheme()

  return (
    <TouchableOpacity {...pressableProps} style={$containerStyleOverride}>
      <Icon name={name ?? icon} size={size} color={color ?? theme.colors.secondary_foreground} />
    </TouchableOpacity>
  )
}

export function Icon(props: IconProps) {
  const {
    name,
    icon,
    color,
    backgroundColor,
    size,
    style: $imageStyleOverride,
    containerStyle: $containerStyleOverride,
    ...viewProps
  } = props

  const {theme} = useAppTheme()
  const iconName = resolveIconName(name ?? icon)
  const iconColor = color ?? theme.colors.text

  const $imageStyle: StyleProp<ImageStyle> = [
    $imageStyleBase,
    {tintColor: iconColor},
    size !== undefined && {width: size, height: size},
    $imageStyleOverride,
  ]

  const $textStyle: StyleProp<TextStyle> = [
    size !== undefined && {fontSize: size, lineHeight: size, width: size, height: size},
  ]

  if (iconName && isLucideIconName(iconName)) {
    const IconComponent = lucideIcons[iconName] as RenderableIconComponent

    return (
      <View {...viewProps} style={[$containerStyleOverride, $iconCenterStyle]}>
        <IconComponent style={$imageStyle} size={size} color={iconColor} fill={backgroundColor ?? "transparent"} />
      </View>
    )
  }

  if (iconName && isTablerIconName(iconName)) {
    return (
      <View {...viewProps} style={[$containerStyleOverride, $iconCenterStyle]}>
        <TablerIcon style={$textStyle} name={iconName} size={size} color={iconColor} />
      </View>
    )
  }

  if (iconName && isMaterialCommunityIconName(iconName)) {
    return (
      <View {...viewProps} style={[$containerStyleOverride, $iconCenterStyle]}>
        <MaterialCommunityIcons style={$textStyle} name={iconName} size={size} color={iconColor} />
      </View>
    )
  }

  return <View {...viewProps} style={[$containerStyleOverride, $iconCenterStyle]} />
}

function resolveIconName(name: IconTypes | undefined): IconTypes | undefined {
  if (!name) return undefined
  return isIconAlias(name) ? iconAliases[name] : name
}

function isIconAlias(name: IconTypes): name is IconAlias {
  return name in iconAliases
}

function isLucideIconName(name: IconTypes): name is LucideIconName {
  return name in lucideIcons
}

function isTablerIconName(name: IconTypes): name is TablerIconName {
  return name in glyphMap
}

function isMaterialCommunityIconName(name: IconTypes): name is MaterialCommunityIconName {
  return name in materialCommunityIcons
}

const $iconCenterStyle: ViewStyle = {}

const $imageStyleBase: ImageStyle = {
  resizeMode: "contain",
}
