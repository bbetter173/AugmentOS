# Mentra Bluetooth SDK: Android Native API Plan

## Goal

Make the Bluetooth SDK usable directly from bare Android Kotlin and Java apps, while MentraOS continues to use the same native implementation through a thin Expo adapter.

The customer-facing Android API should not expose Expo, React Native, `DeviceManager`, `DeviceStore`, `Bridge`, or raw `"bluetooth"` / `"glasses"` store categories.

## Current Android Lifecycle

The current Android entrypoint is `BluetoothSdkModule.kt`, which is an Expo module. On module creation it:

- Calls `Bridge.initialize(context) { eventName, data -> sendEvent(eventName, data) }`.
- Creates `DeviceManager.getInstance()` after `Bridge` has a context.
- Configures `DeviceStore.store.configure` so `"glasses"` updates become `glasses_status` events and `"bluetooth"` updates become `bluetooth_status` events.
- Exposes Expo functions such as `update`, `findCompatibleDevices`, `connectByName`, `connectDefault`, `disconnect`, `displayText`, media commands, Wi-Fi commands, OTA commands, and microphone/STT commands.

The real hardware lifecycle lives under the Expo module:

- `Bridge.kt` is a process-wide event sink and context holder. It emits logs, status events, hardware events, mic frames, local transcriptions, and save-setting events.
- `DeviceManager.kt` is a singleton. It owns permissions checks, Bluetooth adapter monitoring, foreground service startup, phone mic/audio handling, current glasses manager, current controller manager, connection methods, display commands, Wi-Fi commands, camera/media commands, and cleanup.
- `DeviceStore.kt` is both state and command routing. `apply(category, key, value)` updates observable state and triggers hardware side effects for settings like brightness, dashboard position, gallery mode, button settings, preferred mic, stream flags, and default wearable.
- `SGCManager.kt` is the per-device abstraction implemented by G1, G2, Mentra Live, Mentra Nex, Mach1/Z100, simulated glasses, and controller classes.
- `ForegroundService` is declared by the SDK manifest and started by `DeviceManager` to keep connected-device and microphone work alive.

This structure is good internal machinery, but not a good public SDK boundary.

## Native API Shape

Create a public facade in `com.mentra.bluetoothsdk`:

```kotlin
class MentraBluetoothSdk private constructor(
    context: Context,
    config: MentraBluetoothSdkConfig,
) : AutoCloseable {
    companion object {
        @JvmStatic
        fun create(
            context: Context,
            config: MentraBluetoothSdkConfig = MentraBluetoothSdkConfig(),
            listener: MentraBluetoothSdkListener,
        ): MentraBluetoothSdk
    }

    fun addListener(listener: MentraBluetoothSdkListener)
    fun removeListener(listener: MentraBluetoothSdkListener)

    fun getGlassesStatus(): MentraGlassesStatus
    fun getBluetoothStatus(): MentraBluetoothStatus

    fun startScan(model: MentraDeviceModel)
    fun stopScan()
    fun connect(device: MentraDiscoveredDevice)
    fun connectByName(model: MentraDeviceModel, deviceName: String)
    fun connectDefault()
    fun connectSimulated()
    fun disconnect()
    fun forget()

    fun displayText(request: MentraDisplayTextRequest)
    fun displayEvent(request: MentraDisplayEventRequest)
    fun clearDisplay()
    fun showDashboard()

    fun setMicState(config: MentraMicConfig)
    fun setPreferredMic(preferredMic: MentraMicPreference)
    fun setOwnAppAudioPlaying(playing: Boolean)

    fun requestWifiScan()
    fun sendWifiCredentials(ssid: String, password: String)
    fun forgetWifiNetwork(ssid: String)
    fun setHotspotState(enabled: Boolean)

    fun requestPhoto(request: MentraPhotoRequest)
    fun queryGalleryStatus()
    fun startStream(request: MentraStreamRequest)
    fun keepStreamAlive(request: MentraStreamKeepAliveRequest)
    fun stopStream()
    fun startBufferRecording()
    fun stopBufferRecording()
    fun saveBufferVideo(requestId: String, durationSeconds: Int)
    fun startVideoRecording(request: MentraVideoRecordingRequest)
    fun stopVideoRecording(requestId: String)

    fun requestVersionInfo()
    fun sendOtaStart()
    fun sendShutdown()
    fun sendReboot()
    fun sendIncidentId(incidentId: String, apiBaseUrl: String? = null)

    override fun close()
}
```

The core API should be Java-friendly. Avoid requiring coroutines, Flow, or AndroidX lifecycle owners in the base artifact. A later `mentra-bluetooth-sdk-ktx` artifact can add suspend functions and Flow wrappers.

## Listener API

Use typed listener callbacks for ongoing events:

```kotlin
interface MentraBluetoothSdkListener {
    fun onGlassesStatusChanged(status: MentraGlassesStatusUpdate) {}
    fun onBluetoothStatusChanged(status: MentraBluetoothStatusUpdate) {}
    fun onDeviceDiscovered(device: MentraDiscoveredDevice) {}
    fun onScanStopped(reason: MentraScanStopReason) {}
    fun onButtonPress(event: MentraButtonPressEvent) {}
    fun onTouch(event: MentraTouchEvent) {}
    fun onHeadUpChanged(headUp: Boolean) {}
    fun onBatteryStatus(event: MentraBatteryStatusEvent) {}
    fun onWifiStatusChanged(event: MentraWifiStatusEvent) {}
    fun onGalleryStatus(event: MentraGalleryStatusEvent) {}
    fun onPhotoResponse(event: MentraPhotoResponseEvent) {}
    fun onStreamStatus(event: MentraStreamStatusEvent) {}
    fun onMicPcm(frame: ByteArray) {}
    fun onMicLc3(frame: ByteArray) {}
    fun onLocalTranscription(event: MentraLocalTranscriptionEvent) {}
    fun onDefaultDeviceChanged(device: MentraPairedDevice?) {}
    fun onLog(message: String) {}
    fun onError(error: MentraBluetoothError) {}
}
```

Callbacks should be delivered on the Android main thread by default. If we need background delivery later, add `callbackExecutor` to `MentraBluetoothSdkConfig`.

## Public Models

Add typed public models before exposing the facade:

- `MentraDeviceModel`: `G1`, `G2`, `MENTRA_LIVE`, `MENTRA_NEX`, `MACH1`, `Z100`, `SIMULATED`, `R1`.
- `MentraDiscoveredDevice`: `model`, `name`, optional `address`, optional `rssi`.
- `MentraGlassesStatus`: current snapshot of connected, fully booted, battery, charging, model, firmware, serial, Wi-Fi, hotspot, head-up, controller, and signal state.
- `MentraBluetoothStatus`: current snapshot of searching, mic, current mic, search results, Wi-Fi scan results, permission availability, and audio availability.
- `MentraDisplayTextRequest`, `MentraDisplayEventRequest`, `MentraPhotoRequest`, `MentraStreamRequest`, `MentraVideoRecordingRequest`, `MentraMicConfig`, `MentraBluetoothError`.

For Java ergonomics, models with many optional fields should have builders instead of huge constructors.

## Store Sync Boundary

The current MentraOS integration has two stores:

- MentraOS TypeScript uses Zustand stores for app settings, Bluetooth status, and glasses status.
- Native Android uses `DeviceStore` / `ObservableStore` for hardware state and setting side effects.

This two-store setup can remain internally, but it should not become the public Android SDK paradigm. External Android customers should not call `update("bluetooth", values)`, listen for `save_setting`, or know which raw keys cause hardware side effects.

The target boundary is:

- Public SDK callers use typed methods such as `setBrightness`, `setPreferredMic`, `startScan`, `connect`, `displayText`, and `setMicState`.
- Public SDK callers receive typed callbacks such as `onGlassesStatusChanged`, `onBluetoothStatusChanged`, `onDeviceDiscovered`, and `onButtonPress`.
- `DeviceStore` remains an implementation detail behind `MentraBluetoothSdk`.
- SDK-owned persistence should use a typed storage/config abstraction or default SharedPreferences storage. It should not ask external apps to persist arbitrary MentraOS setting keys.
- `onDefaultDeviceChanged` can notify apps that the remembered device changed, but the SDK should own the default storage path unless the app provides a custom storage implementation.

## Permissions And Host Lifecycle

The host app should own runtime permission prompts. The SDK can help with permission discovery and state:

```kotlin
object MentraBluetoothPermissions {
    @JvmStatic
    fun requiredPermissions(features: Set<MentraSdkFeature>): Array<String>

    @JvmStatic
    fun check(context: Context, features: Set<MentraSdkFeature>): MentraPermissionStatus
}
```

The SDK artifact can still merge manifest permissions and the foreground service declaration, but external apps need clear setup docs for:

- Bluetooth scan/connect permissions.
- Location permission when Android requires it for BLE scanning.
- Microphone permission for phone mic and transcription features.
- Foreground service permissions and notification-channel behavior.
- Notification icon/title customization through `MentraBluetoothSdkConfig`.

The facade must retain an application context internally, not an Activity context. `close()` should unregister receivers, stop scan/reconnect loops where appropriate, stop mic capture, stop/settle the foreground service, and release listener references.

## MentraOS Adapter

MentraOS should keep its TypeScript API stable. `BluetoothSdkModule.kt` becomes an adapter that:

- Creates `MentraBluetoothSdk` in `OnCreate`.
- Maps `MentraBluetoothSdkListener` callbacks back to existing Expo event names such as `glasses_status`, `bluetooth_status`, `button_press`, `mic_pcm`, and `save_setting`.
- Translates existing stringly typed `update("core" | "bluetooth", values)` calls into typed facade calls or internal settings updates while MentraOS migrates.
- Lets `mobile/src/services/bluetooth/MentraBluetoothSdkAdapter.ts` watch Zustand settings and call typed SDK methods directly over time, with `BluetoothSettingsSync.ts` and `BluetoothEventBridge.ts` extracted as helpers if the adapter grows.
- Keeps legacy `"core"` category normalization inside the adapter/store compatibility layer, not in the public native API.
- Keeps MentraOS cloud formatting in TypeScript services such as `SocketComms.ts`, `RestComms.ts`, and `DisplayProcessor.ts`; Android should emit typed hardware events, not MentraOS websocket or REST payloads.

This lets MentraOS keep using the SDK while external customers use the native Android facade.

## Extraction Plan

1. Add the public model package and listener interfaces without changing behavior.
2. Add `MentraBluetoothSdk` facade that delegates to the existing `DeviceManager`, `DeviceStore`, and `Bridge` internals.
3. Replace the process-wide `Bridge` callback with an internal `MentraEventSink` that can fan out to native listeners and the Expo adapter.
4. Move `Bridge.getContext()` dependencies behind constructor or initializer injection so the native facade controls lifecycle.
5. Keep `DeviceManager`, `DeviceStore`, `ObservableStore`, and `SGCManager` internal implementation details.
6. Keep `updateBluetoothSettings`, `"core"` normalization, and `save_setting` as MentraOS compatibility plumbing only.
7. Add `mobile/src/services/bluetooth/MentraBluetoothSdkAdapter.ts` and translate Zustand changes into typed SDK calls.
8. Split packaging so the bare Android artifact does not depend on Expo module Gradle plugins.
9. Keep a separate Expo adapter artifact/module that depends on the bare SDK artifact.
10. Resolve `lc3Lib` publication so an external Gradle project can consume the SDK without monorepo project dependencies.
11. Add a bare Android sample app that initializes the SDK, scans, connects, displays text, clears display, and logs status events.
12. Keep the existing mobile regression tests passing with little or no TypeScript test changes.

## Acceptance Criteria

- A new bare Android app can depend on the SDK artifact without Expo or React Native.
- Kotlin and Java callers can initialize the SDK, subscribe to events, scan, connect, display text, and disconnect.
- MentraOS still builds and uses the same implementation through `BluetoothSdkModule.kt`.
- Public docs never tell customers to call `DeviceManager`, `DeviceStore`, `Bridge`, `update("bluetooth", ...)`, or handle `save_setting`.
- The Android sample app builds from a clean checkout and exercises the public facade.
- The foreground service, runtime permissions, audio capture, and BLE receiver lifecycle have explicit cleanup coverage.

## Open Questions

- Whether the first version should expose controller pairing publicly or keep it as an advanced/internal API.
- Whether media, streaming, OTA, and local transcription should ship in the base SDK facade or be grouped behind capability interfaces.
- Whether callbacks should always be main-thread or configurable through `Executor`.
- Whether we want a Kotlin `Flow` wrapper in v1 or as a later `-ktx` package.
