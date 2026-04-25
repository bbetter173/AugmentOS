import type {ButtonPressEvent, BluetoothStatus} from "@mentra/bluetooth-sdk"
import CrustModule from "crust"

import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import udp from "@/services/UdpManager"
import mentraBluetoothSdkAdapter from "@/services/bluetooth/MentraBluetoothSdkAdapter"
import {RemovableSubscription, toRemovableSubscription} from "@/services/bluetooth/subscriptions"
import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import {useAppletStatusStore} from "@/stores/applets"
import {useBluetoothStore} from "@/stores/bluetooth"
import {useDebugStore} from "@/stores/debug"
import {useGlassesStore} from "@/stores/glasses"
import {useSettingsStore} from "@/stores/settings"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {syncDashboardMenu} from "@/utils/glassesMenu"
import {BackgroundTimer} from "@/utils/timers"

type MicDataTimeout = ReturnType<typeof BackgroundTimer.setTimeout> | null

export type BluetoothEventBridgeHandlers = {
  getMicDataTimeout: () => MicDataTimeout
  handleButtonPress: (event: ButtonPressEvent) => void | Promise<void>
  handleHeadUp: (isUp: boolean) => void | Promise<void>
  handleLocalTranscription: (event: any) => void | Promise<void>
  micTimeoutMs: number
  setMicDataTimeout: (timeout: MicDataTimeout) => void
}

export const registerBluetoothEventBridge = (handlers: BluetoothEventBridgeHandlers): RemovableSubscription[] => {
  const subscriptions: RemovableSubscription[] = []
  const addSubscription = (subscription: Parameters<typeof toRemovableSubscription>[0]) => {
    subscriptions.push(toRemovableSubscription(subscription))
  }

  // Forward Bluetooth SDK status changes to the zustand Bluetooth store.
  addSubscription(
    mentraBluetoothSdkAdapter.onBluetoothStatus((changed: Partial<BluetoothStatus>) => {
      // console.log("MANTLE: Bluetooth SDK status changed", changed)
      useBluetoothStore.getState().setBluetoothStatus(changed)
    }),
  )
  addSubscription(
    mentraBluetoothSdkAdapter.onGlassesStatus((changed) => {
      // console.log("MANTLE: Glasses status changed", changed)
      useGlassesStore.getState().setGlassesInfo(changed)
    }),
  )

  // Subscribe to individual core events.
  addSubscription(
    mentraBluetoothSdkAdapter.addListener("log", (event) => {
      console.log("CORE:", event.message)
    }),
  )

  // TODO: remove since we can sub to the zustand store for wifi info:
  addSubscription(
    mentraBluetoothSdkAdapter.addListener("hotspot_status_change", (event) => {
      useGlassesStore.getState().setHotspotInfo(event.enabled, event.ssid, event.password, event.local_ip)
      GlobalEventEmitter.emit("hotspot_status_change", {
        enabled: event.enabled,
        ssid: event.ssid,
        password: event.password,
        local_ip: event.local_ip,
      })
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("hotspot_error", (event) => {
      GlobalEventEmitter.emit("hotspot_error", {
        error_message: event.error_message,
        timestamp: event.timestamp,
      })
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("gallery_status", (event) => {
      GlobalEventEmitter.emit("gallery_status", {
        photos: event.photos,
        videos: event.videos,
        total: event.total,
        has_content: event.has_content,
        camera_busy: event.camera_busy,
      })
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("photo_response", (event) => {
      restComms.sendPhotoResponse(event)
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("heartbeat_sent", (event) => {
      console.log("MANTLE: received heartbeat_sent event from Bluetooth SDK", event.heartbeat_sent)
      // TODO: remove the global event emitter and sub directly in the component where needed
      GlobalEventEmitter.emit("heartbeat_sent", {
        timestamp: event.heartbeat_sent.timestamp,
      })
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("heartbeat_received", (event) => {
      console.log("MANTLE: received heartbeat_received event from Bluetooth SDK", event.heartbeat_received)
      // TODO: remove the global event emitter and sub directly in the component where needed
      GlobalEventEmitter.emit("heartbeat_received", {
        timestamp: event.heartbeat_received.timestamp,
      })
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("button_press", (event) => {
      console.log("MANTLE: BUTTON_PRESS event received:", event)
      handlers.handleButtonPress(event)
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("touch_event", (event) => {
      const deviceModel = event.device_model ?? "Mentra Live"
      const gestureName = event.gesture_name ?? "unknown"
      const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now()
      socketComms.sendTouchEvent({
        device_model: deviceModel,
        gesture_name: gestureName,
        timestamp,
      })
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("swipe_volume_status", (event) => {
      const enabled = !!event.enabled
      const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now()
      socketComms.sendSwipeVolumeStatus(enabled, timestamp)
      // TODO: remove
      GlobalEventEmitter.emit("SWIPE_VOLUME_STATUS", {enabled, timestamp})
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("switch_status", (event) => {
      const switchType = typeof event.switch_type === "number" ? event.switch_type : (event.switchType ?? -1)
      const switchValue = typeof event.switch_value === "number" ? event.switch_value : (event.switchValue ?? -1)
      const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now()
      socketComms.sendSwitchStatus(switchType, switchValue, timestamp)
      // TODO: remove
      GlobalEventEmitter.emit("SWITCH_STATUS", {switchType, switchValue, timestamp})
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("rgb_led_control_response", (event) => {
      const requestId = event.requestId ?? ""
      const success = !!event.success
      const errorMessage = typeof event.error === "string" ? event.error : null
      socketComms.sendRgbLedControlResponse(requestId, success, errorMessage)
      // TODO: remove
      GlobalEventEmitter.emit("rgb_led_control_response", {requestId, success, error: errorMessage})
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("pair_failure", (event) => {
      GlobalEventEmitter.emit("pair_failure", event.error)
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("captions_tester_incident", (event) => {
      const failureCode = typeof event.failure_code === "string" ? event.failure_code : "unknown"
      const failureMessage =
        typeof event.failure_message === "string" ? event.failure_message : "Captions tester incident detected."
      const testRunId = typeof event.test_run_id === "string" ? event.test_run_id : undefined
      const scenarioName = typeof event.scenario_name === "string" ? event.scenario_name : undefined
      const alertId = typeof event.alert_id === "string" ? event.alert_id : testRunId

      const actualBehavior = JSON.stringify(
        {
          failureCode,
          failureMessage,
          testRunId,
          scenarioName,
          event,
        },
        null,
        2,
      )

      const dedupeKey = ["captions_tester", failureCode, scenarioName || "unknown", testRunId || "unknown"].join("|")

      void (async () => {
        const result = await submitAutomaticBugIncident({
          categorization: {
            submissionMode: "AUTOMATIC",
            triggerArea: "captions_tester",
            triggerReason: "captions_incident_detected",
          },
          expectedBehavior: "Captions tester runs should complete without a captions incident.",
          actualBehavior,
          severityRating: 4,
          dedupeKey,
          logTag: "CaptionsTesterBugReport",
        })

        console.log(
          `CAPTIONS_TESTER_INCIDENT_RESULT ${JSON.stringify({
            alert_id: alertId,
            test_run_id: testRunId,
            failure_code: failureCode,
            scenario_name: scenarioName,
            status: result.status,
            incident_id: result.status === "filed" ? result.incidentId : undefined,
            reason: result.status === "skipped" ? result.reason : undefined,
            error: result.status === "failed" ? result.error : undefined,
          })}`,
        )
      })()
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("audio_pairing_needed", (event) => {
      GlobalEventEmitter.emit("audio_pairing_needed", {
        deviceName: event.device_name,
      })
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("audio_connected", (event) => {
      GlobalEventEmitter.emit("audio_connected", {
        deviceName: event.device_name,
      })
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("audio_disconnected", () => {
      GlobalEventEmitter.emit("audio_disconnected", {})
    }),
  )

  // Allow the Bluetooth SDK to persist hardware-originated setting changes.
  addSubscription(
    mentraBluetoothSdkAdapter.addListener("save_setting", async (event) => {
      console.log("MANTLE: Received save_setting event from Bluetooth SDK:", event)
      await useSettingsStore.getState().setSetting(event.key, event.value)
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("head_up", (event) => {
      handlers.handleHeadUp(event.up)
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("vad_status", (event) => {
      socketComms.sendVadStatus(event.status)
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("battery_status", (event) => {
      socketComms.sendBatteryStatus(event.level, event.charging, event.timestamp)
    }),
  )

  // G2 dashboard menu: user selected a miniapp from the glasses swipe menu.
  // G2.swift resolves the numeric appId -> packageName before sending this event.
  addSubscription(
    mentraBluetoothSdkAdapter.addListener("miniapp_selected", (event) => {
      const packageName = event.packageName as string
      if (!packageName) return
      const applet = useAppletStatusStore.getState().apps.find((a) => a.packageName === packageName)
      if (!applet) return
      // Toggle: if already running, stop it; otherwise start it.
      if (applet.running) {
        console.log(`MANTLE: miniapp_selected - stopping ${packageName}`)
        useAppletStatusStore.getState().stopApplet(packageName)
      } else {
        console.log(`MANTLE: miniapp_selected - starting ${packageName}`)
        useAppletStatusStore.getState().startApplet(applet, {skipNavigation: true})
      }
    }),
  )

  // G2 dashboard menu: sync on glasses connect.
  addSubscription(
    useGlassesStore.subscribe(
      (state) => state.fullyBooted,
      async (fullyBooted) => {
        if (!fullyBooted) return
        await syncDashboardMenu()
      },
    ),
  )

  // G2 dashboard menu: re-sync when app list changes (handles app install/uninstall,
  // server refresh after connect, and race where apps weren't loaded on first connect).
  addSubscription(
    useAppletStatusStore.subscribe(async (state, prevState) => {
      if (state.apps !== prevState.apps && state.apps.length > 0) {
        await syncDashboardMenu()
      }
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("local_transcription", (event) => {
      handlers.handleLocalTranscription(event)
    }),
  )

  addSubscription(
    CrustModule.addListener("phone_notification", async (event) => {
      const res = await restComms.sendPhoneNotification({
        notificationId: event.notificationId,
        app: event.app,
        title: event.title,
        content: event.content,
        priority: event.priority.toString(),
        timestamp: parseInt(event.timestamp.toString()),
        packageName: event.packageName,
      })
      if (res.is_error()) {
        console.error("Failed to send phone notification:", res.error)
      }
    }),
  )

  addSubscription(
    CrustModule.addListener("phone_notification_dismissed", async (event) => {
      const res = await restComms.sendPhoneNotificationDismissed({
        notificationKey: event.notificationKey,
        packageName: event.packageName,
        notificationId: event.notificationId,
      })
      if (res.is_error()) {
        console.error("Failed to send phone notification dismissal:", res.error)
      }
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("ws_text", (event) => {
      socketComms.sendText(event.text)
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("ws_bin", (event) => {
      const binaryString = atob(event.base64)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }
      socketComms.sendBinary(bytes)
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("mic_lc3", (event) => {
      const micDataTimeout = handlers.getMicDataTimeout()
      if (micDataTimeout) {
        BackgroundTimer.clearTimeout(micDataTimeout)
      }
      handlers.setMicDataTimeout(
        BackgroundTimer.setTimeout(() => {
          useDebugStore.getState().setDebugInfo({micDataRecvd: false})
        }, handlers.micTimeoutMs),
      )
      useDebugStore.getState().setDebugInfo({micDataRecvd: true})

      // console.log("MANTLE: Received mic_lc3 event from Bluetooth SDK", event.lc3.length)

      // Route audio to: UDP (if enabled) -> WebSocket (fallback)
      if (udp.enabledAndReady()) {
        // UDP audio is enabled and ready - send directly via UDP
        udp.sendAudio(event.lc3)
      } else {
        socketComms.sendBinary(event.lc3)
      }
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("mic_pcm", (event) => {
      const micDataTimeout = handlers.getMicDataTimeout()
      if (micDataTimeout) {
        BackgroundTimer.clearTimeout(micDataTimeout)
      }
      handlers.setMicDataTimeout(
        BackgroundTimer.setTimeout(() => {
          useDebugStore.getState().setDebugInfo({micDataRecvd: false})
        }, handlers.micTimeoutMs),
      )
      useDebugStore.getState().setDebugInfo({micDataRecvd: true})

      // Route audio to: UDP (if enabled) -> WebSocket (fallback)
      if (udp.enabledAndReady()) {
        // UDP audio is enabled and ready - send directly via UDP
        udp.sendAudio(event.pcm)
      } else {
        socketComms.sendBinary(event.pcm)
      }
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("stream_status", (event) => {
      console.log("MANTLE: Forwarding stream status to server:", event)
      socketComms.sendStreamStatus(event)
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("keep_alive_ack", (event) => {
      console.log("MANTLE: Forwarding keep-alive ACK to server:", event)
      socketComms.sendKeepAliveAck(event)
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("ota_update_available", (event) => {
      if (!useGlassesStore.getState().connected) {
        console.log("📱 MANTLE: Ignoring ota_update_available - glasses not connected")
        return
      }
      console.log("📱 MANTLE: OTA update available from glasses:", event)
      useGlassesStore.getState().setOtaUpdateAvailable({
        available: true,
        versionCode: event.version_code ?? 0,
        versionName: event.version_name ?? "",
        updates: event.updates ?? [],
        totalSize: event.total_size ?? 0,
      })
      GlobalEventEmitter.emit("ota_update_available", {
        versionCode: event.version_code,
        versionName: event.version_name,
        updates: event.updates,
        totalSize: event.total_size,
      })
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("mtk_update_complete", (event) => {
      console.log("MANTLE: MTK firmware update complete:", event.message)
      GlobalEventEmitter.emit("mtk_update_complete", {
        message: event.message,
        timestamp: event.timestamp,
      })
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("ota_start_ack", (event) => {
      console.log("MANTLE: ota_start_ack received from glasses")
      GlobalEventEmitter.emit("ota_start_ack", {timestamp: event.timestamp})
    }),
  )

  addSubscription(
    mentraBluetoothSdkAdapter.addListener("ota_progress", (event) => {
      console.log("📱 MANTLE: OTA progress:", event.stage, event.status, event.progress + "%")
      useGlassesStore.getState().setOtaProgress({
        stage: event.stage ?? "download",
        status: event.status ?? "PROGRESS",
        progress: event.progress ?? 0,
        bytesDownloaded: event.bytes_downloaded ?? 0,
        totalBytes: event.total_bytes ?? 0,
        currentUpdate: event.current_update ?? "apk",
        errorMessage: event.error_message,
      })
      GlobalEventEmitter.emit("ota_progress", {
        stage: event.stage,
        status: event.status,
        progress: event.progress,
        bytesDownloaded: event.bytes_downloaded,
        totalBytes: event.total_bytes,
        currentUpdate: event.current_update,
        errorMessage: event.error_message,
      })
      // Clear OTA update available when finished or failed.
      if (event.status === "FINISHED" || event.status === "FAILED") {
        useGlassesStore.getState().setOtaUpdateAvailable(null)
      }
    }),
  )

  return subscriptions
}

export const syncBluetoothStatusStoresFromNative = async () => {
  const bluetoothStatus = await mentraBluetoothSdkAdapter.getBluetoothStatus()
  // console.log("MANTLE: core status:", bluetoothStatus)
  useBluetoothStore.getState().setBluetoothStatus(bluetoothStatus)

  const glassesStatus = await mentraBluetoothSdkAdapter.getGlassesStatus()
  // console.log("MANTLE: glasses status:", glassesStatus)
  useGlassesStore.getState().setGlassesInfo(glassesStatus)
}
