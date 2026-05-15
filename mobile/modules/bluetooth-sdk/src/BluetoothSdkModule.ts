import {NativeModule, requireNativeModule} from "expo"

import {
  BluetoothSettingsUpdate,
  BluetoothSdkModuleEvents,
  BluetoothStatus,
  ButtonPhotoSize,
  CameraFov,
  CameraFovSetting,
  ConnectOptions,
  DashboardMenuItem,
  Device,
  DeviceModel,
  GalleryMode,
  GlassesMediaVolumeGetResult,
  GlassesMediaVolumeSetResult,
  GlassesStatus,
  MicPreference,
  ObservableStoreCategory,
  PhotoCompression,
  PhotoSize,
  RgbLedAction,
  RgbLedColor,
  StreamKeepAliveRequest,
  StreamStartRequest,
} from "./BluetoothSdk.types"

type GlassesListener = (changed: Partial<GlassesStatus>) => void
type BluetoothStatusListener = (changed: Partial<BluetoothStatus>) => void
type MaybePromise<T> = T | Promise<T>

declare class BluetoothSdkModule extends NativeModule<BluetoothSdkModuleEvents> {
  // Observable Store Functions (native)
  getGlassesStatus(): Promise<GlassesStatus>
  getBluetoothStatus(): Promise<BluetoothStatus>
  getDefaultDevice(): Promise<Device | null>
  update(category: ObservableStoreCategory, values: object): Promise<void>

  // Display Commands
  displayEvent(params: Record<string, unknown>): Promise<void>
  displayText(text: string, x?: number, y?: number, size?: number): Promise<void>
  clearDisplay(): Promise<void>

  // Connection Commands
  requestStatus(): Promise<void>
  connectDefault(options?: ConnectOptions): Promise<void>
  connectDefaultWithOptions(options: Required<ConnectOptions>): Promise<void>
  setDefaultDevice(device: Device | null): Promise<void>
  clearDefaultDevice(): Promise<void>
  startScan(model: DeviceModel): Promise<void>
  connect(device: Device, options?: ConnectOptions): Promise<void>
  connectWithOptions(device: Device, options: Required<ConnectOptions>): Promise<void>
  cancelConnectionAttempt(): Promise<void>
  connectDefaultController(): Promise<void>
  disconnectController(): Promise<void>
  connectSimulated(): Promise<void>
  disconnect(): Promise<void>
  forget(): Promise<void>
  forgetController(): Promise<void>
  showDashboard(): Promise<void>
  setBrightness(level: number, autoMode?: boolean | null): Promise<void>
  setAutoBrightness(enabled: boolean): Promise<void>
  setDashboardPosition(height: number, depth: number): Promise<void>
  setDashboardMenu(items: DashboardMenuItem[]): Promise<void>
  setHeadUpAngle(angleDegrees: number): Promise<void>
  setScreenDisabled(disabled: boolean): Promise<void>
  ping(): Promise<void>
  dbg1(): Promise<void>
  dbg2(): Promise<void>

  // Incident Reporting
  sendIncidentId(incidentId: string, apiBaseUrl?: string | null): Promise<void>

  // WiFi Commands
  requestWifiScan(): Promise<void>
  sendWifiCredentials(ssid: string, password: string): Promise<void>
  forgetWifiNetwork(ssid: string): Promise<void>
  setHotspotState(enabled: boolean): Promise<void>
  /** Logs current WiFi frequency (MHz) and 5 GHz band to Android logcat. */
  logCurrentWifiFrequency(): Promise<void>

  // Gallery Commands
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
    flash: boolean,
    sound: boolean,
  ): Promise<void>

  // OTA Commands
  sendOtaStart(): Promise<void>
  sendOtaQueryStatus(): Promise<void>

  // Version Info Commands
  requestVersionInfo(): Promise<void>

  // Video Recording Commands
  startVideoRecording(requestId: string, save: boolean, flash: boolean, sound: boolean): Promise<void>
  stopVideoRecording(requestId: string): Promise<void>

  // Stream Commands
  startStream(params: StreamStartRequest): Promise<void>
  stopStream(): Promise<void>
  keepStreamAlive(params: StreamKeepAliveRequest): Promise<void>

  // Microphone Commands
  setMicState(
    enabled: boolean,
    useGlassesMic?: boolean,
    bypassVad?: boolean,
    sendTranscript?: boolean,
    sendLc3Data?: boolean,
  ): Promise<void>
  setPreferredMic(preferredMic: MicPreference): Promise<void>
  restartTranscriber(): Promise<void>

  // Audio Playback Monitoring
  // Notify native side when our app starts/stops playing audio
  // Used to suspend LC3 mic during audio playback to avoid MCU overload
  setOwnAppAudioPlaying(playing: boolean): Promise<void>

  /** Mentra Live only: K900 `cs_getvol` / `sr_getvol`. */
  getGlassesMediaVolume(): Promise<GlassesMediaVolumeGetResult>
  /** Mentra Live only: K900 `cs_vol` / `sr_vol`; level clamped 0–15 on native. */
  setGlassesMediaVolume(level: number): Promise<GlassesMediaVolumeSetResult>

  // RGB LED Control
  rgbLedControl(
    requestId: string,
    packageName: string | null,
    action: RgbLedAction,
    color: RgbLedColor | null,
    ontime: number,
    offtime: number,
    count: number,
  ): Promise<void>

  // STT Commands
  setSttModelDetails(path: string, languageCode: string): Promise<void>
  getSttModelPath(): Promise<string>
  checkSttModelAvailable(): Promise<boolean>
  validateSttModel(path: string): Promise<boolean>
  extractTarBz2(sourcePath: string, destinationPath: string): Promise<boolean>

  // Helper methods for type-safe observable store access
  updateGlasses(values: Partial<GlassesStatus>): Promise<void>
  updateBluetoothSettings(values: BluetoothSettingsUpdate): Promise<void>
  onGlassesStatus(callback: GlassesListener): () => void
  onBluetoothStatus(callback: BluetoothStatusListener): () => void

  // Process resident-set-size in MB. iOS-only; Android stub returns 0.
  getMemoryMB(): number
}

// This call loads the native module object from the JSI.
// NativeModule<BluetoothSdkModuleEvents> already extends EventEmitter<BluetoothSdkModuleEvents>
const NativeBluetoothSdkModule = requireNativeModule<BluetoothSdkModule>("BluetoothSdk")

const DEFAULT_CONNECT_OPTIONS: Required<ConnectOptions> = {
  saveAsDefault: true,
  cancelExistingConnectionAttempt: true,
}

const CAMERA_FOV_SETTINGS: Record<CameraFov, CameraFovSetting> = {
  standard: {fov: 118, roi_position: 0},
  wide: {fov: 118, roi_position: 0},
}

function dashboardMenuItemToNative(item: DashboardMenuItem): Record<string, unknown> {
  return {
    ...(item.values ?? {}),
    title: item.title,
    packageName: item.packageName,
  }
}

function adaptConnectionStatusToNative(connection: GlassesStatus["connection"]): Record<string, unknown> {
  switch (connection.state) {
    case "connected":
      return {connectionState: "CONNECTED", connected: true, fullyBooted: connection.fullyBooted}
    case "scanning":
      return {connectionState: "SCANNING", connected: false, fullyBooted: false}
    case "connecting":
      return {connectionState: "CONNECTING", connected: false, fullyBooted: false}
    case "bonding":
      return {connectionState: "BONDING", connected: false, fullyBooted: false}
    case "disconnected":
      return {connectionState: "DISCONNECTED", connected: false, fullyBooted: false}
  }
}

function adaptGlassesUpdateToNative(values: Partial<GlassesStatus>): Record<string, unknown> {
  const {wifi, hotspot, connection, ...rest} = values
  let update: Record<string, unknown> = {...rest}
  if (connection) {
    update = {
      ...update,
      ...adaptConnectionStatusToNative(connection),
    }
  }
  if (wifi?.state === "connected") {
    update = {
      ...update,
      wifiConnected: true,
      wifiSsid: wifi.ssid,
      wifiLocalIp: wifi.localIp ?? "",
    }
  } else if (wifi?.state === "disconnected") {
    update = {
      ...update,
      wifiConnected: false,
      wifiSsid: "",
      wifiLocalIp: "",
    }
  }
  if (hotspot?.state === "enabled") {
    update = {
      ...update,
      hotspotEnabled: true,
      hotspotSsid: hotspot.ssid,
      hotspotPassword: hotspot.password,
      hotspotGatewayIp: hotspot.localIp,
    }
  } else if (hotspot?.state === "disabled") {
    update = {
      ...update,
      hotspotEnabled: false,
      hotspotSsid: "",
      hotspotPassword: "",
      hotspotGatewayIp: "",
    }
  }
  return update
}

// Add helper methods to the module
const nativeGetGlassesStatus = NativeBluetoothSdkModule.getGlassesStatus.bind(
  NativeBluetoothSdkModule,
) as () => MaybePromise<GlassesStatus>
NativeBluetoothSdkModule.getGlassesStatus = function () {
  return Promise.resolve(nativeGetGlassesStatus())
}

const nativeGetBluetoothStatus = NativeBluetoothSdkModule.getBluetoothStatus.bind(NativeBluetoothSdkModule) as () => MaybePromise<BluetoothStatus>
NativeBluetoothSdkModule.getBluetoothStatus = function () {
  return Promise.resolve(nativeGetBluetoothStatus())
}

const nativeGetDefaultDevice = NativeBluetoothSdkModule.getDefaultDevice.bind(
  NativeBluetoothSdkModule,
) as () => MaybePromise<Device | null>
NativeBluetoothSdkModule.getDefaultDevice = function () {
  return Promise.resolve(nativeGetDefaultDevice())
}

const nativeSetMicState = NativeBluetoothSdkModule.setMicState.bind(NativeBluetoothSdkModule) as (
  enabled: boolean,
  useGlassesMic: boolean,
  bypassVad: boolean,
  sendTranscript: boolean,
  sendLc3Data: boolean,
) => MaybePromise<void>

const nativeDisplayText = NativeBluetoothSdkModule.displayText.bind(NativeBluetoothSdkModule) as (
  text: string,
  x: number,
  y: number,
  size: number,
) => MaybePromise<void>

NativeBluetoothSdkModule.updateGlasses = function (values: Partial<GlassesStatus>) {
  return this.update("glasses", adaptGlassesUpdateToNative(values))
}

NativeBluetoothSdkModule.updateBluetoothSettings = function (values: BluetoothSettingsUpdate) {
  return this.update("bluetooth", values)
}

NativeBluetoothSdkModule.displayText = function (text: string, x?: number, y?: number, size?: number) {
  return Promise.resolve(nativeDisplayText(text, x ?? 0, y ?? 0, size ?? 24))
}

NativeBluetoothSdkModule.setBrightness = function (level: number, autoMode?: boolean | null) {
  return this.updateBluetoothSettings({
    ...(autoMode == null ? {} : {auto_brightness: autoMode}),
    brightness: level,
  })
}

NativeBluetoothSdkModule.setAutoBrightness = function (enabled: boolean) {
  return this.updateBluetoothSettings({auto_brightness: enabled})
}

NativeBluetoothSdkModule.setDashboardPosition = function (height: number, depth: number) {
  return this.updateBluetoothSettings({
    dashboard_height: height,
    dashboard_depth: depth,
  })
}

NativeBluetoothSdkModule.setDashboardMenu = function (items: DashboardMenuItem[]) {
  return this.updateBluetoothSettings({menu_apps: items.map(dashboardMenuItemToNative)})
}

NativeBluetoothSdkModule.setHeadUpAngle = function (angleDegrees: number) {
  return this.updateBluetoothSettings({head_up_angle: angleDegrees})
}

NativeBluetoothSdkModule.setScreenDisabled = function (disabled: boolean) {
  return this.updateBluetoothSettings({screen_disabled: disabled})
}

NativeBluetoothSdkModule.setButtonPhotoSettings = function (size: ButtonPhotoSize) {
  return this.updateBluetoothSettings({button_photo_size: size})
}

NativeBluetoothSdkModule.setButtonVideoRecordingSettings = function (width: number, height: number, fps: number) {
  return this.updateBluetoothSettings({
    button_video_width: width,
    button_video_height: height,
    button_video_fps: fps,
  })
}

NativeBluetoothSdkModule.setButtonCameraLed = function (enabled: boolean) {
  return this.updateBluetoothSettings({button_camera_led: enabled})
}

NativeBluetoothSdkModule.setButtonMaxRecordingTime = function (minutes: number) {
  return this.updateBluetoothSettings({button_max_recording_time: minutes})
}

NativeBluetoothSdkModule.setCameraFov = function (fov: CameraFov) {
  return this.updateBluetoothSettings({camera_fov: CAMERA_FOV_SETTINGS[fov]})
}

NativeBluetoothSdkModule.setMicState = function (
  enabled: boolean,
  useGlassesMic?: boolean,
  bypassVad?: boolean,
  sendTranscript?: boolean,
  sendLc3Data?: boolean,
) {
  return Promise.resolve(
    nativeSetMicState(
      enabled,
      useGlassesMic ?? true,
      bypassVad ?? false,
      sendTranscript ?? false,
      sendLc3Data ?? false,
    ),
  )
}

NativeBluetoothSdkModule.setPreferredMic = function (preferredMic: MicPreference) {
  return this.updateBluetoothSettings({preferred_mic: preferredMic})
}

NativeBluetoothSdkModule.onGlassesStatus = function (callback: GlassesListener) {
  const subscription = this.addListener("glasses_status", callback)
  return () => subscription.remove()
}

NativeBluetoothSdkModule.onBluetoothStatus = function (callback: BluetoothStatusListener) {
  const subscription = this.addListener("bluetooth_status", callback)
  return () => subscription.remove()
}

const nativeConnectDefault = NativeBluetoothSdkModule.connectDefault.bind(NativeBluetoothSdkModule)
NativeBluetoothSdkModule.connectDefault = function (options?: ConnectOptions) {
  if (!options) {
    return nativeConnectDefault()
  }
  return this.connectDefaultWithOptions({...DEFAULT_CONNECT_OPTIONS, ...options})
}

NativeBluetoothSdkModule.connect = function (device: Device, options?: ConnectOptions) {
  return this.connectWithOptions(device, {...DEFAULT_CONNECT_OPTIONS, ...options})
}

export default NativeBluetoothSdkModule
