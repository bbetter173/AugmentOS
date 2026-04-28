import BluetoothSdk, {
  type BluetoothSdkModuleEvents,
  type BluetoothStatus,
  type DeviceSearchResult,
} from "@mentra/bluetooth-sdk"

export * from "@mentra/bluetooth-sdk"
export type CoreStatus = BluetoothStatus
export type CoreModuleEvents = BluetoothSdkModuleEvents

type AddListener = typeof BluetoothSdk.addListener
type CoreStatusListener = (changed: Partial<BluetoothStatus>) => void

type CoreCompatibility = typeof BluetoothSdk & {
  dbg1(): Promise<void>
  dbg2(): Promise<void>
  displayImage(imageType: string, imageSize: string): Promise<void>
  getCoreStatus(): BluetoothStatus | Promise<BluetoothStatus>
  isLocationServicesEnabled(): Promise<boolean>
  onCoreStatus(callback: CoreStatusListener): () => void
  openAppSettings(): Promise<void>
  openBluetoothSettings(): Promise<void>
  openLocationSettings(): Promise<void>
  sendSaveBufferVideo(requestId: string, durationSeconds: number): Promise<void>
  sendStartVideoRecording(requestId: string, save: boolean, flash?: boolean, sound?: boolean): Promise<void>
  sendStopVideoRecording(requestId: string): Promise<void>
  setLc3AudioEnabled(enabled: boolean): Promise<void>
  showLocationServicesDialog(): Promise<void>
  updateCore(values: Record<string, any>): Promise<void>
}

const rawAddListener = BluetoothSdk.addListener.bind(BluetoothSdk) as AddListener
const rawUpdate = BluetoothSdk.update.bind(BluetoothSdk)

const mapCategory = (category: string) => (category === "core" ? "bluetooth" : category)
const mapEventName = (eventName: string) => (eventName === "core_status" ? "bluetooth_status" : eventName)

const CoreModule = BluetoothSdk as CoreCompatibility

CoreModule.addListener = ((eventName: string, listener: Parameters<AddListener>[1]) =>
  rawAddListener(mapEventName(eventName) as keyof BluetoothSdkModuleEvents, listener)) as AddListener

CoreModule.update = (category: string, values: Record<string, any>) => rawUpdate(mapCategory(category), values)

CoreModule.getCoreStatus = () => BluetoothSdk.getBluetoothStatus()

CoreModule.updateCore = (values: Record<string, any>) => BluetoothSdk.updateBluetoothSettings(values)

CoreModule.onCoreStatus = (callback: CoreStatusListener) => BluetoothSdk.onBluetoothStatus(callback)

CoreModule.sendSaveBufferVideo = (requestId: string, durationSeconds: number) =>
  BluetoothSdk.saveBufferVideo(requestId, durationSeconds)

CoreModule.sendStartVideoRecording = (requestId: string, save: boolean, flash = false, sound = true) =>
  BluetoothSdk.startVideoRecording(requestId, save, flash, sound)

CoreModule.sendStopVideoRecording = (requestId: string) => BluetoothSdk.stopVideoRecording(requestId)

CoreModule.connectDiscoveredDevice = (device: DeviceSearchResult) =>
  BluetoothSdk.connectDevice(device.deviceModel, device.deviceName)

export default CoreModule
