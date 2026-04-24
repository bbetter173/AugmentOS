# Mentra Bluetooth SDK: iOS Native API Plan

## Goal

Make the Bluetooth SDK usable directly from bare iOS Swift apps, while MentraOS continues to use the same native implementation through a thin Expo adapter.

The customer-facing iOS API should not expose Expo, React Native, `DeviceManager`, `DeviceStore`, `Bridge`, or raw `"bluetooth"` / `"glasses"` store categories.

## Current iOS Lifecycle

The current iOS entrypoint is `BluetoothSdkModule.swift`, which imports `ExpoModulesCore`. On module creation it:

- Calls `Bridge.initialize { eventName, data in sendEvent(eventName, data) }`.
- Configures `DeviceStore.shared.store.configure` so `"glasses"` updates become `glasses_status` events and `"bluetooth"` updates become `bluetooth_status` events.
- Exposes Expo `AsyncFunction`s such as `update`, `findCompatibleDevices`, `connectByName`, `connectDefault`, `disconnect`, `displayText`, media commands, Wi-Fi commands, OTA commands, and microphone/STT commands.

The real hardware lifecycle lives under the Expo module:

- `Bridge.swift` is a static event sink. It emits logs, status events, hardware events, mic frames, local transcriptions, and save-setting events back to the current callback.
- `DeviceManager.swift` is an `@MainActor` singleton. It owns the current glasses manager, current controller manager, display state, connection methods, Wi-Fi commands, media commands, local transcription, phone mic/audio handling, and cleanup.
- `DeviceStore.swift` is both state and command routing. `apply(category, key, value)` updates observable state and triggers hardware side effects for settings like brightness, dashboard position, gallery mode, button settings, preferred mic, stream flags, and default wearable.
- `SGCManager.swift` is the per-device abstraction implemented by G1, G2, Mentra Live, Mentra Nex, Mach1/Z100, simulated glasses, and controller classes.
- `MentraBluetoothSDK.podspec` currently depends on `ExpoModulesCore`, so the pod is not yet a clean bare iOS SDK.

This structure is a workable internal implementation, but the public API should be a typed Swift facade.

## Native API Shape

Create a public Swift-first facade:

```swift
@MainActor
public final class MentraBluetoothSDK {
    public weak var delegate: MentraBluetoothSDKDelegate?

    public init(configuration: MentraBluetoothSDKConfiguration = .default)

    public var glassesStatus: MentraGlassesStatus { get }
    public var bluetoothStatus: MentraBluetoothStatus { get }

    public func startScan(model: MentraDeviceModel)
    public func stopScan()
    public func connect(to device: MentraDiscoveredDevice)
    public func connect(model: MentraDeviceModel, name: String)
    public func connectDefault()
    public func connectSimulated()
    public func disconnect()
    public func forget()

    public func displayText(_ request: MentraDisplayTextRequest) async throws
    public func displayEvent(_ request: MentraDisplayEventRequest) async throws
    public func clearDisplay() async throws
    public func showDashboard()

    public func setMicState(_ config: MentraMicConfiguration)
    public func setPreferredMic(_ preferredMic: MentraMicPreference)
    public func setOwnAppAudioPlaying(_ playing: Bool)

    public func requestWifiScan()
    public func sendWifiCredentials(ssid: String, password: String)
    public func forgetWifiNetwork(ssid: String)
    public func setHotspotState(enabled: Bool)

    public func requestPhoto(_ request: MentraPhotoRequest)
    public func queryGalleryStatus()
    public func startStream(_ request: MentraStreamRequest)
    public func keepStreamAlive(_ request: MentraStreamKeepAliveRequest)
    public func stopStream()
    public func startBufferRecording()
    public func stopBufferRecording()
    public func saveBufferVideo(requestId: String, durationSeconds: Int)
    public func startVideoRecording(_ request: MentraVideoRecordingRequest)
    public func stopVideoRecording(requestId: String)

    public func requestVersionInfo()
    public func sendOtaStart()
    public func sendShutdown()
    public func sendReboot()
    public func sendIncidentId(_ incidentId: String, apiBaseUrl: String? = nil)

    public func invalidate()
}
```

`@MainActor` matches the current `DeviceManager` isolation and is idiomatic for a facade that interacts with CoreBluetooth state, audio state, and delegate callbacks. Long-running work should still happen inside the existing managers, not block the main actor.

## Delegate API

Use delegate callbacks for ongoing events:

```swift
@MainActor
public protocol MentraBluetoothSDKDelegate: AnyObject {
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: MentraGlassesStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateBluetoothStatus status: MentraBluetoothStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: MentraDiscoveredDevice)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didStopScan reason: MentraScanStopReason)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: MentraBluetoothEvent)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 frame: Data)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didChangeDefaultDevice device: MentraPairedDevice?)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: MentraBluetoothError)
}
```

For Swift Concurrency ergonomics, we can add an optional event stream:

```swift
public var events: AsyncStream<MentraBluetoothEvent> { get }
```

Do not make `AsyncStream` the only integration path in v1. Delegates are still the most familiar iOS library pattern and map cleanly to MentraOS's Expo event adapter.

## Public Models

Add typed public models before exposing the facade:

- `MentraDeviceModel`: `g1`, `g2`, `mentraLive`, `mentraNex`, `mach1`, `z100`, `simulated`, `r1`.
- `MentraDiscoveredDevice`: `model`, `name`, optional `identifier`, optional `rssi`.
- `MentraGlassesStatus`: current snapshot of connected, fully booted, battery, charging, model, firmware, serial, Wi-Fi, hotspot, head-up, controller, and signal state.
- `MentraBluetoothStatus`: current snapshot of searching, mic, current mic, search results, Wi-Fi scan results, permission availability, and audio availability.
- `MentraDisplayTextRequest`, `MentraDisplayEventRequest`, `MentraPhotoRequest`, `MentraStreamRequest`, `MentraVideoRecordingRequest`, `MentraMicConfiguration`, `MentraBluetoothError`.

Prefer Swift structs and enums with clear defaults. Objective-C compatibility is not a v1 requirement unless a customer asks for it.

## Store Sync Boundary

The current MentraOS integration has two stores:

- MentraOS TypeScript uses Zustand stores for app settings, Bluetooth status, and glasses status.
- Native iOS uses `DeviceStore` / `ObservableStore` for hardware state and setting side effects.

This two-store setup can remain internally, but it should not become the public iOS SDK paradigm. External iOS customers should not call `update("bluetooth", values)`, listen for `save_setting`, or know which raw keys cause hardware side effects.

The target boundary is:

- Public SDK callers use typed methods such as `setBrightness`, `setPreferredMic`, `startScan`, `connect`, `displayText`, and `setMicState`.
- Public SDK callers receive typed delegate callbacks such as `didUpdateGlassesStatus`, `didUpdateBluetoothStatus`, `didDiscover`, and `didReceive`.
- `DeviceStore` remains an implementation detail behind `MentraBluetoothSDK`.
- SDK-owned persistence should use a typed storage/config abstraction or default UserDefaults storage. It should not ask external apps to persist arbitrary MentraOS setting keys.
- `didChangeDefaultDevice` can notify apps that the remembered device changed, but the SDK should own the default storage path unless the app provides a custom storage implementation.

## Permissions And Host Lifecycle

The host app should own permission copy and prompts. The SDK documentation should clearly require:

- `NSBluetoothAlwaysUsageDescription`.
- `NSMicrophoneUsageDescription` when phone mic, local transcription, or audio streaming is used.
- Any local network, camera roll, or background mode notes that are required by specific device features.

The SDK can expose helpers for capability checks, but it should not surprise customers by prompting permissions during initialization.

```swift
public enum MentraSDKFeature {
    case scanning
    case phoneMicrophone
    case localTranscription
    case mediaStreaming
}

public struct MentraPermissionStatus {
    public let bluetooth: MentraPermissionState
    public let microphone: MentraPermissionState
}
```

`invalidate()` should stop scans, disconnect or settle active device managers where appropriate, stop phone mic capture, shut down local transcription resources, remove event sinks, and release delegate references. `deinit` should call the same cleanup path defensively.

## MentraOS Adapter

MentraOS should keep its TypeScript API stable. `BluetoothSdkModule.swift` becomes an adapter that:

- Owns one `MentraBluetoothSDK` instance.
- Implements `MentraBluetoothSDKDelegate`.
- Maps typed delegate callbacks back to existing Expo event names such as `glasses_status`, `bluetooth_status`, `button_press`, `mic_pcm`, and `save_setting`.
- Translates existing stringly typed `update("core" | "bluetooth", values)` calls into typed facade calls or internal settings updates while MentraOS migrates.
- Lets `mobile/src/services/bluetooth/MentraBluetoothSdkAdapter.ts` watch Zustand settings and call typed SDK methods directly over time, with `BluetoothSettingsSync.ts` and `BluetoothEventBridge.ts` extracted as helpers if the adapter grows.
- Keeps legacy `"core"` category normalization inside the adapter/store compatibility layer, not in the public native API.
- Keeps MentraOS cloud formatting in TypeScript services such as `SocketComms.ts`, `RestComms.ts`, and `DisplayProcessor.ts`; iOS should emit typed hardware events, not MentraOS websocket or REST payloads.

This lets MentraOS keep using the SDK while external customers use the native iOS facade.

## Packaging Plan

The bare iOS SDK should be available through CocoaPods first:

- `MentraBluetoothSDK`: bare native pod with no `ExpoModulesCore` dependency.
- `MentraBluetoothSDKExpoAdapter` or the existing Expo module target: adapter layer that depends on `MentraBluetoothSDK` and `ExpoModulesCore`.

Swift Package Manager support should be evaluated after CocoaPods is working because the current implementation includes vendored frameworks, ONNX runtime, UltraliteSDK, resources, C/C++ headers, and local model files.

The public podspec must include the native dependencies and privacy manifest, but not require the host app to be an Expo or React Native project.

## Extraction Plan

1. Add the public model files, delegate protocol, configuration type, and error enum without changing behavior.
2. Add `MentraBluetoothSDK` facade that delegates to the existing `DeviceManager`, `DeviceStore`, and `Bridge` internals.
3. Replace the static `Bridge` callback with an internal event sink that can fan out to the Swift facade and the Expo adapter.
4. Keep `DeviceManager`, `DeviceStore`, `ObservableStore`, and `SGCManager` internal implementation details.
5. Keep `updateBluetoothSettings`, `"core"` normalization, and `save_setting` as MentraOS compatibility plumbing only.
6. Add `mobile/src/services/bluetooth/MentraBluetoothSdkAdapter.ts` and translate Zustand changes into typed SDK calls.
7. Move `BluetoothSdkModule.swift` into the adapter layer so the bare SDK pod can remove `ExpoModulesCore`.
8. Update `MentraBluetoothSDK.podspec` so a clean iOS app can run `pod install` without Expo.
9. Add a bare iOS sample app that initializes the SDK, scans, connects, displays text, clears display, and logs status events.
10. Keep the existing mobile regression tests passing with little or no TypeScript test changes.

## Acceptance Criteria

- A new bare iOS app can depend on the pod without Expo or React Native.
- Swift callers can initialize the SDK, set a delegate, scan, connect, display text, and disconnect.
- MentraOS still builds and uses the same implementation through `BluetoothSdkModule.swift`.
- Public docs never tell customers to call `DeviceManager`, `DeviceStore`, `Bridge`, `update("bluetooth", ...)`, or handle `save_setting`.
- The iOS sample app builds from a clean checkout and exercises the public facade.
- Cleanup is explicit for scans, active connections, phone mic, local transcription, and event delivery.

## Open Questions

- Whether the adapter should be a separate pod, a CocoaPods subspec, or only an internal Expo module target.
- Whether media, streaming, OTA, and local transcription should ship in the base SDK facade or be grouped behind capability protocols.
- Whether the first version needs Objective-C compatibility.
- Whether Swift Package Manager is worth supporting before the dependency graph is simplified.
