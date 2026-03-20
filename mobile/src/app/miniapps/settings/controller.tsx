import {ScrollView, Image, View} from "react-native"

import {ConnectDeviceButton} from "@/components/glasses/ConnectDeviceButton"
import {NotConnectedInfo} from "@/components/glasses/info/NotConnectedInfo"
import {Header, Screen, Icon} from "@/components/ignite"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {getGlassesImage} from "@/utils/getGlassesImage"
import {Group} from "@/components/ui"
import {RouteButton} from "@/components/ui/RouteButton"

import {Capabilities, DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import CoreModule from "core"

import OtaProgressSection from "@/components/glasses/OtaProgressSection"
import {BatteryStatus} from "@/components/glasses/info/BatteryStatus"
import {EmptyState} from "@/components/glasses/info/EmptyState"
import {ButtonSettings} from "@/components/glasses/settings/ButtonSettings"
import BrightnessSetting from "@/components/settings/BrightnessSetting"
import {useApplets, useAppletStatusStore} from "@/stores/applets"
// import showAlert from "@/utils/AlertUtils"
import {showAlert} from "@/contexts/ModalContext"

function DeviceSettings() {
  const {theme} = useAppTheme()
  const [defaultController] = useSetting(SETTINGS.default_controller.key)
  const [autoBrightness, setAutoBrightness] = useSetting(SETTINGS.auto_brightness.key)
  const [brightness, setBrightness] = useSetting(SETTINGS.brightness.key)
  const [defaultButtonActionEnabled, setDefaultButtonActionEnabled] = useSetting(
    SETTINGS.default_button_action_enabled.key,
  )
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const [defaultButtonActionApp, setDefaultButtonActionApp] = useSetting(SETTINGS.default_button_action_app.key)
  const glassesConnected = useGlassesStore((state) => state.connected)

  const {push, goBack} = useNavigationHistory()
  const applets = useApplets()
  const features: Capabilities = getModelCapabilities(defaultController)

  const wifiLocalIp = useGlassesStore((state) => state.wifiSsid)
  const bluetoothName = useGlassesStore((state) => state.bluetoothName)
  const buildNumber = useGlassesStore((state) => state.buildNumber)
  const otaProgress = useGlassesStore((state) => state.otaProgress)

  const hasDeviceInfo = Boolean(bluetoothName || buildNumber || wifiLocalIp)

  const confirmForgetGlasses = async () => {
    let result = await showAlert({
      title: translate("settings:forgetGlasses"),
      message: translate("settings:forgetGlassesConfirm"),
      buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("connection:unpair")}],
      options: {allowDismiss: false},
    })
    if (result === 1) {
      CoreModule.forget()
      useAppletStatusStore.getState().stopAllApplets()
      useAppletStatusStore.getState().refreshApplets()
      // give us a second to forget the glasses before going back
      setTimeout(() => {
        goBack()
      }, 500)
    }
  }

  const confirmDisconnectGlasses = async () => {
    let result = await showAlert({
      title: translate("settings:disconnectGlassesTitle"),
      message: translate("settings:disconnectGlassesConfirm"),
      buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("connection:disconnect")}],
      options: {allowDismiss: false},
    })

    if (result === 1) {
      CoreModule.disconnect()
    }
  }

  // Check if no glasses are paired at all
  if (!defaultController) {
    return <EmptyState />
  }

  return (
    <View className="gap-6">
      {superMode && (
        <RouteButton label={translate("settings:layoutSettings")} onPress={() => push("/miniapps/settings/layout")} />
      )}

      {/* this just gives the user a bit more space to scroll */}
      <Spacer height={theme.spacing.s2} />
    </View>
  )
}

export default function ControllerSettings() {
  const {theme} = useAppTheme()
  const [defaultController] = useSetting(SETTINGS.default_controller.key)
  const {goBack} = useNavigationHistory()
  const controllerConnected = useGlassesStore((state) => state.controllerConnected)

  const formatGlassesTitle = (title: string) => title.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
  let pageSubtitle
  let glassesComponent

  if (defaultController) {
    pageSubtitle = formatGlassesTitle(defaultController)
    if (defaultController !== DeviceTypes.SIMULATED) {
      glassesComponent = (
        <Image source={getGlassesImage(defaultController)} style={{width: 110, maxHeight: 32}} resizeMode="contain" />
      )
    }
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("deviceSettings:title")}
        subtitle={pageSubtitle}
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        RightActionComponent={glassesComponent}
      />
      <ScrollView className="pr-4 -mr-4" contentInsetAdjustmentBehavior="automatic">
        {!controllerConnected && <Spacer height={theme.spacing.s6} />}
        {/* Show helper text if glasses are paired but not connected */}
        {!controllerConnected && defaultController && <NotConnectedInfo />}
        <Spacer height={theme.spacing.s6} />
      </ScrollView>
    </Screen>
  )
}
