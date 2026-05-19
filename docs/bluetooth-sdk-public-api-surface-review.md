# Bluetooth SDK Public API Surface Review

This review captures the public API boundary created by:

```text
3a512b8357df0e472c6fb5d1352316524e97aee1
Define Bluetooth SDK public API boundary
AuthorDate: 2026-05-15 12:27:57 -0700
```

That commit made the package root expose only the partner-facing React Native API, moved the raw MentraOS compatibility module to the `_internal` subpath, and demoted several native Swift/Kotlin facade methods from public to internal package use.

This document reflects the current source on this branch, not only the commit snapshot. In particular, later work added the picker-friendly `scan(...)` helper and removed `connectFirst(...)`.

## Source Files Reviewed

- React Native package root: `mobile/modules/bluetooth-sdk/src/index.ts`
- React Native public/internal type boundary: `mobile/modules/bluetooth-sdk/src/BluetoothSdk.types.ts`
- React Native raw module facade: `mobile/modules/bluetooth-sdk/src/_private/BluetoothSdkModule.ts`
- React Native internal entrypoint: `mobile/modules/bluetooth-sdk/src/_internal.ts`
- Android native facade: `mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/MentraBluetoothSdk.kt`
- Android native models/callbacks: `mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/MentraBluetoothModels.kt`
- iOS native facade and models: `mobile/modules/bluetooth-sdk/ios/Source/MentraBluetoothSDK.swift`

## Exposed Feature Set At A Glance

- Status: glasses status, Bluetooth status, default device, status change callbacks.
- Discovery and connection: scan, stop scan, connect selected device, connect default device, cancel connection attempt, disconnect, forget.
- Display controls: text display, clear display, dashboard display, display brightness, dashboard position, head-up angle, screen disable.
- Wi-Fi and hotspot: request Wi-Fi scan, send credentials, forget network, toggle hotspot.
- Camera and gallery: gallery mode, button capture settings, camera FOV, photo upload request, gallery status query, start/stop video recording.
- Streaming: start stream, keep stream alive, stop stream.
- Microphone and speaker-adjacent audio: microphone data mode, preferred mic, app-audio playback notification, glasses media volume on React Native and Android.
- RGB LED: on/off with color and timing/count arguments.
- Version info: request glasses firmware/version information.
- Lifecycle: subscription removal everywhere, `close()` on Android, `invalidate()` on iOS.

## React Native / Expo Public Surface

Import path:

```ts
import BluetoothSdk from "@mentra/bluetooth-sdk"
```

Public value exports:

```ts
DeviceModels
createDisconnectedGlassesStatus(): Partial<GlassesStatus>
isConnectedGlassesConnectionStatus(status: GlassesConnectionStatus): status is ConnectedGlassesConnectionStatus
isReadyGlassesConnectionStatus(status: GlassesConnectionStatus): boolean
isBusyGlassesConnectionStatus(status: GlassesConnectionStatus): boolean
isConnectedWifiStatus(status: WifiStatus): status is ConnectedWifiStatus
isEnabledHotspotStatus(status: HotspotStatus): status is EnabledHotspotStatus
```

Public module function signatures:

```ts
addListener<EventName extends BluetoothSdkEventName>(
  eventName: EventName,
  listener: BluetoothSdkEventListener<EventName>,
): BluetoothSdkSubscription

getGlassesStatus(): Promise<GlassesStatus>
getBluetoothStatus(): Promise<BluetoothStatus>
getDefaultDevice(): Promise<Device | null>
setDefaultDevice(device: Device | null): Promise<void>
clearDefaultDevice(): Promise<void>

startScan(model: DeviceModel): Promise<void>
stopScan(): Promise<void>
scan(options: ScanOptions): Promise<Device[]>
scan(model: DeviceModel, options?: ScanModelOptions): Promise<Device[]>
connect(device: Device, options?: ConnectOptions): Promise<void>
connectDefault(options?: ConnectOptions): Promise<void>
cancelConnectionAttempt(): Promise<void>
disconnect(): Promise<void>
forget(): Promise<void>

displayText(text: string, x?: number, y?: number, size?: number): Promise<void>
clearDisplay(): Promise<void>
showDashboard(): Promise<void>
setDashboardPosition(height: number, depth: number): Promise<void>
setHeadUpAngle(angleDegrees: number): Promise<void>
setScreenDisabled(disabled: boolean): Promise<void>

requestWifiScan(): Promise<void>
sendWifiCredentials(ssid: string, password: string): Promise<void>
forgetWifiNetwork(ssid: string): Promise<void>
setHotspotState(enabled: boolean): Promise<void>

setGalleryMode(mode: GalleryMode): Promise<void>
setButtonPhotoSettings(size: ButtonPhotoSize): Promise<void>
setButtonVideoRecordingSettings(width: number, height: number, fps: number): Promise<void>
setButtonCameraLed(enabled: boolean): Promise<void>
setButtonMaxRecordingTime(minutes: number): Promise<void>
setCameraFov(fov: CameraFov): Promise<void>
queryGalleryStatus(): Promise<void>
photoRequest(
  requestId: string,
  appId: string,
  size: PhotoSize,
  webhookUrl: string | null,
  authToken: string | null,
  compress: PhotoCompression,
  sound: boolean,
): Promise<void>
startVideoRecording(requestId: string, save: boolean, sound: boolean): Promise<void>
stopVideoRecording(requestId: string): Promise<void>

startStream(params: StreamStartRequest): Promise<void>
stopStream(): Promise<void>
keepStreamAlive(params: StreamKeepAliveRequest): Promise<void>

setMicState(
  enabled: boolean,
  useGlassesMic?: boolean,
  bypassVad?: boolean,
  sendTranscript?: boolean,
  sendLc3Data?: boolean,
): Promise<void>
setPreferredMic(preferredMic: MicPreference): Promise<void>
setOwnAppAudioPlaying(playing: boolean): Promise<void>
getGlassesMediaVolume(): Promise<GlassesMediaVolumeGetResult>
setGlassesMediaVolume(level: number): Promise<GlassesMediaVolumeSetResult>

rgbLedControl(
  requestId: string,
  packageName: string | null,
  action: RgbLedAction,
  color: RgbLedColor | null,
  ontime: number,
  offtime: number,
  count: number,
): Promise<void>

requestVersionInfo(): Promise<void>
onGlassesStatus(callback: (changed: Partial<GlassesStatus>) => void): () => void
onBluetoothStatus(callback: (changed: Partial<BluetoothStatus>) => void): () => void
```

Important public type constraints:

```ts
type GlassesConnectionStatus =
  | {state: "disconnected"}
  | {state: "scanning"}
  | {state: "connecting"}
  | {state: "bonding"}
  | {state: "connected"; fullyBooted: boolean}

type WifiStatus =
  | {state: "disconnected"}
  | {state: "connected"; ssid: string; localIp?: string}

type HotspotStatus =
  | {state: "disabled"}
  | {state: "enabled"; ssid: string; password: string; localIp: string}

type GalleryMode = "auto" | "manual"
type PhotoSize = "small" | "medium" | "large" | "full"
type ButtonPhotoSize = "small" | "medium" | "large"
type PhotoCompression = "none" | "medium" | "heavy"
type CameraFov = "standard" | "wide"
type MicPreference = "auto" | "phone" | "glasses" | "bluetooth"
type RgbLedAction = "on" | "off"
type RgbLedColor = "red" | "green" | "blue" | "orange" | "white"

type BluetoothSdkEventMap = {
  glasses_status: Partial<GlassesStatus>
  bluetooth_status: Partial<BluetoothStatus>
  log: LogEvent
  device_discovered: Device
  default_device_changed: {device?: Device}
  // Other entries map each public event name to its payload type.
}

type BluetoothSdkEventName = keyof BluetoothSdkEventMap

type BluetoothSdkEventListener<EventName extends BluetoothSdkEventName> = (
  event: BluetoothSdkEventMap[EventName],
) => void

// Public React Native event payloads use camelCase field names.
type TouchEvent = {type: "touch_event"; deviceModel?: string; gestureName?: string; timestamp: number}
type PhotoResponseEvent =
  | {type: "photo_response"; state: "success"; requestId: string; uploadUrl: string; timestamp: number}
  | {type: "photo_response"; state: "error"; requestId: string; timestamp: number; errorCode?: string; errorMessage: string}
type GalleryStatusEvent = {type: "gallery_status"; photos: number; videos: number; total: number; hasContent: boolean; cameraBusy: boolean}

interface ScanOptions {
  model: DeviceModel
  timeoutMs?: number
  timeout?: number
  onResults?: (devices: Device[]) => void
}
```

Public event names:

```ts
"glasses_status"
"bluetooth_status"
"log"
"device_discovered"
"default_device_changed"
"glasses_not_ready"
"button_press"
"touch_event"
"head_up"
"vad_status"
"battery_status"
"local_transcription"
"wifi_status_change"
"hotspot_status_change"
"hotspot_error"
"photo_response"
"gallery_status"
"compatible_glasses_search_stop"
"swipe_volume_status"
"switch_status"
"rgb_led_control_response"
"pair_failure"
"audio_pairing_needed"
"audio_connected"
"audio_disconnected"
"mic_pcm"
"mic_lc3"
"stream_status"
"keep_alive_ack"
```

## Android Native Public Surface

Factory signatures:

```kotlin
companion object {
  @JvmStatic
  fun create(context: Context, listener: MentraBluetoothSdkListener): MentraBluetoothSdk

  @JvmStatic
  fun create(
    context: Context,
    config: MentraBluetoothSdkConfig,
    listener: MentraBluetoothSdkListener,
  ): MentraBluetoothSdk
}
```

Public facade function signatures:

```kotlin
fun addListener(listener: MentraBluetoothSdkListener)
fun removeListener(listener: MentraBluetoothSdkListener)

fun getGlassesStatus(): GlassesStatus
fun getBluetoothStatus(): BluetoothStatus
fun getDefaultDevice(): Device?
fun setDefaultDevice(device: Device?)
fun clearDefaultDevice()

fun startScan(model: DeviceModel)
fun stopScan()
fun scan(model: DeviceModel, onResults: (List<Device>) -> Unit): ScanSession
fun scan(model: DeviceModel, timeoutMs: Long, onResults: (List<Device>) -> Unit): ScanSession
@JvmOverloads
fun scan(
  model: DeviceModel,
  callback: ScanCallback,
  timeoutMs: Long = 15_000L,
): ScanSession

@JvmOverloads
fun connect(device: Device, options: ConnectOptions = ConnectOptions())
@JvmOverloads
fun connectDefault(options: ConnectOptions = ConnectOptions())
fun cancelConnectionAttempt()
fun disconnect()
fun forget()

@JvmOverloads
fun displayText(text: String, x: Int = 0, y: Int = 0, size: Int = 24)
fun displayText(request: DisplayTextRequest)
fun clearDisplay()
fun showDashboard()
fun setDashboardPosition(height: Int, depth: Int)
fun setDashboardPosition(request: DashboardPositionRequest)
fun setHeadUpAngle(angleDegrees: Int)
fun setScreenDisabled(disabled: Boolean)

fun setGalleryMode(mode: GalleryMode)
fun setButtonPhotoSettings(size: ButtonPhotoSize)
fun setButtonPhotoSettings(settings: ButtonPhotoSettings)
fun setButtonVideoRecordingSettings(width: Int, height: Int, fps: Int)
fun setButtonVideoRecordingSettings(settings: ButtonVideoRecordingSettings)
fun setButtonCameraLed(enabled: Boolean)
fun setButtonMaxRecordingTime(minutes: Int)
fun setCameraFov(fov: CameraFov)

fun setMicState(
  enabled: Boolean,
  useGlassesMic: Boolean = true,
  bypassVad: Boolean = false,
  sendTranscript: Boolean = false,
  sendLc3Data: Boolean = false,
)
@Deprecated(...)
fun setMicState(config: MicConfig)
fun setPreferredMic(preferredMic: MicPreference)
fun setOwnAppAudioPlaying(playing: Boolean)
fun getGlassesMediaVolume(): GlassesMediaVolumeGetResult
fun setGlassesMediaVolume(level: Int): GlassesMediaVolumeSetResult

fun requestWifiScan()
fun sendWifiCredentials(ssid: String, password: String)
fun forgetWifiNetwork(ssid: String)
fun setHotspotState(enabled: Boolean)

fun requestPhoto(request: PhotoRequest)
fun queryGalleryStatus()
fun startStream(request: StreamRequest)
fun keepStreamAlive(request: StreamKeepAliveRequest)
fun rgbLedControl(request: RgbLedRequest)
fun stopStream()
fun startVideoRecording(request: VideoRecordingRequest)
fun stopVideoRecording(requestId: String)
fun requestVersionInfo()

override fun close()
```

Public Android callback/listener signatures:

```kotlin
interface ScanCallback {
  fun onResults(devices: List<Device>) {}
  fun onComplete(devices: List<Device>) {}
  fun onError(error: BluetoothError) {}
}

class ScanSession {
  fun stop()
}

interface MentraBluetoothSdkListener {
  fun onGlassesStatusChanged(status: GlassesStatusUpdate) {}
  fun onBluetoothStatusChanged(status: BluetoothStatusUpdate) {}
  fun onDeviceDiscovered(device: Device) {}
  fun onScanStopped(reason: ScanStopReason) {}
  fun onButtonPress(event: ButtonPressEvent) {}
  fun onTouch(event: TouchEvent) {}
  fun onSwipe(event: SwipeEvent) {}
  fun onHeadUpChanged(headUp: Boolean) {}
  fun onBatteryStatus(event: BatteryStatusEvent) {}
  fun onWifiStatusChanged(event: WifiStatusEvent) {}
  fun onHotspotStatusChanged(event: HotspotStatusEvent) {}
  fun onHotspotError(event: HotspotErrorEvent) {}
  fun onGalleryStatus(event: GalleryStatusEvent) {}
  fun onPhotoResponse(event: PhotoResponseEvent) {}
  fun onStreamStatus(event: StreamStatusEvent) {}
  fun onKeepAliveAck(event: KeepAliveAckEvent) {}
  fun onMicPcm(frame: ByteArray) {}
  fun onMicLc3(frame: ByteArray) {}
  fun onLocalTranscription(event: LocalTranscriptionEvent) {}
  fun onDefaultDeviceChanged(device: Device?) {}
  fun onLog(message: String) {}
  fun onError(error: BluetoothError) {}
  fun onRawEvent(eventName: String, values: Map<String, Any>) {}
}
```

Important Android request/model constructors:

```kotlin
data class ConnectOptions(
  val saveAsDefault: Boolean = true,
  val cancelExistingConnectionAttempt: Boolean = true,
)

data class DisplayTextRequest(val text: String, val x: Int = 0, val y: Int = 0, val size: Int = 24)
data class DashboardPositionRequest(val height: Int, val depth: Int)
data class ButtonPhotoSettings(val size: ButtonPhotoSize)
data class ButtonVideoRecordingSettings(val width: Int, val height: Int, val fps: Int)

data class PhotoRequest @JvmOverloads constructor(
  val requestId: String,
  val appId: String,
  val size: PhotoSize,
  val webhookUrl: String,
  val authToken: String? = null,
  val compress: PhotoCompression = PhotoCompression.MEDIUM,
  val sound: Boolean = true,
)

data class StreamRequest @JvmOverloads constructor(
  val streamUrl: String,
  val streamId: String = "",
  val keepAlive: Boolean = true,
  val keepAliveIntervalSeconds: Int = 15,
  val sound: Boolean = true,
  val video: StreamVideoConfig? = null,
  val audio: StreamAudioConfig? = null,
  val extraValues: Map<String, Any> = emptyMap(),
)

data class StreamKeepAliveRequest @JvmOverloads constructor(
  val streamId: String,
  val ackId: String,
  val extraValues: Map<String, Any> = emptyMap(),
)

data class RgbLedRequest @JvmOverloads constructor(
  val requestId: String,
  val packageName: String?,
  val action: RgbLedAction,
  val color: RgbLedColor?,
  val ontime: Int,
  val offtime: Int,
  val count: Int,
)

data class VideoRecordingRequest(val requestId: String, val save: Boolean, val sound: Boolean)
```

## iOS Swift Native Public Surface

Public class/properties:

```swift
@MainActor
public final class MentraBluetoothSDK {
  public weak var delegate: MentraBluetoothSDKDelegate?

  public init(configuration: MentraBluetoothSDKConfiguration = .default)

  public var glassesStatus: GlassesStatus { get }
  public var bluetoothStatus: BluetoothStatus { get }
  public var defaultDevice: Device? { get }
}
```

Public facade function signatures:

```swift
public func getDefaultDevice() -> Device?
public func setDefaultDevice(_ device: Device?)
public func clearDefaultDevice()

public func startScan(model: DeviceModel) throws
public func stopScan()

@discardableResult
public func scan(
  model: DeviceModel,
  timeout: TimeInterval = 15,
  onResults: @escaping ([Device]) -> Void,
  onComplete: @escaping ([Device]) -> Void = { _ in }
) throws -> ScanSession

public func connect(to device: Device, options: ConnectOptions = ConnectOptions()) throws
public func connectDefault(options: ConnectOptions = ConnectOptions()) throws
public func cancelConnectionAttempt()
public func disconnect()
public func forget()

public func displayText(_ text: String, x: Int = 0, y: Int = 0, size: Int = 24) async throws
public func displayText(_ request: DisplayTextRequest) async throws
public func clearDisplay() async throws
public func showDashboard()
public func setDashboardPosition(height: Int, depth: Int) async throws
public func setDashboardPosition(_ request: DashboardPositionRequest) async throws
public func setHeadUpAngle(_ angleDegrees: Int) async throws
public func setScreenDisabled(_ disabled: Bool) async throws

public func setGalleryMode(_ mode: GalleryMode) async throws
public func setButtonPhotoSettings(size: ButtonPhotoSize) async throws
public func setButtonPhotoSettings(_ settings: ButtonPhotoSettings) async throws
public func setButtonVideoRecordingSettings(width: Int, height: Int, fps: Int) async throws
public func setButtonVideoRecordingSettings(_ settings: ButtonVideoRecordingSettings) async throws
public func setButtonCameraLed(enabled: Bool) async throws
public func setButtonMaxRecordingTime(minutes: Int) async throws
public func setCameraFov(_ fov: CameraFov) async throws

public func setMicState(
  enabled: Bool,
  useGlassesMic: Bool = true,
  bypassVad: Bool = false,
  sendTranscript: Bool = false,
  sendLc3Data: Bool = false
)
@available(*, deprecated, message: "Use setMicState(enabled:useGlassesMic:bypassVad:) instead.")
public func setMicState(_ config: MicConfiguration)
public func setPreferredMic(_ preferredMic: MicPreference)
public func setOwnAppAudioPlaying(_ playing: Bool)

public func requestWifiScan()
public func sendWifiCredentials(ssid: String, password: String)
public func forgetWifiNetwork(ssid: String)
public func setHotspotState(enabled: Bool)

public func requestPhoto(_ request: PhotoRequest)
public func queryGalleryStatus()
public func startStream(_ request: StreamRequest)
public func keepStreamAlive(_ request: StreamKeepAliveRequest)
public func rgbLedControl(_ request: RgbLedRequest)
public func stopStream()
public func startVideoRecording(_ request: VideoRecordingRequest)
public func stopVideoRecording(requestId: String)
public func requestVersionInfo()

public func invalidate()
```

Public iOS delegate/callback signatures:

```swift
@MainActor
public protocol MentraBluetoothSDKDelegate: AnyObject {
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: GlassesStatusUpdate)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateBluetoothStatus status: BluetoothStatusUpdate)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didDiscover device: Device)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didStopScan reason: ScanStopReason)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceive event: BluetoothEvent)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicPcm frame: Data)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveMicLc3 frame: Data)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didChangeDefaultDevice device: Device?)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String)
  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: BluetoothError)
}

public final class ScanSession {
  public func stop()
}
```

Important iOS request/model initializers:

```swift
public init(saveAsDefault: Bool = true, cancelExistingConnectionAttempt: Bool = true) // ConnectOptions
public init(text: String, x: Int = 0, y: Int = 0, size: Int = 24) // DisplayTextRequest
public init(height: Int, depth: Int) // DashboardPositionRequest
public init(size: ButtonPhotoSize) // ButtonPhotoSettings
public init(width: Int, height: Int, fps: Int) // ButtonVideoRecordingSettings

public init(
  requestId: String,
  appId: String,
  size: PhotoSize,
  webhookUrl: String? = nil,
  authToken: String? = nil,
  compress: PhotoCompression? = nil,
  sound: Bool
) // PhotoRequest

public init(
  streamUrl: String,
  streamId: String = "",
  keepAlive: Bool = true,
  keepAliveIntervalSeconds: Int = 15,
  sound: Bool = true,
  video: StreamVideoConfig? = nil,
  audio: StreamAudioConfig? = nil,
  extraValues: [String: Any] = [:]
) // StreamRequest

public init(streamId: String, ackId: String, extraValues: [String: Any] = [:]) // StreamKeepAliveRequest

public init(
  requestId: String,
  packageName: String?,
  action: RgbLedAction,
  color: RgbLedColor?,
  ontime: Int,
  offtime: Int,
  count: Int
) // RgbLedRequest

public init(requestId: String, save: Bool, sound: Bool) // VideoRecordingRequest
```

## Functionality Made Internal Or Private

These are the main operations hidden by the API-boundary work or kept behind internal entrypoints.

### React Native

Internal import path:

```ts
import BluetoothSdkInternal from "@mentra/bluetooth-sdk-internal"
```

The MentraOS app resolves `@mentra/bluetooth-sdk-internal` to the raw native module and all type definitions for MentraOS app compatibility. The published package no longer exports this as a customer-accessible subpath, and the package root no longer exposes these operations:

```ts
update(category: ObservableStoreCategory, values: object): Promise<void>
updateGlasses(values: Partial<GlassesStatus>): Promise<void>
updateBluetoothSettings(values: BluetoothSettingsUpdate): Promise<void>

requestStatus(): Promise<void>
displayEvent(params: Record<string, unknown>): Promise<void>

connectDefaultController(): Promise<void>
disconnectController(): Promise<void>
connectSimulated(): Promise<void>
forgetController(): Promise<void>

setDashboardMenu(items: DashboardMenuItem[]): Promise<void>
ping(): Promise<void>
dbg1(): Promise<void>
dbg2(): Promise<void>

sendIncidentId(incidentId: string, apiBaseUrl?: string | null): Promise<void>

logCurrentWifiFrequency(): Promise<void>

sendOtaStart(): Promise<void>
sendOtaQueryStatus(): Promise<void>

restartTranscriber(): Promise<void>

setSttModelDetails(path: string, languageCode: string): Promise<void>
getSttModelPath(): Promise<string>
checkSttModelAvailable(): Promise<boolean>
validateSttModel(path: string): Promise<boolean>
extractTarBz2(sourcePath: string, destinationPath: string): Promise<boolean>

getMemoryMB(): number
```

The root event surface also omits these raw/internal event families:

```ts
"heartbeat_sent"
"heartbeat_received"
"save_setting"
"ws_text"
"ws_bin"
"mtk_update_complete"
"ota_update_available"
"ota_start_ack"
"ota_status"
"send_command_to_ble"
"receive_command_from_ble"
"miniapp_selected"
```

Review note: hiding these from the package root was mostly inferred from what was partner-documented. The areas most likely to deserve explicit product review are `sendIncidentId`, OTA controls, STT model/file helpers, dashboard menu injection, and raw observable-store updates.

### Android Native

These facade methods are no longer public Android SDK methods:

```kotlin
internal fun connectSimulated()
internal fun displayEvent(request: DisplayEventRequest)
internal fun setDashboardMenu(items: List<DashboardMenuItem>)
internal fun sendOtaStart()
internal fun sendOtaQueryStatus()
internal fun sendShutdown()
internal fun sendReboot()
internal fun sendIncidentId(incidentId: String, apiBaseUrl: String? = null)
```

Review note: the operation methods are internal, but some related Kotlin data classes are still public by default, including `DisplayEventRequest` and `DashboardMenuItem`. That means the capability is not callable from the public facade, but some internal vocabulary still leaks in the Maven-facing model package unless we mark those types `internal` or move them.

### iOS Native

These facade methods are no longer public Swift SDK methods:

```swift
func connectSimulated()
func displayEvent(_ request: DisplayEventRequest) async throws
func setDashboardMenu(_ items: [DashboardMenuItem]) async throws
func sendOtaStart()
func sendOtaQueryStatus()
func sendShutdown()
func sendReboot()
func sendIncidentId(_ incidentId: String, apiBaseUrl: String? = nil)
```

Review note: like Android, the operation methods are internal, but `DisplayEventRequest` and `DashboardMenuItem` are still declared `public`. They are not useful without the hidden methods, so this should be reviewed as either intentional future-proofing or a small public-surface leak.

## Cross-Language Differences Surfaced

- React Native exposes `getGlassesMediaVolume()` and `setGlassesMediaVolume(level)`. Android native also exposes these. The bare Swift facade currently does not, even though the iOS Expo bridge and underlying iOS `DeviceManager` have implementations.
- React Native camera/video methods use scalar arguments for `photoRequest(...)`, `startVideoRecording(...)`, and `stopVideoRecording(...)`. Android and iOS native APIs use request objects for photo, stream, LED, and video recording.
- React Native scan returns a `Promise<Device[]>` and optionally reports progressive results through `onResults`. Android and iOS scan return a `ScanSession` immediately and report progressive/final results through callbacks.
- React Native has both generic `addListener(...)` and convenience `onGlassesStatus(...)` / `onBluetoothStatus(...)`. Android uses `MentraBluetoothSdkListener`; iOS uses `MentraBluetoothSDKDelegate`.
- Android exposes `close()` because the facade implements `AutoCloseable`. iOS exposes `invalidate()`. React Native does not expose an equivalent module-wide teardown method.
- Android and iOS both keep deprecated config-object overloads for `setMicState(...)`. React Native only exposes the scalar `setMicState(enabled, useGlassesMic, bypassVad, sendTranscript, sendLc3Data)` signature.
- Android and iOS expose request-object overloads for display text, dashboard position, button photo settings, and button video settings. React Native only exposes the simpler scalar variants.
- Android and iOS still expose some native model types for internal-only operations, especially `DisplayEventRequest` and `DashboardMenuItem`. React Native avoids this at the package root by not exporting those types.
- The iOS native facade uses `async throws` for display/settings methods that can be async, while Android public methods are synchronous facade calls and React Native methods return `Promise`.

## Review Questions

- Should bare Swift expose glasses media volume to match React Native and Android?
- Should `DisplayEventRequest` and `DashboardMenuItem` be hidden in Swift/Kotlin since their operation methods are hidden?
- Should OTA, shutdown/reboot, and incident-reporting remain internal forever, or should any become explicit partner APIs with permission/guardrail semantics?
- Should STT model/file management stay MentraOS-internal, or is there a partner use case for local STT model management?
- Should raw store mutation helpers remain available only to MentraOS through `_internal`, or should even MentraOS migrate away from them before release?
- Should native SDKs remove deprecated `MicConfig` / `MicConfiguration` overloads before the first public release?
- Should scan be the preferred public API across all three languages, with `startScan` / `stopScan` documented only for advanced custom flows?
