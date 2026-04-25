import BluetoothSdk, {type BluetoothStatus, type GlassesStatus} from "@mentra/bluetooth-sdk"

type AddBluetoothListener = typeof BluetoothSdk.addListener
type BluetoothStatusListener = (changed: Partial<BluetoothStatus>) => void
type GlassesStatusListener = (changed: Partial<GlassesStatus>) => void

const mentraBluetoothSdkAdapter = {
  addListener: BluetoothSdk.addListener.bind(BluetoothSdk) as AddBluetoothListener,
  getBluetoothStatus: () => BluetoothSdk.getBluetoothStatus(),
  getGlassesStatus: () => BluetoothSdk.getGlassesStatus(),
  onBluetoothStatus: (callback: BluetoothStatusListener) => BluetoothSdk.onBluetoothStatus(callback),
  onGlassesStatus: (callback: GlassesStatusListener) => BluetoothSdk.onGlassesStatus(callback),
  updateSettings: (values: Record<string, any>) => BluetoothSdk.updateBluetoothSettings(values),
}

export default mentraBluetoothSdkAdapter
