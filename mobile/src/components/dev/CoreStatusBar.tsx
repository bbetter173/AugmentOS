import {ScrollView, View} from "react-native"
import {useRef, useEffect} from "react"

import {Icon, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useCoreStore} from "@/stores/core"
import {useDebugStore} from "@/stores/debug"
import {useGlassesStore} from "@/stores/glasses"
import GlassView from "@/components/ui/GlassView"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"

function Tag({icon, label, bg}: {icon: string; label: string; bg: string}) {
  const {theme} = useAppTheme()
  return (
    <View className={`flex-row items-center px-1.5 rounded-full ${bg} mx-0.5`}>
      <Icon name={icon} size={10} color={theme.colors.secondary_foreground} />
      <Text className="text-secondary-foreground font-medium ml-0.5" style={{fontSize: 9, lineHeight: 12}}>
        {label}
      </Text>
    </View>
  )
}

export default function CoreStatusBar() {
  const searching = useCoreStore((state) => state.searching)
  const micRanking = useCoreStore((state) => state.micRanking)
  const currentMic = useCoreStore((state) => state.currentMic)
  const systemMicUnavailable = useCoreStore((state) => state.systemMicUnavailable)
  const micDataRecvd = useDebugStore((state) => state.micDataRecvd)
  const btcConnected = useGlassesStore((state) => state.btcConnected)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const glassesFullyBooted = useGlassesStore((state) => state.fullyBooted)
  const insets = useSaferAreaInsets()


  return (
    <View
      style={{top: insets.top - 24}}
      className="absolute z-11 bg-primary-transparent rounded-lg items-center self-center w-full px-1.5">
      <View className="flex-row justify-between">
        <View className="flex-row flex-wrap items-center justify-center w-1/2 justify-start">
          <Tag icon="bluetooth" label={searching ? "Searching" : "Not searching"} bg="bg-chart-4" />
          <Tag icon="microphone" label={currentMic || "None"} bg="bg-chart-3" />
          <Tag icon="microphone" label={micRanking.join(", ")} bg="bg-primary" />
          {systemMicUnavailable && <Tag icon="unplug" label="SMIC unavailable!" bg="bg-destructive" />}
        </View>
        <View className="flex-row flex-wrap items-center justify-center w-1/2 justify-end">
          <Tag icon="bluetooth" label={glassesFullyBooted ? "Booted" : "Not booted"} bg="bg-primary" />
          <Tag
            icon="bluetooth"
            label={btcConnected ? "BTC" : "BTC Off"}
            bg={btcConnected ? "bg-primary" : "bg-destructive"}
          />
          <Tag icon="bluetooth" label={glassesConnected ? "Connected" : "Disconnected"} bg="bg-primary" />
          <Tag
            icon={micDataRecvd ? "microphone" : "unplug"}
            label={micDataRecvd ? "PCM" : "No PCM"}
            bg={micDataRecvd ? "bg-primary" : "bg-destructive"}
          />
        </View>
      </View>
    </View>
  )
}
