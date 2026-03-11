import {useFocusEffect} from "@react-navigation/native"
import {useCallback, useEffect, useRef} from "react"
import {ScrollView, View} from "react-native"
import {useSharedValue} from "react-native-reanimated"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {CustomBackground} from "@/components/home/CustomBackground"
import {ActiveForegroundApp} from "@/components/home/ActiveForegroundApp"
import {BackgroundAppsLink} from "@/components/home/BackgroundAppsLink"
import {CompactDeviceStatus} from "@/components/home/CompactDeviceStatus"
import {AppsGrid} from "@/components/home/AppsGrid"
import {IncompatibleApps} from "@/components/home/IncompatibleApps"
import {PairGlassesCard} from "@/components/home/PairGlassesCard"
import {Header, Screen} from "@/components/ignite"
import NonProdWarning from "@/components/home/NonProdWarning"
import {Group} from "@/components/ui"
import {useRefreshApplets} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useGlassesStore} from "@/stores/glasses"
import {useCoreStore} from "@/stores/core"
import WebsocketStatus from "@/components/error/WebsocketStatus"
import CoreStatusBar from "@/components/dev/CoreStatusBar"
import AppSwitcherButton from "@/components/home/AppSwitcherButtton"
import AppSwitcher from "@/components/home/AppSwitcher"
import {DeviceStatus} from "@/components/home/DeviceStatus"
import {attemptReconnectToDefaultWearable} from "@/effects/Reconnect"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import AllAppsGridSheet from "@/components/home/AllAppsGridSheet"
import BottomSheet from "@gorhom/bottom-sheet"
import {BlurTargetView} from "expo-blur"

export default function Homepage() {
  const refreshApplets = useRefreshApplets()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [offlineMode] = useSetting(SETTINGS.offline_mode.key)
  const [debugCoreStatusBarEnabled] = useSetting(SETTINGS.debug_core_status_bar.key)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const isSearching = useCoreStore((state) => state.searching)
  const hasAttemptedInitialConnect = useRef(false)
  const [appSwitcherUi] = useSetting(SETTINGS.app_switcher_ui.key)
  const swipeProgress = useSharedValue(0)
  const insets = useSaferAreaInsets()
  const bottomSheetRef = useRef<BottomSheet>(null)
  const blurTargetRef = useRef<View | null>(null)

  useFocusEffect(
    useCallback(() => {
      refreshApplets()
    }, [refreshApplets]),
  )

  useEffect(() => {
    const attemptInitialConnect = async () => {
      if (hasAttemptedInitialConnect.current) {
        return
      }
      let attempted = await attemptReconnectToDefaultWearable()
      if (attempted) {
        hasAttemptedInitialConnect.current = true
      }
    }

    attemptInitialConnect()
  }, [glassesConnected, isSearching, defaultWearable])

  const renderContent = () => {
    if (!defaultWearable) {
      return (
        <>
          {debugCoreStatusBarEnabled && <CoreStatusBar />}
          <Group>
            <PairGlassesCard />
          </Group>
          <View className="flex-1" />
          <AppsGrid />
        </>
      )
    }

    return (
      <>
        {debugCoreStatusBarEnabled && <CoreStatusBar />}
        <Group>
          {!appSwitcherUi && <CompactDeviceStatus />}
          {appSwitcherUi && <DeviceStatus />}
          {!offlineMode && !appSwitcherUi && <BackgroundAppsLink />}
        </Group>
        <View className="h-2" />
        {!appSwitcherUi && <ActiveForegroundApp />}
        <AppsGrid />
      </>
    )
  }

  const handleGridButtonPress = () => {
    bottomSheetRef.current?.expand()
  }

  return (
    <>
      <Screen preset="fixed" className={`${appSwitcherUi ? "px-0" : ""}`} KeyboardAvoidingViewProps={{enabled: true}}>
        <BlurTargetView ref={blurTargetRef} style={{flex: 1}}>
          {appSwitcherUi && <CustomBackground />}
          {!appSwitcherUi && (
            <Header
              leftTx="home:title"
              RightActionComponent={
                <View className="flex-row items-center flex-1 justify-end">
                  <WebsocketStatus />
                  <NonProdWarning />
                  <View className="w-2" />
                  <MentraLogoStandalone />
                </View>
              }
            />
          )}

          {/* {appSwitcherUi && (
        <View className="px-6 flex-row">
          <WebsocketStatus />
          <NonProdWarning />
        </View>
      )} */}

          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            showsVerticalScrollIndicator={false}
            contentContainerClassName={`${appSwitcherUi ? "px-6" : ""}`}
            contentContainerStyle={{flexGrow: 1}}
            scrollEventThrottle={16}>
            {appSwitcherUi && <View style={{paddingTop: insets.top}} />}
            <View className="h-4" />
            {renderContent()}
            <View className="h-4" />
            {!appSwitcherUi && <IncompatibleApps />}
            {/* spacer for scrolling to the bottom of the screen */}
            {/* {appSwitcherUi && <View className="h-25" />} */}
          </ScrollView>
        </BlurTargetView>
        {/* <View className="h-3 absolute bottom-0 w-screen bg-red-500 z-10" /> */}
        {appSwitcherUi && (
          <View className="px-6">
            <View className="">
              <AppSwitcherButton
                swipeProgress={swipeProgress}
                onGridButtonPress={handleGridButtonPress}
                blurTargetRef={blurTargetRef}
              />
            </View>
          </View>
        )}
        {appSwitcherUi && <AppSwitcher swipeProgress={swipeProgress} blurTargetRef={blurTargetRef} />}
      </Screen>
      {appSwitcherUi && <AllAppsGridSheet bottomSheetRef={bottomSheetRef} />}
    </>
  )
}
