import CrustModule from "crust"
import {shallow} from "zustand/shallow"

import mentraBluetoothSdkAdapter from "@/services/bluetooth/MentraBluetoothSdkAdapter"
import {RemovableSubscription, toRemovableSubscription} from "@/services/bluetooth/subscriptions"
import {SETTINGS, useSettingsStore} from "@/stores/settings"

export const syncInitialBluetoothSettingsToNative = async () => {
  const initialBluetoothSdkSettings = useSettingsStore.getState().getBluetoothSdkSettings()
  await mentraBluetoothSdkAdapter.updateSettings(initialBluetoothSdkSettings)
}

export const syncNotificationSettingsToCrust = async () => {
  const settings = useSettingsStore.getState()
  const notificationsEnabled = Boolean(settings.getSetting(SETTINGS.notifications_enabled.key))
  const notificationsBlocklist = settings.getSetting(SETTINGS.notifications_blocklist.key)
  await CrustModule.setNotificationConfig(
    notificationsEnabled,
    Array.isArray(notificationsBlocklist) ? notificationsBlocklist : [],
  )
}

export const subscribeBluetoothSettingsToNative = (): RemovableSubscription =>
  toRemovableSubscription(
    useSettingsStore.subscribe(
      (state) => state.getBluetoothSdkSettings(),
      (state: Record<string, any>, previousState: Record<string, any>) => {
        const bluetoothSdkSettingsObj: Record<string, any> = {}

        for (const key in state) {
          const k = key as keyof Record<string, any>
          if (state[k] !== previousState[k]) {
            bluetoothSdkSettingsObj[k] = state[k] as any
          }
        }
        // console.log("MANTLE: Bluetooth SDK settings changed", bluetoothSdkSettingsObj)
        mentraBluetoothSdkAdapter.updateSettings(bluetoothSdkSettingsObj)
      },
      {equalityFn: shallow},
    ),
  )

export const subscribeNotificationSettingsToCrust = (): RemovableSubscription =>
  toRemovableSubscription(
    useSettingsStore.subscribe(
      (state) => ({
        notificationsEnabled: state.getSetting(SETTINGS.notifications_enabled.key),
        notificationsBlocklist: state.getSetting(SETTINGS.notifications_blocklist.key),
      }),
      async () => {
        await syncNotificationSettingsToCrust()
      },
      {equalityFn: shallow},
    ),
  )
