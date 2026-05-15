# @mentra/bluetooth-sdk

React Native and Expo SDK for connecting mobile apps directly to supported Mentra smart glasses over Bluetooth.

The package includes:

- A React Native / Expo module API exposed as `BluetoothSdk`.
- Native Android code published as `com.mentra:bluetooth-sdk`.
- Native iOS code published as the `MentraBluetoothSDK` CocoaPod.
- An Expo config plugin that wires the native dependencies into generated Android and iOS projects.

Use a development build or production native build. Expo Go cannot load this package because the SDK contains native code.

## Requirements

- React Native `0.72+`.
- Expo `49+` when using Expo.
- Android min SDK `28+`.
- iOS deployment target `15.1+`.
- A physical phone for real Bluetooth testing.
- Bluetooth permissions, plus Android location permission where BLE scanning requires it.

## Install

```sh
npm install @mentra/bluetooth-sdk
npx expo install expo-build-properties
```

For Expo apps, add the plugin to `app.json` or `app.config.ts`:

```json
{
  "expo": {
    "plugins": [
      [
        "@mentra/bluetooth-sdk",
        {
          "node": true
        }
      ],
      [
        "expo-build-properties",
        {
          "android": {
            "minSdkVersion": 28,
            "packagingOptions": {
              "pickFirst": [
                "**/libc++_shared.so",
                "**/libonnxruntime.so",
                "**/libonnxruntime4j_jni.so"
              ]
            }
          }
        }
      ]
    ]
  }
}
```

Then regenerate native projects and run a development build:

```sh
npx expo prebuild
npx expo run:ios
# or
npx expo run:android
```

## Permissions

Android apps should request the permissions required by the features they use:

```json
{
  "android": {
    "permissions": [
      "android.permission.BLUETOOTH",
      "android.permission.BLUETOOTH_ADMIN",
      "android.permission.BLUETOOTH_SCAN",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.RECORD_AUDIO",
      "android.permission.INTERNET",
      "android.permission.POST_NOTIFICATIONS"
    ]
  }
}
```

Some Android 12+ devices still require Location permission and Location services before BLE scan callbacks are delivered.

iOS apps should include usage descriptions:

```json
{
  "ios": {
    "infoPlist": {
      "NSBluetoothAlwaysUsageDescription": "This app connects to your smart glasses over Bluetooth.",
      "NSMicrophoneUsageDescription": "This app uses the microphone when you enable audio features.",
      "NSLocalNetworkUsageDescription": "This app connects to local photo and streaming helpers during development."
    }
  }
}
```

## Minimal Usage

`connectFirst()` scans for the first matching glasses and connects to them. It times out after 15 seconds by default. Use `startScan()` plus `onBluetoothStatus()` only when your app needs to present a custom device picker.

```ts
import BluetoothSdk, {
  DeviceModels,
  isReadyGlassesConnectionStatus,
} from '@mentra/bluetooth-sdk'

const removeGlassesListener = BluetoothSdk.onGlassesStatus((status) => {
  console.log('Glasses status changed', status)
})

await BluetoothSdk.connectFirst(DeviceModels.MentraLive)

const glasses = await BluetoothSdk.getGlassesStatus()
if (isReadyGlassesConnectionStatus(glasses.connection)) {
  await BluetoothSdk.displayText('Hello from Mentra', 0, 0, 24)
}

removeGlassesListener()
```

React Native status exposes `GlassesStatus.connection` as a discriminated union:

```ts
type GlassesConnectionStatus =
  | {state: 'disconnected'}
  | {state: 'scanning'}
  | {state: 'connecting'}
  | {state: 'bonding'}
  | {state: 'connected'; fullyBooted: boolean}
```

Use `connection.state` for link progress. `fullyBooted` only exists when `state === 'connected'`. Android and iOS native APIs also keep `connectionState`, `connected`, and `fullyBooted` as native status properties for Kotlin and Swift callers.

## Default Device

`connectDefault()` connects to the default glasses target currently stored in the SDK. Apps that want this target to survive app restarts should persist the scanned `Device` in app storage and restore it with `setDefaultDevice()` before calling `connectDefault()`.

```ts
const savedDevice = await loadSavedDeviceFromYourAppStorage()
if (savedDevice) {
  await BluetoothSdk.setDefaultDevice(savedDevice)
  await BluetoothSdk.connectDefault()
}

const discoveredDevice = await scanAndChooseDevice()
await BluetoothSdk.connect(discoveredDevice)
await saveDeviceToYourAppStorage(discoveredDevice)

await BluetoothSdk.clearDefaultDevice()
await saveDeviceToYourAppStorage(null)
```

## Common Commands

```ts
await BluetoothSdk.clearDisplay()
await BluetoothSdk.showDashboard()
await BluetoothSdk.setBrightness(60, false)
await BluetoothSdk.setDashboardPosition(4, 2)

await BluetoothSdk.requestWifiScan()
await BluetoothSdk.sendWifiCredentials('Office WiFi', 'secret')
await BluetoothSdk.forgetWifiNetwork('Office WiFi')
await BluetoothSdk.setHotspotState(true)

await BluetoothSdk.setGalleryMode('auto')
await BluetoothSdk.setGalleryMode('manual')

await BluetoothSdk.setPreferredMic('auto')
await BluetoothSdk.setMicState(true, true, false)
await BluetoothSdk.setOwnAppAudioPlaying(false)

await BluetoothSdk.rgbLedControl(
  `led-${Date.now()}`,
  'com.example.app',
  'on',
  'green',
  500,
  500,
  3,
)
```

## Photo Upload

```ts
await BluetoothSdk.photoRequest(
  `photo-${Date.now()}`,
  'com.example.app',
  'medium',
  'https://api.example.com/mentra/photo',
  'optional-token',
  'medium',
  false,
  true,
)
```

The webhook should accept multipart form data with a `photo` file and `requestId`. If `authToken` is provided, the uploader adds `Authorization: Bearer <token>`.

## Streaming

```ts
const streamId = `stream-${Date.now()}`

await BluetoothSdk.startStream({
  type: 'start_stream',
  streamUrl: 'http://192.168.1.42:8889/mentra-live/whip',
  streamId,
})

await BluetoothSdk.keepStreamAlive({
  type: 'keep_stream_alive',
  streamId,
  ackId: `ack-${Date.now()}`,
})

await BluetoothSdk.stopStream()
```

Use `rtmp://` or `rtmps://` for RTMP, `srt://` for SRT, and `http://` or `https://` for WHIP/WebRTC ingest. Send keep-alives about every 15 seconds while streaming.

## Events

```ts
const subscriptions = [
  BluetoothSdk.addListener('button_press', (event) => console.log(event)),
  BluetoothSdk.addListener('touch_event', (event) => console.log(event)),
  BluetoothSdk.addListener('photo_response', (event) => console.log(event)),
  BluetoothSdk.addListener('stream_status', (event) => console.log(event)),
  BluetoothSdk.addListener('mic_pcm', (event) => console.log(event.pcm)),
]

subscriptions.forEach((subscription) => subscription.remove())
```

Common event names include `button_press`, `touch_event`, `head_up`, `battery_status`, `wifi_status_change`, `hotspot_status_change`, `photo_response`, `gallery_status`, `stream_status`, `keep_alive_ack`, `mic_pcm`, `mic_lc3`, `local_transcription`, `rgb_led_control_response`, `audio_connected`, `audio_disconnected`, `log`, `send_command_to_ble`, and `receive_command_from_ble`.

## Local SDK Development

For normal app development, install the published npm package. For SDK development before a package release, install a local checkout and point Metro/native resolution at the same path:

```sh
npm install --no-save /path/to/MentraOS/mobile/modules/bluetooth-sdk
MENTRA_BLUETOOTH_SDK_PACKAGE_PATH=/path/to/MentraOS/mobile/modules/bluetooth-sdk npx expo run:ios
```

Use `npx expo run:android` for Android. Keep local paths in your shell or CI environment, not in committed app config.

## Example App

The partner example app lives in `Mentra-Bluetooth-SDK-Partner-Kit/examples/react-native`. It demonstrates scan/connect, display, camera photo upload, RTMP/SRT/WebRTC streaming, Wi-Fi/hotspot, microphone PCM, RGB LED, gallery-button mode, and console event inspection.
