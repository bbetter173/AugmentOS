import {useState} from "react"

import BluetoothSdk from "../index"
import {
  DeviceModels,
  createDisconnectedGlassesStatus,
  isConnectedGlassesConnectionStatus,
  isReadyGlassesConnectionStatus,
} from "../BluetoothSdk.types"
import type {
  ConnectOptions,
  Device,
  DeviceModel,
  GalleryMode,
  GlassesConnectionStatus,
  HotspotStatus,
  PublicBluetoothStatus,
  PublicGlassesStatus,
  WifiStatus,
} from "../BluetoothSdk.types"

import {
  useGlassesConnection,
  type DefaultDeviceStorage,
  type GlassesConnectionHookResult,
} from "./useGlassesConnection"

export type BatteryState = {
  charging: boolean
  level: number | null
}

export type ConnectedGlassesInfo = {
  appVersion?: string
  bluetoothName?: string
  buildNumber?: string
  color?: string
  deviceModel?: string
  firmwareVersion?: string
  serialNumber?: string
  style?: string
}

export type GlassesRuntimeState =
  | {
      connected: false
      connection: Exclude<GlassesConnectionStatus, {state: "connected"}>
      ready: false
      status: Partial<PublicGlassesStatus>
    }
  | {
      battery: BatteryState
      connected: true
      connection: Extract<GlassesConnectionStatus, {state: "connected"}>
      device: ConnectedGlassesInfo
      hotspot: HotspotStatus
      ready: boolean
      status: Partial<PublicGlassesStatus>
      wifi: WifiStatus
    }

export type GalleryModeState = {
  applying: boolean
  desired: GalleryMode
  error: unknown | null
}

export type PhoneSdkRuntimeState = {
  defaultDevice: Device | null
  galleryMode: GalleryModeState
  status: Partial<PublicBluetoothStatus>
}

export type ScanController = {
  active: boolean
  clear: () => void
  devices: Device[]
  error: unknown | null
  model: DeviceModel
  selectedDevice: Device | null
  selectDevice: (device: Device | null) => void
  setModel: (model: DeviceModel) => void
  start: (model?: DeviceModel) => Promise<Device[]>
  stop: () => Promise<void>
}

export type UseMentraBluetoothOptions = {
  autoConnectDefault?: boolean
  defaultDeviceStorage?: DefaultDeviceStorage
  defaultModel?: DeviceModel
  onError?: (error: unknown) => void
  scanTimeoutMs?: number
}

export type MentraBluetoothSession = {
  busy: boolean
  clearDefaultDevice: () => Promise<void>
  connect: (device?: Device, options?: ConnectOptions) => Promise<void>
  connectDefault: (options?: ConnectOptions) => Promise<void>
  defaultDevice: Device | null
  disconnect: () => Promise<void>
  error: unknown | null
  glasses: GlassesRuntimeState
  refresh: () => Promise<void>
  scan: ScanController
  sdk: PhoneSdkRuntimeState
  setDefaultDevice: (device: Device | null) => Promise<void>
  setGalleryMode: (mode: GalleryMode) => Promise<void>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function batteryState(status: Partial<PublicGlassesStatus>): BatteryState {
  const level = typeof status.batteryLevel === "number" && status.batteryLevel >= 0 ? status.batteryLevel : null
  return {
    charging: status.charging ?? false,
    level,
  }
}

function connectedGlassesInfo(status: Partial<PublicGlassesStatus>): ConnectedGlassesInfo {
  return {
    appVersion: stringValue(status.appVersion),
    bluetoothName: stringValue(status.bluetoothName),
    buildNumber: stringValue(status.buildNumber),
    color: stringValue(status.color),
    deviceModel: stringValue(status.deviceModel),
    firmwareVersion: stringValue(status.firmwareVersion),
    serialNumber: stringValue(status.serialNumber),
    style: stringValue(status.style),
  }
}

function runtimeGlassesState(status: Partial<PublicGlassesStatus>): GlassesRuntimeState {
  const connection = status.connection ?? createDisconnectedGlassesStatus().connection ?? {state: "disconnected"}

  if (!isConnectedGlassesConnectionStatus(connection)) {
    return {
      connected: false,
      connection,
      ready: false,
      status,
    }
  }

  return {
    battery: batteryState(status),
    connected: true,
    connection,
    device: connectedGlassesInfo(status),
    hotspot: status.hotspot ?? {state: "disabled"},
    ready: isReadyGlassesConnectionStatus(connection),
    status,
    wifi: status.wifi ?? {state: "disconnected"},
  }
}

function scanController(connection: GlassesConnectionHookResult): ScanController {
  return {
    active: connection.scan.scanning,
    clear: connection.scan.clearResults,
    devices: connection.scan.devices,
    error: connection.scan.error,
    model: connection.scan.model,
    selectedDevice: connection.scan.selectedDevice,
    selectDevice: connection.scan.selectDevice,
    setModel: connection.scan.setModel,
    start: connection.scan.startScan,
    stop: connection.scan.stopScan,
  }
}

export function useMentraBluetooth(options: UseMentraBluetoothOptions = {}): MentraBluetoothSession {
  const connection = useGlassesConnection({
    autoConnectDefault: options.autoConnectDefault,
    defaultDeviceStorage: options.defaultDeviceStorage,
    onError: options.onError,
    scanModel: options.defaultModel ?? DeviceModels.MentraLive,
    scanTimeoutMs: options.scanTimeoutMs,
  })
  const [galleryModeApplying, setGalleryModeApplying] = useState(false)
  const [galleryModeError, setGalleryModeError] = useState<unknown | null>(null)

  async function setGalleryMode(mode: GalleryMode) {
    setGalleryModeApplying(true)
    setGalleryModeError(null)
    try {
      await BluetoothSdk.setGalleryMode(mode)
    } catch (error) {
      setGalleryModeError(error)
      options.onError?.(error)
      throw error
    } finally {
      setGalleryModeApplying(false)
    }
  }

  const galleryMode: GalleryModeState = {
    applying: galleryModeApplying,
    desired: connection.bluetoothStatus.galleryModeAuto === false ? "manual" : "auto",
    error: galleryModeError,
  }

  return {
    busy: connection.busy || galleryModeApplying,
    clearDefaultDevice: connection.clearDefaultDevice,
    connect: connection.connect,
    connectDefault: connection.connectDefault,
    defaultDevice: connection.defaultDevice,
    disconnect: connection.disconnect,
    error: galleryModeError ?? connection.error,
    glasses: runtimeGlassesState(connection.glassesStatus),
    refresh: connection.refresh,
    scan: scanController(connection),
    sdk: {
      defaultDevice: connection.defaultDevice,
      galleryMode,
      status: connection.bluetoothStatus,
    },
    setDefaultDevice: connection.setDefaultDevice,
    setGalleryMode,
  }
}
