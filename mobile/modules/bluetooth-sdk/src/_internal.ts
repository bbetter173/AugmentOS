/**
 * MentraOS-only compatibility entrypoint.
 *
 * Partner apps should import from `@mentra/bluetooth-sdk`. This subpath keeps
 * legacy MentraOS adapter methods available while the app is migrated onto the
 * public SDK surface.
 */
export {default} from "./_private/BluetoothSdkModule"
export type {BluetoothSdkInternalModule} from "./_private/BluetoothSdkModule"
export * from "./BluetoothSdk.types"
