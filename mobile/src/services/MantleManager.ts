import type {ButtonPressEvent, GlassesStatus} from "@mentra/bluetooth-sdk"
import * as Calendar from "expo-calendar"
import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"
import {shallow} from "zustand/shallow"

import livekit from "@/services/Livekit"
import {migrate} from "@/services/Migrations"
import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import {gallerySyncService} from "@/services/asg/gallerySyncService"
import {
  registerBluetoothEventBridge,
  syncBluetoothStatusStoresFromNative,
} from "@/services/bluetooth/BluetoothEventBridge"
import {
  subscribeBluetoothSettingsToNative,
  subscribeNotificationSettingsToCrust,
  syncInitialBluetoothSettingsToNative,
  syncNotificationSettingsToCrust,
} from "@/services/bluetooth/BluetoothSettingsSync"
import {RemovableSubscription, toRemovableSubscription} from "@/services/bluetooth/subscriptions"
import {useDisplayStore} from "@/stores/display"
import {useGlassesStore, getGlasesInfoPartial} from "@/stores/glasses"
import {useSettingsStore, SETTINGS} from "@/stores/settings"
import TranscriptProcessor from "@/utils/TranscriptProcessor"
import {BackgroundTimer} from "@/utils/timers"
import {checkFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"
import {logE2EMetric} from "@/utils/e2eMetrics"

const LOCATION_TASK_NAME = "handleLocationUpdates"

// @ts-ignore
TaskManager.defineTask(LOCATION_TASK_NAME, ({data: {locations}, error}) => {
  if (error) {
    // check `error.message` for more details.
    // console.error("Error handling location updates", error)
    return
  }
  const locs = locations as Location.LocationObject[]
  if (locs.length === 0) {
    console.log("MANTLE: LOCATION: No locations received")
    return
  }

  // console.log("Received new locations", locations)
  const first = locs[0]!
  // socketComms.sendLocationUpdate(first.coords.latitude, first.coords.longitude, first.coords.accuracy ?? undefined)
  restComms.sendLocationData(first)
})

class MantleManager {
  private static instance: MantleManager | null = null
  private calendarSyncTimer: ReturnType<typeof BackgroundTimer.setInterval> | null = null
  private clearTextTimeout: ReturnType<typeof BackgroundTimer.setTimeout> | null = null
  private micDataTimeout: ReturnType<typeof BackgroundTimer.setTimeout> | null = null
  private MIC_TIMEOUT_MS: number = 1000
  private transcriptProcessor: TranscriptProcessor
  private subs: RemovableSubscription[] = []
  private initialized: boolean = false

  public static getInstance(): MantleManager {
    if (!MantleManager.instance) {
      MantleManager.instance = new MantleManager()
    }
    return MantleManager.instance
  }

  private constructor() {
    // Pass callback to send pending updates when timer fires
    this.transcriptProcessor = new TranscriptProcessor(() => {
      this.sendPendingTranscript()
    })
  }

  private sendPendingTranscript() {
    const pendingText = this.transcriptProcessor.getPendingUpdate()
    if (pendingText) {
      socketComms.handle_display_event({
        type: "display_event",
        view: "main",
        layout: {
          layoutType: "text_wall",
          text: pendingText,
        },
      })
    }
  }

  // run at app start on the init.tsx screen:
  // should only ever be run once
  // sets up the bridge and initializes app state
  public async init() {
    console.log("MANTLE: init()")

    if (this.initialized) {
      console.log("MANTLE: already initialized")
      return
    }
    this.initialized = true

    await migrate() // do any local migrations here
    const res = await restComms.loadUserSettings() // get settings from server
    if (res.is_ok()) {
      const loadedSettings = res.value
      await useSettingsStore.getState().setManyLocally(loadedSettings) // write settings to local storage
    } else {
      console.error("MANTLE: No settings received from server")
    }

    // Send device timezone to cloud (used for calendar/time display)
    this.syncTimezone()

    await syncInitialBluetoothSettingsToNative()
    await syncNotificationSettingsToCrust()
    console.log("MANTLE: Settings sent to Bluetooth SDK")

    this.initServices()
    this.setupPeriodicTasks()
    this.setupSubscriptions()
  }

  private async syncTimezone() {
    const timezone = useSettingsStore.getState().getSetting(SETTINGS.time_zone.key)
    const result = await restComms.writeUserSettings({time_zone: timezone, timezone: timezone})
    if (result.is_error()) {
      console.error("MANTLE: Failed to sync timezone:", result.error)
    } else {
      console.log("MANTLE: Timezone synced:", timezone)
    }
  }

  public async cleanup() {
    // Stop timers
    if (this.calendarSyncTimer) {
      clearInterval(this.calendarSyncTimer)
      this.calendarSyncTimer = null
    }
    // Remove all event subscriptions
    this.removeSubscriptions()

    Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
    this.transcriptProcessor.clear()

    livekit.disconnect()
    await socketComms.cleanup()
    restComms.goodbye()
  }

  private removeSubscriptions() {
    this.subs.forEach((sub) => sub.remove())
    this.subs = []
  }

  private initServices() {
    socketComms.connectWebsocket()
    gallerySyncService.initialize()
  }

  private async setupPeriodicTasks() {
    this.sendCalendarEvents()
    // Calendar sync every hour
    this.calendarSyncTimer = BackgroundTimer.setInterval(
      () => {
        this.sendCalendarEvents()
      },
      60 * 60 * 1000,
    ) // 1 hour

    try {
      // only start location updates if we have the location permission:
      const hasLocation = await checkFeaturePermissions(PermissionFeatures.LOCATION)
      if (hasLocation) {
        let locationAccuracy = await useSettingsStore.getState().getSetting(SETTINGS.location_tier.key)
        let properAccuracy = this.getLocationAccuracy(locationAccuracy)
        Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
          accuracy: properAccuracy,
        })
      }
    } catch (error) {
      console.error("MANTLE: Error starting location updates", error)
    }

    // check for requirements immediately, but only if we've passed through onboarding:
    // const onboardingCompleted = await useSettingsStore.getState().getSetting(SETTINGS.onboarding_completed.key)
    // if (onboardingCompleted) {
    //   try {
    //     const requirementsCheck = await checkConnectivityRequirementsUI()
    //     if (!requirementsCheck) {
    //       return
    //     }
    //     // give some time for the glasses to be fully ready:
    //     BackgroundTimer.setTimeout(async () => {
    //       await BluetoothSdk.connectDefault()
    //     }, 3000)
    //   } catch (error) {
    //     console.error("connect to glasses error:", error)
    //     showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    //   }
    // }
  }

  private async setupSubscriptions() {
    this.removeSubscriptions()

    this.subs.push(
      toRemovableSubscription(
        useGlassesStore.subscribe(
          getGlasesInfoPartial,
          (state: Partial<GlassesStatus>, previousState: Partial<GlassesStatus>) => {
            const statusObj: Partial<GlassesStatus> = {}

            for (const key in state) {
              const k = key as keyof GlassesStatus
              if (state[k] !== previousState[k]) {
                statusObj[k] = state[k] as any
              }
            }
            restComms.updateGlassesState(statusObj)
          },
          {equalityFn: shallow},
        ),
      ),
    )

    this.subs.push(subscribeBluetoothSettingsToNative())
    this.subs.push(subscribeNotificationSettingsToCrust())
    this.subs.push(
      ...registerBluetoothEventBridge({
        getMicDataTimeout: () => this.micDataTimeout,
        handleButtonPress: (event) => this.handle_button_press(event),
        handleHeadUp: (isUp) => this.handle_head_up(isUp),
        handleLocalTranscription: (event) => this.handle_local_transcription(event),
        micTimeoutMs: this.MIC_TIMEOUT_MS,
        setMicDataTimeout: (timeout) => {
          this.micDataTimeout = timeout
        },
      }),
    )

    await syncBluetoothStatusStoresFromNative()
  }

  private async sendCalendarEvents() {
    try {
      console.log("MANTLE: sendCalendarEvents()")
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)
      const calendarIds = calendars.map((calendar: Calendar.Calendar) => calendar.id)
      // from 2 hours ago to 1 week from now:
      const startDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
      const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      const events = await Calendar.getEventsAsync(calendarIds, startDate, endDate)
      restComms.sendCalendarData({events, calendars})
    } catch (error) {
      // it's fine if this fails
      console.log("MANTLE: Error sending calendar events", error)
    }
  }

  private async sendLocationUpdates() {
    console.log("MANTLE: sendLocationUpdates()")
    // const location = await Location.getCurrentPositionAsync()
    // socketComms.sendLocationUpdate(location)
  }

  public getLocationAccuracy(accuracy: string) {
    switch (accuracy) {
      case "realtime":
        return Location.LocationAccuracy.BestForNavigation
      case "tenMeters":
        return Location.LocationAccuracy.High
      case "hundredMeters":
        return Location.LocationAccuracy.Balanced
      case "kilometer":
        return Location.LocationAccuracy.Low
      case "threeKilometers":
        return Location.LocationAccuracy.Lowest
      case "reduced":
        return Location.LocationAccuracy.Lowest
      default:
        // console.error("MANTLE: unknown accuracy: " + accuracy)
        return Location.LocationAccuracy.Lowest
    }
  }

  public async setLocationTier(tier: string) {
    console.log("MANTLE: setLocationTier()", tier)
    // restComms.sendLocationData({tier})
    try {
      const accuracy = this.getLocationAccuracy(tier)
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: accuracy,
        pausesUpdatesAutomatically: false,
      })
    } catch (error) {
      console.log("MANTLE: Error setting location tier", error)
    }
  }

  public async requestSingleLocation(accuracy: string, correlationId: string) {
    console.log("MANTLE: requestSingleLocation()")
    // restComms.sendLocationData({tier})
    try {
      const location = await Location.getCurrentPositionAsync({accuracy: this.getLocationAccuracy(accuracy)})
      socketComms.sendLocationUpdate(
        location.coords.latitude,
        location.coords.longitude,
        location.coords.accuracy ?? undefined,
        correlationId,
      )
    } catch (error) {
      console.log("MANTLE: Error requesting single location", error)
    }
  }

  // mostly for debugging / local stt:
  public async displayTextMain(text: string) {
    logE2EMetric("display_text_main", {
      text,
      line_count: text.split("\n").length,
    })
    this.resetDisplayTimeout()
    socketComms.handle_display_event({
      type: "display_event",
      view: "main",
      layout: {
        layoutType: "text_wall",
        text: text,
      },
    })
  }

  public async handle_head_up(isUp: boolean) {
    socketComms.sendHeadPosition(isUp)

    // Only switch to dashboard view if contextual dashboard is enabled
    // Otherwise, always show main view regardless of head position
    const contextualDashboardEnabled = await useSettingsStore.getState().getSetting(SETTINGS.contextual_dashboard.key)

    if (isUp && contextualDashboardEnabled) {
      useDisplayStore.getState().setView("dashboard")
    } else {
      useDisplayStore.getState().setView("main")
    }
  }

  public async resetDisplayTimeout() {
    if (this.clearTextTimeout) {
      // console.log("MANTLE: canceling pending timeout")
      BackgroundTimer.clearTimeout(this.clearTextTimeout)
    }
    this.clearTextTimeout = BackgroundTimer.setTimeout(() => {
      console.log("MANTLE: clearing text from wall")
    }, 10000) // 10 seconds
  }

  public async handle_local_transcription(data: any) {
    logE2EMetric("local_transcription_received", {
      text: data?.text ?? "",
      is_final: data?.isFinal ?? false,
      language: data?.transcribeLanguage ?? "",
    })

    // TODO: performance!
    const offlineStt = await useSettingsStore.getState().getSetting(SETTINGS.offline_captions_running.key)
    if (offlineStt) {
      this.transcriptProcessor.changeLanguage(data.transcribeLanguage)
      const processedText = this.transcriptProcessor.processString(data.text, data.isFinal ?? false)

      logE2EMetric("local_transcription_processed", {
        text: data?.text ?? "",
        processed_text: processedText ?? "",
        is_final: data?.isFinal ?? false,
      })

      // Scheduling timeout to clear text from wall. In case of online STT online dashboard manager will handle it.
      // if (data.isFinal) {
      //   this.resetDisplayTimeout()
      // }

      if (processedText) {
        this.displayTextMain(processedText)
      }

      return
    }

    socketComms.sendLocalTranscription(data)
  }

  public async handle_button_press(event: ButtonPressEvent) {
    socketComms.sendButtonPress(event.buttonId, event.pressType)
  }
}

const mantle = MantleManager.getInstance()
export default mantle
