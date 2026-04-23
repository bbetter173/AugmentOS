package com.mentra.bluetoothsdk

import android.os.Handler
import android.os.Looper
import com.mentra.bluetoothsdk.utils.DeviceTypes
import com.mentra.bluetoothsdk.utils.MicMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Centralized observable state store for glasses and Bluetooth SDK settings */
object DeviceStore {

    val store = ObservableStore()

    /**
     * [BluetoothSdkModule] applies batched `update("core", map)` key-by-key. Post to Main so the store has
     * the latest value before BLE. Height and depth schedule independently so Nex sends one protobuf per change.
     */
    private val dashboardBleHandler = Handler(Looper.getMainLooper())
    private var pendingDashboardHeightRunnable: Runnable? = null
    private var pendingDashboardDepthRunnable: Runnable? = null

    /** Same equality rule as [ObservableStore.set] — avoids BLE side effects on no-op applies. */
    private fun observableStoreWouldHaveSkipped(oldValue: Any?, newValue: Any): Boolean {
        if (oldValue == null) return false
        return JSONObject(mapOf("v" to oldValue)).toString() ==
                JSONObject(mapOf("v" to newValue)).toString()
    }

    private fun scheduleDashboardHeightToGlasses() {
        pendingDashboardHeightRunnable?.let { dashboardBleHandler.removeCallbacks(it) }
        val r = Runnable {
            pendingDashboardHeightRunnable = null
            val h = (store.get("core", "dashboard_height") as? Number)?.toInt() ?: 4
            DeviceManager.getInstance().sgc?.setDashboardHeightOnly(h)
        }
        pendingDashboardHeightRunnable = r
        dashboardBleHandler.post(r)
    }

    private fun scheduleDashboardDepthToGlasses() {
        pendingDashboardDepthRunnable?.let { dashboardBleHandler.removeCallbacks(it) }
        val r = Runnable {
            pendingDashboardDepthRunnable = null
            val d = (store.get("core", "dashboard_depth") as? Number)?.toInt() ?: 2
            DeviceManager.getInstance().sgc?.setDashboardDepthOnly(d)
        }
        pendingDashboardDepthRunnable = r
        dashboardBleHandler.post(r)
    }

    init {
        // SETTINGS are snake_case
        // BLUETOOTH SDK STATE is camelCase

        // GLASSES STATE:
        store.set("glasses", "batteryLevel", -1)
        store.set("glasses", "charging", false)
        store.set("glasses", "fullyBooted", false)
        store.set("glasses", "connected", false)
        store.set("glasses", "connectionState", "disconnected")
        store.set("glasses", "deviceModel", "")
        store.set("glasses", "firmwareVersion", "")
        store.set("glasses", "micEnabled", false)
        store.set("glasses", "btcConnected", false)
        store.set("glasses", "caseRemoved", true)
        store.set("glasses", "caseOpen", true)
        store.set("glasses", "caseCharging", false)
        store.set("glasses", "caseBatteryLevel", -1)
        store.set("glasses", "headUp", false)
        store.set("glasses", "serialNumber", "")
        store.set("glasses", "style", "")
        store.set("glasses", "color", "")
        store.set("glasses", "wifiSsid", "")
        store.set("glasses", "wifiConnected", false)
        store.set("glasses", "wifiLocalIp", "")
        store.set("glasses", "hotspotEnabled", false)
        store.set("glasses", "hotspotSsid", "")
        store.set("glasses", "hotspotPassword", "")
        store.set("glasses", "hotspotGatewayIp", "")
        store.set("glasses", "bluetoothName", "")
        store.set("glasses", "controllerConnected", false)
        store.set("glasses", "controllerFullyBooted", false)
        store.set("glasses", "controllerMacAddress", "")
        store.set("glasses", "controllerBatteryLevel", -1)
        store.set("glasses", "controllerSignalStrength", -1)
        store.set("glasses", "ringSignalStrength", -1)

        // BLUETOOTH SDK STATE:
        store.set("core", "systemMicUnavailable", false)
        store.set("core", "searching", false)
        store.set("core", "searchingController", false)
        store.set("core", "micEnabled", false)
        store.set("core", "currentMic", "")
        store.set("core", "searchResults", emptyList<Any>())
        store.set("core", "wifiScanResults", emptyList<Any>())
        store.set("core", "micRanking", MicMap.map["auto"]!!)
        store.set("core", "lastLog", mutableListOf<String>())

        // CORE SETTINGS:
        store.set("core", "default_wearable", "")
        store.set("core", "pending_wearable", "")
        store.set("core", "device_name", "")
        store.set("core", "device_address", "")
        store.set("core", "default_controller", "")
        store.set("core", "pending_controller", "")
        store.set("core", "controller_device_name", "")
        store.set("core", "screen_disabled", false)
        store.set("core", "preferred_mic", "auto")
        store.set("core", "sensing_enabled", true)
        store.set("core", "brightness", 50)
        store.set("core", "auto_brightness", true)
        store.set("core", "dashboard_height", 4)
        store.set("core", "dashboard_depth", 2)
        store.set("core", "head_up_angle", 30)
        store.set("core", "contextual_dashboard", true)
        store.set("core", "gallery_mode", false)
        store.set("core", "screen_disabled", false)
        store.set("core", "button_mode", "photo")
        store.set("core", "button_photo_size", "medium")
        store.set("core", "button_camera_led", true)
        store.set("core", "button_max_recording_time", 10)
        store.set("core", "camera_fov", mapOf("fov" to 118, "roi_position" to 0))
        store.set("core", "button_video_width", 1280)
        store.set("core", "button_video_height", 720)
        store.set("core", "button_video_fps", 30)
        store.set("core", "preferred_mic", "auto")
        store.set("core", "lc3_frame_size", 60)
        store.set("core", "auth_email", "")
        store.set("core", "core_token", "")
        store.set("core", "should_send_pcm", false)
        store.set("core", "should_send_lc3", false)
        store.set("core", "should_send_transcript", false)
        store.set("core", "bypass_vad", false)
    }

    fun get(category: String, key: String): Any? {
        return store.get(category, key)
    }

    fun set(category: String, key: String, value: Any) {
        store.set(category, key, value)
    }

    /** Apply changes with side effects */
    fun apply(category: String, key: String, value: Any) {
        val oldValue = store.get(category, key)
        store.set(category, key, value)
        if (observableStoreWouldHaveSkipped(oldValue, value)) {
            return
        }

        // Trigger hardware updates based on setting changes
        when (category to key) {
            "glasses" to "fullyBooted" -> {
                if (value is Boolean) {
                    if (value) {
                        DeviceManager.getInstance().handleDeviceReady()
                    } else {
                        DeviceManager.getInstance().handleDeviceDisconnected()
                    }
                    // we shouldn't call store.set in this function as this is only intended for side-effects, not driving state updates
                }
            }
            "glasses" to "controllerFullyBooted" -> {
                if (value is Boolean) {
                    if (value) {
                        DeviceManager.getInstance().handleControllerReady()
                    } else {
                        DeviceManager.getInstance().handleControllerDisconnected()
                    }
                }
            }
            "glasses" to "controllerMacAddress" -> {
                if (value is String && value.isNotEmpty()) {
                    CoroutineScope(Dispatchers.Main).launch {
                        // give the glasses some extra time to finish booting:
                        delay(1000)
                        DeviceManager.getInstance().sgc?.connectController()
                    }
                }
            }
            "glasses" to "headUp" -> {
                if (value is Boolean) {
                    DeviceManager.getInstance().sendCurrentState()
                    Bridge.sendHeadUp(value)
                }
            }

            // CORE:
            "core" to "auth_email" -> {
                if (value is String) {
                    // DeviceManager.getInstance().sgc?.sendAuthEmail(value)
                }
            }
            "core" to "core_token" -> {
                if (value is String) {
                    // DeviceManager.getInstance().sgc?.sendAuthToken(value)
                }
            }
            "core" to "isHeadUp" -> {
                (value as? Boolean)?.let { isHeadUp ->
                    // sendCurrentState()
                    DeviceManager.getInstance().sendCurrentState()
                    Bridge.sendHeadUp(isHeadUp)
                }
            }
            "core" to "brightness" -> {
                val b = (value as? Number)?.toInt()  ?: 50
                val auto = (store.get("core", "auto_brightness") as? Boolean) ?: true
                CoroutineScope(Dispatchers.Main).launch {
                    DeviceManager.getInstance().sgc?.setBrightness(b, auto)
                    DeviceManager.getInstance().sgc?.sendTextWall("Set brightness to $b%")
                    delay(800) // 0.8 seconds
                    DeviceManager.getInstance().sgc?.clearDisplay()
                }
            }
            "core" to "auto_brightness" -> {
                val b = (store.get("core", "brightness") as? Int) ?: 50
                val auto = (value as? Boolean) ?: true
                val autoBrightnessChanged = (oldValue as? Boolean) != auto
                CoroutineScope(Dispatchers.Main).launch {
                    DeviceManager.getInstance().sgc?.setBrightness(b, auto)
                    if (autoBrightnessChanged) {
                        DeviceManager.getInstance()
                                .sgc
                                ?.sendTextWall(
                                        if (auto) "Enabled auto brightness"
                                        else "Disabled auto brightness"
                                )
                        delay(800) // 0.8 seconds
                        DeviceManager.getInstance().sgc?.clearDisplay()
                    }
                }
            }
            "core" to "dashboard_height" -> {
                scheduleDashboardHeightToGlasses()
            }
            "core" to "dashboard_depth" -> {
                scheduleDashboardDepthToGlasses()
            }
            "core" to "head_up_angle" -> {
                (value as? Int)?.let { angle ->
                    DeviceManager.getInstance().sgc?.setHeadUpAngle(angle)
                }
            }
            "core" to "dashboard_menu_apps" -> {
                @Suppress("UNCHECKED_CAST")
                (value as? List<Map<String, Any>>)?.let { items ->
                    DeviceManager.getInstance().sgc?.setDashboardMenu(items)
                }
            }
            "core" to "gallery_mode" -> {
                DeviceManager.getInstance().sgc?.sendGalleryMode()
            }
            "core" to "screen_disabled" -> {
                (value as? Boolean)?.let { disabled ->
                    if (disabled) {
                        DeviceManager.getInstance().sgc?.exit()
                    } else {
                        DeviceManager.getInstance().sgc?.clearDisplay()
                    }
                }
            }
            "core" to "button_mode" -> {
                DeviceManager.getInstance().sgc?.sendButtonModeSetting()
            }
            "core" to "button_photo_size" -> {
                DeviceManager.getInstance().sgc?.sendButtonPhotoSettings()
            }
            "core" to "button_camera_led" -> {
                DeviceManager.getInstance().sgc?.sendButtonCameraLedSetting()
            }
            "core" to "button_max_recording_time" -> {
                DeviceManager.getInstance().sgc?.sendButtonMaxRecordingTime()
            }
            "core" to "camera_fov" -> {
                DeviceManager.getInstance().sgc?.sendCameraFovSetting()
            }
            "core" to "button_video_width",
            "core" to "button_video_height",
            "core" to "button_video_fps" -> {
                DeviceManager.getInstance().sgc?.sendButtonVideoRecordingSettings()
            }
            "core" to "preferred_mic" -> {
                (value as? String)?.let { mic ->
                    apply("core", "micRanking", MicMap.map[mic] ?: MicMap.map["auto"]!!)
                    DeviceManager.getInstance().setMicState()
                }
            }
            "core" to "offline_captions_running" -> {
                (value as? Boolean)?.let { running ->
                    Bridge.log("DeviceStore: offline_captions_running changed to $running")
                    DeviceManager.getInstance().setMicState()
                }
            }
            "core" to "should_send_pcm" -> {
                (value as? Boolean)?.let { pcm ->
                    DeviceManager.getInstance().setMicState()
                }
            }
            "core" to "should_send_lc3" -> {
                (value as? Boolean)?.let { lc3 ->
                    DeviceManager.getInstance().setMicState()
                }
            }
            "core" to "should_send_transcript" -> {
                (value as? Boolean)?.let { transcript ->
                    DeviceManager.getInstance().setMicState()
                }
            }
            "core" to "default_wearable" -> {
                (value as? String)?.let { wearable ->
                    Bridge.saveSetting("default_wearable", wearable)
                    if (wearable.contains(DeviceTypes.SIMULATED)) {
                        DeviceManager.getInstance().initSGC(wearable)
                    }
                }
            }
            "core" to "device_name" -> {
                // Device name changed - no additional action needed
            }
            "core" to "lastLog" -> {
                (value as? MutableList<String>)?.let { logs ->
                    // ensure the list is trimmed to 100 items (remove oldest items)
                    // if (logs.size > 100) {
                    //     logs.subList(0, logs.size - 100)
                    // }
                    // DeviceStore.store.set("core", "lastLog", logs)
                }
            }
        }
    }
}
