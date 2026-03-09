import {DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import CoreModule, {GlassesNotReadyEvent} from "core"
import {useState, useEffect} from "react"
import {ActivityIndicator, Image, ImageStyle, Linking, TouchableOpacity, View, ViewStyle} from "react-native"
import GlassView from "@/components/ui/GlassView"
import {Button, Icon, Text} from "@/components/ignite"
import ConnectedSimulatedGlassesInfo from "@/components/mirror/ConnectedSimulatedGlassesInfo"
import {Divider} from "@/components/ui/Divider"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import {showAlert} from "@/utils/AlertUtils"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"
import {
  getEvenRealitiesG1Image,
  getGlassesClosedImage,
  getGlassesImage,
  getGlassesOpenImage,
} from "@/utils/getGlassesImage"

import MicIcon from "assets/icons/component/MicIcon"
import {useCoreStore} from "@/stores/core"

const getBatteryIcon = (batteryLevel: number): string => {
  if (batteryLevel >= 75) return "battery-3"
  if (batteryLevel >= 50) return "battery-2"
  if (batteryLevel >= 25) return "battery-1"
  return "battery-0"
}

export const DeviceStatus = ({style}: {style?: ViewStyle}) => {
  const {themed, theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [isCheckingConnectivity, setIsCheckingConnectivity] = useState(false)
  const [autoBrightness, setAutoBrightness] = useSetting(SETTINGS.auto_brightness.key)
  const [brightness, setBrightness] = useSetting(SETTINGS.brightness.key)
  const [showSimulatedGlasses, setShowSimulatedGlasses] = useState(false)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const glassesFullyBooted = useGlassesStore((state) => state.fullyBooted)
  const glassesStyle = useGlassesStore((state) => state.style)
  const color = useGlassesStore((state) => state.color)
  const caseRemoved = useGlassesStore((state) => state.caseRemoved)
  const caseBatteryLevel = useGlassesStore((state) => state.caseBatteryLevel)
  const caseOpen = useGlassesStore((state) => state.caseOpen)
  const batteryLevel = useGlassesStore((state) => state.batteryLevel)
  const charging = useGlassesStore((state) => state.charging)
  const wifiConnected = useGlassesStore((state) => state.wifiConnected)
  const wifiSsid = useGlassesStore((state) => state.wifiSsid)
  const searching = useCoreStore((state) => state.searching)
  const [showGlassesBooting, setShowGlassesBooting] = useState(false)

  // Listen for glasses_not_ready event to know when glasses are actually booting
  useEffect(() => {
    const sub = CoreModule.addListener("glasses_not_ready", (_event: GlassesNotReadyEvent) => {
      setShowGlassesBooting(true)
    })
    return () => {
      sub.remove()
    }
  }, [])

  // Reset booting state when glasses become fully booted or disconnected
  useEffect(() => {
    if (glassesFullyBooted || !glassesConnected) {
      setShowGlassesBooting(false)
    }
  }, [glassesFullyBooted, glassesConnected])

  if (defaultWearable.includes(DeviceTypes.SIMULATED)) {
    return <ConnectedSimulatedGlassesInfo style={style} mirrorStyle={{backgroundColor: theme.colors.background}} />
  }

  const connectGlasses = async () => {
    if (!defaultWearable) {
      push("/pairing/select-glasses-model")
      return
    }

    // setIsCheckingConnectivity(true)

    try {
      const requirementsCheck = await checkConnectivityRequirementsUI()

      if (!requirementsCheck) {
        return
      }
    } catch (error) {
      console.error("connect to glasses error:", error)
      showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    } finally {
      // setIsCheckingConnectivity(false)
    }
    await CoreModule.connectDefault()
  }

  const handleConnectOrDisconnect = async () => {
    if (searching) {
      await CoreModule.disconnect()
      setIsCheckingConnectivity(false)
    } else {
      await connectGlasses()
    }
  }

  const getCurrentGlassesImage = () => {
    let image = getGlassesImage(defaultWearable)

    if (defaultWearable === DeviceTypes.G1) {
      let state = "folded"
      if (!caseRemoved) {
        state = caseOpen ? "case_open" : "case_close"
      }
      return getEvenRealitiesG1Image(glassesStyle, color, state, "l", theme.isDark, caseBatteryLevel)
    }

    if (!caseRemoved) {
      image = caseOpen ? getGlassesOpenImage(defaultWearable) : getGlassesClosedImage(defaultWearable)
    }

    return image
  }

  let isSearching = searching || isCheckingConnectivity
  let connectingText = translate("home:connectingGlasses")
  // Only show booting message when we've received a glasses_not_ready event
  if (showGlassesBooting) {
    connectingText = "Glasses are booting..."
  }

  const handleGetSupport = () => {
    showAlert(translate("home:getSupport"), translate("home:getSupportMessage"), [
      {text: translate("common:cancel"), style: "cancel"},
      {
        text: translate("common:continue"),
        onPress: () => Linking.openURL("https://mentraglass.com/contact"),
      },
    ])
  }

  if (!glassesConnected || !glassesFullyBooted || isSearching) {
    return (
      <TouchableOpacity style={[style]} onPress={() => push("/miniapps/settings/glasses")}>
        <GlassView className="bg-primary-foreground p-6 rounded-2xl">
          <View className="justify-between items-center flex-row">
            <Text className="font-semibold text-secondary-foreground text-lg" text={defaultWearable} />
            <Icon name="bluetooth-off" size={18} color={theme.colors.foreground} />
          </View>

          <View className="flex-row items-center justify-between">
            <Image source={getCurrentGlassesImage()} style={[themed($glassesImage)]} />
          </View>

          <Divider />
          <Spacer height={theme.spacing.s6} />

          <View className="flex-row gap-2">
            {!isSearching ? (
              <>
                <Button compact tx="home:getSupport" preset="alternate" onPress={handleGetSupport} />
                <Button compact flex tx="home:connectGlasses" preset="primary" onPress={connectGlasses} />
              </>
            ) : (
              <>
                <Button compactIcon flexContainer={false} preset="alternate" onPress={handleConnectOrDisconnect}>
                  <Icon name="x" size={20} color={theme.colors.foreground} />
                </Button>
                <Button
                  flex
                  compact
                  LeftAccessory={() => (
                    <ActivityIndicator size="small" color={theme.colors.primary_foreground} style={{marginRight: 8}} />
                  )}
                  text={connectingText}
                  // tx="home:connectingGlasses"
                />
              </>
            )}
          </View>
        </GlassView>
      </TouchableOpacity>
    )
  }

  const features = getModelCapabilities(defaultWearable)

  return (
    <TouchableOpacity onPress={() => push("/miniapps/settings/glasses")}>
      <GlassView className="bg-primary-foreground px-6 py-0 justify-center flex rounded-2xl flex-row max-h-20">
        <View className="flex-1 self-start">
          <Image source={getCurrentGlassesImage()} className="w-full h-full max-w-32" style={{resizeMode: "contain"}} />
        </View>

        <View className="justify-between items-end flex-col gap-2 py-5">
          <Text className="font-semibold text-secondary-foreground text-end self-end" text={defaultWearable} />
          <View className="flex-row items-center gap-3">
            {batteryLevel !== -1 && (
              <View className="flex-row items-center gap-1">
                <Icon
                  name={charging ? "battery-charging" : (getBatteryIcon(batteryLevel) as any)}
                  size={18}
                  color={theme.colors.foreground}
                />
                <Text className="text-secondary-foreground text-sm" text={`${batteryLevel}%`} />
              </View>
            )}
            <MicIcon width={18} height={18} />
            <Icon name="bluetooth-connected" size={18} color={theme.colors.foreground} />
            {features?.hasWifi &&
              (wifiConnected ? (
                <Button compactIcon className="bg-transparent -m-2" onPress={() => push("/wifi/scan")}>
                  <Icon name="wifi" size={18} color={theme.colors.foreground} />
                </Button>
              ) : (
                <Button compactIcon className="bg-transparent -m-2" onPress={() => push("/wifi/scan")}>
                  <Icon name="wifi-off" size={18} color={theme.colors.foreground} />
                </Button>
              ))}
          </View>
        </View>
      </GlassView>
    </TouchableOpacity>
  )
}

const $glassesImage: ThemedStyle<ImageStyle> = () => ({
  maxWidth: 180,
  height: 90,
  resizeMode: "contain",
})
