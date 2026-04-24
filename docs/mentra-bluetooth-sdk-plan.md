# Mentra Bluetooth SDK Plan

## Overview

The **Mentra Bluetooth SDK** is a standalone SDK for communicating with smart glasses. It provides a unified API for Bluetooth communication, audio streaming, display control, and device management.

### Why Build This?

Enterprise customers want to integrate smart glasses into their own mobile apps without using MentraOS or our cloud infrastructure. They need a simple SDK that handles the complex BLE protocols, audio codecs, and device quirks - and that's it.

### What Is It?

Most of the device logic already lives in `mobile/modules/core`, but packaging, naming, autolinking, publishing, and MentraOS-specific cleanup are still substantial work. The main tasks are:

1. Rename it (`core` → `bluetooth-sdk`)
2. Remove MentraOS-specific code (move to `crust` module)
3. Delete duplicate cloud-formatting functions (handle in TypeScript instead)
4. Publish to npm, Maven Central, and CocoaPods
5. Write documentation
6. Create a React Native example app

### Current Hardware Implementations

This is a descriptive list of what the module currently contains, not a restrictive compatibility matrix:

- **MentraLive** (K900/BES2800) - Camera/mic glasses
- **MentraNex** / **MentraDisplay** - Protobuf-based display glasses
- **G1** - Display glasses
- **G2** - Display glasses
- **Mach1** - Display glasses
- **Vuzix Z100** - Display glasses
- **Simulated** - For testing without hardware

### Key Distinction

**MentraOS** is an operating system and application that _uses_ the Mentra Bluetooth SDK. The target end state for the Bluetooth SDK is a mostly hardware-focused module: BLE, audio, display, camera, device management.

In practice, we have historically thrown some MentraOS-specific native helpers into `core` whenever we needed them quickly, especially Android-side app features like notification forwarding. This plan cleans that up by moving obvious app-layer/native MentraOS code into `crust`.

A few MentraLive-specific plumbing paths still stay in Bluetooth SDK because the hardware depends on them today, including `core_token`, `auth_email`, and incident context sent down to the device.

## Monorepo Approach

Everything stays in the existing monorepo structure. We rename `core` to `bluetooth-sdk` and move MentraOS-specific code to `crust`.

```
mobile/modules/
├── bluetooth-sdk/           # Renamed from core - publishes as SDK
│   ├── src/                 # TypeScript interface
│   ├── android/             # Android native (com.mentra.bluetoothsdk)
│   └── ios/                 # iOS native (MentraBluetoothSDK)
│
└── crust/                   # MentraOS-specific native code
    ├── src/                 # TypeScript interface
    ├── android/             # Android (com.mentra.crust)
    └── ios/                 # iOS (MentraCrust)
```

---

## What Stays in Bluetooth SDK vs Moves to Crust

### Bluetooth SDK (Hardware Communication)

Everything that talks directly to glasses hardware:

**State Keys (GlassesStore):**

```
# GLASSES STATE (hardware reported):
batteryLevel, charging, connected, connectionState, deviceModel
firmwareVersion, micEnabled, btcConnected, caseRemoved, caseOpen
caseCharging, caseBatteryLevel, headUp, serialNumber, style, color
wifiSsid, wifiConnected, wifiLocalIp, hotspotEnabled, hotspotSsid
hotspotPassword, hotspotGatewayIp, bluetoothName, fullyBooted

# BLUETOOTH SDK STATE:
systemMicUnavailable, searching, micEnabled, currentMic
searchResults, wifiScanResults, micRanking, lastLog

# DEVICE SETTINGS (sent to hardware):
default_wearable, pending_wearable, device_name, device_address
brightness, auto_brightness, dashboard_height, dashboard_depth
head_up_angle, preferred_mic, lc3_frame_size
button_mode, button_photo_size, button_camera_led
button_max_recording_time, button_video_width, button_video_height
button_video_fps, gallery_mode, screen_disabled, sensing_enabled
```

**SGC Implementations:**

- MentraLive (K900/BES2800)
- MentraNex (Protobuf-based)
- G1
- G2
- Mach1
- Vuzix Z100
- Simulated

**Bluetooth SDK Functionality:**

- BLE connection management
- Audio streaming (LC3/PCM) - LC3 codec included
- Microphone capture
- Display rendering (text, images)
- Camera control (photo, video, RTMP)
- WiFi/Hotspot configuration
- Battery monitoring
- Button/gesture events
- IMU data
- Local STT (SherpaOnnx) - Optional, models not included by default
- ForegroundService for background BLE
- Protobuf support (for MentraNex/MentraDisplay protocol)

**Native Dependencies Included:**

- LC3 codec (required for audio)
- Protobuf (for MentraNex/MentraDisplay - naming is legacy but required)
- SherpaOnnx (optional - user supplies models)

**Bridge Events (notable device events surfaced to JS):**

- `head_up`, `button_press`, `touch_event`
- `mic_pcm`, `mic_lc3`, `local_transcription`
- `wifi_status_change`, `hotspot_status_change`, `gallery_status`
- `stream_status`, `imu_data_event`, `imu_gesture_event`
- `ota_update_available`, `ota_progress`

Battery/status cleanup is still part of Phase 3. There are a few older native helpers that still format MentraOS-specific payloads instead of exposing a clean typed event path.

**Local STT Control:**

The Bluetooth SDK includes optional local speech-to-text (SherpaOnnx). In this plan, leave the current offline STT control flow as-is:

```
offline_mode              # MentraOS TypeScript setting for offline behavior
offline_captions_running  # MentraOS TypeScript setting tracking offline captions state
```

Do not introduce a new STT control key in this workstream. The offline STT refactor is happening separately.

### Crust (MentraOS-Specific)

Everything that's about the MentraOS application layer.

**Note:** `contextual_dashboard` STAYS in Bluetooth SDK - it's actually used in `sendCurrentState()` and `displayEvent()` to control whether dashboard content shows when user looks up.

**Note:** `auth_email` and `core_token` stay in Bluetooth SDK. MentraLive currently reads them from `GlassesStore` and sends them down to hardware / the ASG client during init, so they cannot move cleanly to Crust yet.

**Note:** Leave `offline_mode` and `offline_captions_running` unchanged in this plan. That STT control refactor is being handled separately.

**Note:** Do not spend time on dead native setting cleanup in this workstream unless it directly helps the rename/extraction.

**Services to Move:**

- `NotificationListener` - Phone notification forwarding (MentraOS feature)

**Services that STAY in Bluetooth SDK:**

- `ForegroundService` - Required for maintaining BLE connection in background (hardware need)

**Bridge Functions - DELETE (not move):**

These duplicate functions format data for MentraOS cloud protocol. They will be DELETED from native code entirely. The TypeScript layer will handle cloud formatting instead (see Phase 3).

- `sendVadStatus()` - DELETE (TypeScript will format)
- `sendBluetoothStatusUpdate()` - DELETE (TypeScript will format)
- Button press helper naming/path should be standardized, but keep the current typed event behavior on both platforms
- `sendPhotoResponse()` - DELETE (TypeScript will format)
- `sendHeadPosition()` - DELETE (use `sendHeadUp()` instead)
- `sendVideoStreamResponse()` - DELETE (TypeScript will format)
- `updateAsrConfig()` - DELETE (TypeScript will format)
- `sendPhoneNotification()` - Moves to Crust with NotificationListener
- `sendPhoneNotificationDismissed()` - Moves to Crust with NotificationListener

---

## Phase 1: Rename and Restructure

### 1.1 Rename core to bluetooth-sdk

```bash
# In mobile/modules/
mv core bluetooth-sdk

# Update all imports and references
```

**Files to update:**

- `bluetooth-sdk/package.json` - name: `@mentra/bluetooth-sdk`
- `bluetooth-sdk/android/` - package: `com.mentra.bluetoothsdk`
- `bluetooth-sdk/ios/` - module: `MentraBluetoothSDK`
- `bluetooth-sdk/expo-module.config.json`
- All imports in `mobile/src/` that reference `@mentra/core`

### 1.2 Update Namespaces

**Android:**

```kotlin
// Before: com.mentra.core
// After: com.mentra.bluetoothsdk

package com.mentra.bluetoothsdk

class BluetoothSdkModule : Module() { ... }
class DeviceManager { ... }  // renamed from CoreManager
class DeviceStore { ... }    // renamed from GlassesStore
```

**iOS:**

```swift
// Before: MentraCore module
// After: MentraBluetoothSDK module

public class BluetoothSdk { ... }
public class DeviceManager { ... }  // renamed from CoreManager
public class DeviceStore { ... }    // renamed from GlassesStore
```

**TypeScript:**

```typescript
// Before
import {CoreModule} from "@mentra/core"

// After
import {BluetoothSdk} from "@mentra/bluetooth-sdk"
```

---

## Phase 2: Extract MentraOS Code to Crust

### 2.1 Move NotificationListener

**From:** `bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/services/NotificationListener.kt`
**To:** `crust/android/src/main/java/com/mentra/crust/services/NotificationListener.kt`

**Also move from Bluetooth SDK's AndroidManifest.xml to Crust's AndroidManifest.xml:**

```xml
<service android:name="com.mentra.crust.services.NotificationListenerServiceImpl"
    android:label="@string/app_name"
    android:exported="false"
    android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
    <intent-filter>
        <action android:name="android.service.notification.NotificationListenerService"/>
    </intent-filter>
    ...
</service>
```

Crust handles listening to phone notifications and emits MentraOS events to the mobile TypeScript layer for cloud reporting. We intentionally are not adding a generic Bluetooth SDK "send notification to display" API in this phase.

### 2.2 Move OS-Specific State

Keep the state split practical in this branch:

- Move obvious MentraOS-only native features to Crust, especially notification listening / permission management
- Move app/build-environment native helpers such as beta-build detection to Crust
- Keep hardware-driven state and settings in Bluetooth SDK
- Keep `contextual_dashboard`, `auth_email`, `core_token`, and incident plumbing in Bluetooth SDK for now because current hardware paths still depend on them
- Leave offline STT control (`offline_mode` / `offline_captions_running`) unchanged in this workstream

### 2.3 Update GlassesStore.apply()

Remove MentraOS-specific side effects from Bluetooth SDK. The `apply()` function should only handle hardware-related side effects:

**Keep in Bluetooth SDK:**

```kotlin
// Hardware lifecycle/state side effects
"glasses" to "fullyBooted" -> handleDeviceReady()/handleDeviceDisconnected()
"glasses" to "controllerFullyBooted" -> handleControllerReady()/handleControllerDisconnected()
"glasses" to "controllerMacAddress" -> sgc?.connectController()
"glasses" to "headUp" -> sendCurrentState(); sendHeadUp(...)

// Hardware settings
"bluetooth" to "brightness" -> sgc?.setBrightness(...)
"bluetooth" to "auto_brightness" -> sgc?.setBrightness(...)
"bluetooth" to "dashboard_height" -> sgc?.setDashboardHeightOnly(...)
"bluetooth" to "dashboard_depth" -> sgc?.setDashboardDepthOnly(...)
"bluetooth" to "head_up_angle" -> sgc?.setHeadUpAngle(...)
"bluetooth" to "dashboard_menu_apps" -> sgc?.setDashboardMenu(...)
"bluetooth" to "gallery_mode" -> sgc?.sendGalleryMode()
"bluetooth" to "screen_disabled" -> sgc?.exit()/clearDisplay()
"bluetooth" to "button_mode" -> sgc?.sendButtonModeSetting()
"bluetooth" to "button_photo_size" -> sgc?.sendButtonPhotoSettings()
"bluetooth" to "button_camera_led" -> sgc?.sendButtonCameraLedSetting()
"bluetooth" to "button_max_recording_time" -> sgc?.sendButtonMaxRecordingTime()
"bluetooth" to "camera_fov" -> sgc?.sendCameraFovSetting()
"bluetooth" to "button_video_width" -> sgc?.sendButtonVideoRecordingSettings()
"bluetooth" to "button_video_height" -> sgc?.sendButtonVideoRecordingSettings()
"bluetooth" to "button_video_fps" -> sgc?.sendButtonVideoRecordingSettings()
"bluetooth" to "preferred_mic" -> setMicState(...)
"bluetooth" to "default_wearable" -> initSGC(...)

// Explicit Phase 2 exceptions
"bluetooth" to "offline_captions_running" -> setMicState(...)
"bluetooth" to "should_send_pcm" -> setMicState(...)
"bluetooth" to "should_send_lc3" -> setMicState(...)
"bluetooth" to "should_send_transcript" -> setMicState(...)
```

`auth_email` and `core_token` remain Bluetooth SDK state for MentraLive plumbing, but they do not need `apply()` side-effect branches because hardware paths read the latest values directly from `DeviceStore`.

**Offline STT Note:**

Keep the existing offline STT settings and handlers as-is in this plan. Do not add `local_stt_active`, and do not remove the current `offline_mode` / `offline_captions_running` wiring here.

---

## Phase 3: Clean Up Bridge.kt

### 3.1 Keep (Hardware Events)

The important rule here is behavior, not perfect Android/iOS naming symmetry. Today:

- Android already uses `sendButtonPressEvent()` for the typed `button_press` event
- iOS still uses `sendButtonPress()`, but that helper already emits the typed `button_press` event rather than formatting a cloud payload
- `sendBatteryStatus()` is still inconsistent and should be normalized during this cleanup

```kotlin
// Raw hardware events - stay in Bluetooth SDK
fun sendHeadUp(isUp: Boolean)
fun sendButtonPressEvent(buttonId: String, pressType: String) // Android today
fun sendButtonPress(buttonId: String, pressType: String)      // iOS today; standardize naming later
fun sendTouchEvent(deviceModel: String, gestureName: String, timestamp: Long)
fun sendMicPcm(data: ByteArray)
fun sendMicLc3(data: ByteArray)
fun sendLocalTranscription(text: String, isFinal: Boolean, language: String)
fun sendBatteryStatus(level: Int, charging: Boolean) // currently inconsistent; normalize in cleanup
fun sendDiscoveredDevice(deviceModel: String, deviceName: String)
fun sendWifiStatusChange(connected: Boolean, ssid: String?, localIp: String?)
fun sendHotspotStatusChange(enabled: Boolean, ssid: String, password: String, gatewayIp: String)
fun sendGalleryStatus(...)
fun sendImuDataEvent(...)
fun sendImuGestureEvent(...)
fun sendOtaUpdateAvailable(...)
fun sendOtaProgress(...)
fun sendStreamStatus(...)
fun sendSwipeVolumeStatus(...)
fun sendSwitchStatus(...)
fun sendRgbLedControlResponse(...)
fun sendMtkUpdateComplete(...)
fun sendPairFailureEvent(...)
fun sendAudioConnected(...)
fun sendAudioDisconnected(...)
fun saveSetting(key: String, value: Any)
fun log(message: String)
```

### 3.2 Delete Duplicate Cloud-Formatting Functions (Technical Debt Cleanup)

These functions are duplicates that format data for MentraOS cloud protocol. They shouldn't exist in native code at all - the TypeScript layer already has the WebSocket connection and should handle all cloud protocol formatting.

**DELETE from Bridge.kt (and Bridge.swift):**

```kotlin
// These are redundant - raw events already go to JS, format in TypeScript instead
fun sendVadStatus(isSpeaking: Boolean)        // DELETE - use raw VAD event
fun sendBluetoothStatusUpdate(status: Map<String, Any>)  // DELETE - format in TS
fun sendPhotoResponse(...)                     // DELETE - format in TS
fun sendHeadPosition(...)                      // DELETE - sendHeadUp() exists
fun sendVideoStreamResponse(...)              // DELETE - format in TS
fun updateAsrConfig(...)                       // DELETE - format in TS
fun sendPhoneNotification(...)                // MOVE to Crust with NotificationListener
fun sendPhoneNotificationDismissed(...)       // MOVE to Crust with NotificationListener
```

**Button Press Cleanup:**

- Android already uses `sendButtonPressEvent()`
- iOS `sendButtonPress()` already behaves like a raw typed event emitter
- End state: one typed `button_press` path on both platforms, no cloud-formatting detour through `ws_text`

**Battery Cleanup:**

- `sendBatteryStatus()` emits the typed `battery_status` event on both platforms
- MentraOS app code formats the cloud `glasses_battery_update` payload in TypeScript

**KEEP typed/raw hardware event emitters:**

```kotlin
fun sendButtonPressEvent() // Android naming today
fun sendButtonPress()      // iOS naming today
fun sendHeadUp()           // Raw hardware event to app
// etc.
```

**Migration:**

1. Find all call sites of the duplicate functions in native code
2. Update them to use the raw event emitters instead
3. Handle cloud protocol formatting in MentraOS TypeScript layer
4. Delete the duplicate functions

**Exception - NotificationListener:**
`sendPhoneNotification()` and `sendPhoneNotificationDismissed()` are called from `NotificationListener` service. Since that service moves to Crust, these either:

- Move to Crust (if we want native notification formatting)
- Or NotificationListener emits raw events and TypeScript formats them

### 3.3 Keep Generic WebSocket Passthrough

```kotlin
// These stay but are just generic passthrough to JS
fun sendWSText(msg: String)
fun sendWSBinary(data: ByteArray)
```

### 3.4 Public API Surface After Phase 3

The Bluetooth SDK public React Native surface is the Expo module exported by `@mentra/bluetooth-sdk`. External app code should interact with it through typed async methods and typed event subscriptions, not native `Bridge.kt` / `Bridge.swift` helpers.

**Connection and status methods:**

```ts
await BluetoothSdk.getBluetoothStatus()
await BluetoothSdk.getGlassesStatus()
await BluetoothSdk.findCompatibleDevices()
await BluetoothSdk.requestStatus()
await BluetoothSdk.connectDefault()
await BluetoothSdk.connectByName(deviceName)
await BluetoothSdk.connectDefaultController()
await BluetoothSdk.disconnectController()
await BluetoothSdk.connectSimulated()
await BluetoothSdk.disconnect()
await BluetoothSdk.forget()
await BluetoothSdk.forgetController()
await BluetoothSdk.showDashboard()
await BluetoothSdk.ping()
```

**Display, camera, WiFi, OTA, audio, and streaming commands:**

```ts
await BluetoothSdk.displayEvent(params)
await BluetoothSdk.displayText(params)
await BluetoothSdk.clearDisplay()
await BluetoothSdk.sendIncidentId(incidentId, apiBaseUrl)
await BluetoothSdk.photoRequest(...)
await BluetoothSdk.queryGalleryStatus()
await BluetoothSdk.requestWifiScan()
await BluetoothSdk.sendWifiCredentials(ssid, password)
await BluetoothSdk.forgetWifiNetwork(ssid)
await BluetoothSdk.setHotspotState(enabled)
await BluetoothSdk.logCurrentWifiFrequency()
await BluetoothSdk.sendOtaStart()
await BluetoothSdk.requestVersionInfo()
await BluetoothSdk.startBufferRecording()
await BluetoothSdk.stopBufferRecording()
await BluetoothSdk.saveBufferVideo(requestId, durationSeconds)
await BluetoothSdk.startVideoRecording(requestId, save, flash, sound)
await BluetoothSdk.stopVideoRecording(requestId)
await BluetoothSdk.startStream(...)
await BluetoothSdk.stopStream()
await BluetoothSdk.keepStreamAlive(...)
await BluetoothSdk.setMicState(sendPcmData, sendTranscript, bypassVad)
await BluetoothSdk.restartTranscriber()
await BluetoothSdk.setOwnAppAudioPlaying(playing)
await BluetoothSdk.getGlassesMediaVolume()
await BluetoothSdk.setGlassesMediaVolume(level)
await BluetoothSdk.rgbLedControl(...)
await BluetoothSdk.setSttModelDetails(path, languageCode)
await BluetoothSdk.getSttModelPath()
await BluetoothSdk.checkSttModelAvailable()
await BluetoothSdk.validateSttModel(path)
await BluetoothSdk.extractTarBz2(sourcePath, destinationPath)
```

**Typed store helpers:**

```ts
await BluetoothSdk.updateBluetoothSettings(values)
await BluetoothSdk.updateGlasses(values)
BluetoothSdk.onBluetoothStatus(callback)
BluetoothSdk.onGlassesStatus(callback)
```

`BluetoothSdk.update(category, values)` remains the low-level native store bridge used by these typed helpers. External callers should prefer `updateBluetoothSettings()` and `updateGlasses()` so the internal native store category names (`"bluetooth"` / `"glasses"`) do not become part of the partner-facing API. Native stores still accept `"core"` as a legacy alias for `"bluetooth"` to avoid silently splitting persisted state during the rename.

**Typed hardware/app events emitted to JavaScript:**

```ts
BluetoothSdk.addListener("bluetooth_status", handler)
BluetoothSdk.addListener("glasses_status", handler)
BluetoothSdk.addListener("button_press", handler)
BluetoothSdk.addListener("touch_event", handler)
BluetoothSdk.addListener("head_up", handler)
BluetoothSdk.addListener("vad_status", handler)
BluetoothSdk.addListener("battery_status", handler)
BluetoothSdk.addListener("photo_response", handler)
BluetoothSdk.addListener("gallery_status", handler)
BluetoothSdk.addListener("wifi_status_change", handler)
BluetoothSdk.addListener("hotspot_status_change", handler)
BluetoothSdk.addListener("stream_status", handler)
BluetoothSdk.addListener("keep_alive_ack", handler)
BluetoothSdk.addListener("ota_update_available", handler)
BluetoothSdk.addListener("ota_progress", handler)
BluetoothSdk.addListener("save_setting", handler)
```

**MentraOS app-layer formatting:**

The SDK emits raw/typed events. MentraOS-specific cloud protocol messages stay in the app layer:

```ts
BluetoothSdk.addListener("head_up", (event) => socketComms.sendHeadPosition(event.up))
BluetoothSdk.addListener("vad_status", (event) => socketComms.sendVadStatus(event.status))
BluetoothSdk.addListener("battery_status", (event) =>
  socketComms.sendBatteryStatus(event.level, event.charging, event.timestamp),
)
BluetoothSdk.addListener("photo_response", (event) => restComms.sendPhotoResponse(event))
```

`ws_text` and `ws_bin` remain available as generic passthrough events for current legacy streaming/websocket paths, but new features should prefer dedicated typed events.

---

## Native SDK Architecture

The current codebase already has most of the device logic grouped in one module, which is a good starting point for a standalone SDK. The desired end state is now a **bare Android and bare iOS SDK first**, with React Native/Expo treated as a thin adapter used by MentraOS and only exposed externally later if needed.

The native SDK entry points should become the stable product API:

- Android: public Kotlin/Java API in `com.mentra.bluetoothsdk`
- iOS: public Swift API in `MentraBluetoothSDK`

The React Native / Expo entry points become adapters over that native API:

- `BluetoothSdkModule.kt` (Android entry point)
- `BluetoothSdkModule.swift` (iOS entry point)

**Architecture:**

```
com.mentra.bluetoothsdk (Android) / MentraBluetoothSDK (iOS)
├── DeviceManager          # Main orchestrator
├── DeviceStore            # State management
├── Bridge                 # Event emission
├── sgcs/                  # Device implementations
│   ├── MentraLive
│   ├── MentraNex / MentraDisplay
│   ├── G1 / G2
│   ├── Mach1 / Z100
│   └── Simulated
├── MentraBluetoothSdk     # Public native SDK facade
└── BluetoothSdkModule     # Expo wrapper / JS entry point over native facade
```

**For Native Apps:**

- Target end state: use the library directly via Maven/CocoaPods
- Native consumers should initialize a stable SDK facade, not call `DeviceManager` / `DeviceStore` directly
- Android and iOS should expose equivalent commands, state snapshots, and typed events/callbacks
- Pure native consumption is not done until sample bare Android and bare iOS apps build and run against the SDK

**For React Native Apps:**

- MentraOS can continue to use the Expo module
- The Expo module should call the native SDK facade instead of owning SDK behavior
- External React Native support becomes optional once the native APIs are stable

---

## Phase 4: Publishing Infrastructure

### 4.0 What Still Needs Cleanup Before Publishing

Publishing is not just opening registry accounts. Before release we still need to:

- Finish the rename from `core` / `device-bridge` to `bluetooth-sdk` across package names, namespaces, podspec/module names, and docs
- Replace template metadata and placeholder repository/package info with Mentra-owned values
- Remove or generalize monorepo-specific assumptions in Expo config plugins, Gradle paths, and Podfile modifications so the package installs cleanly outside MentraOS
- Verify the external install flow end-to-end for React Native, Maven Central, and CocoaPods before first release

Implemented in this phase:

- npm publish metadata now includes explicit files, public publish config, and peer dependency ranges.
- Android Gradle now has Maven publication metadata for `com.mentra:bluetooth-sdk`.
- CocoaPods metadata is package-driven, includes privacy resources, and no longer relies on monorepo user target paths.
- Expo config plugins no longer mutate host Podfiles with MentraOS-specific project names, Firebase pods, or privacy exclusions.

Still intentionally not done in-code:

- Registry/account setup, signing secrets, and automated release CI.
- Swift Package Manager support and pure native iOS/Android consumption. The current module still depends on React Native / Expo module packaging and bundled native assets, so this needs a separate design pass rather than a cosmetic `Package.swift`.

### 4.1 Package Configuration

**bluetooth-sdk/package.json:**

```json
{
  "name": "@mentra/bluetooth-sdk",
  "version": "0.1.0",
  "description": "SDK for communicating with smart glasses",
  "main": "build/index.js",
  "types": "build/index.d.ts",
  "react-native": "src/index.ts",
  "files": [
    "android",
    "app.plugin.js",
    "build",
    "expo-module.config.json",
    "ios",
    "plugin/build",
    "README.md",
    "src",
    "!src/__tests__"
  ],
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/Mentra-Community/MentraOS.git",
    "directory": "mobile/modules/bluetooth-sdk"
  },
  "keywords": ["react-native", "expo", "smart-glasses", "bluetooth", "ble", "ar-glasses"],
  "peerDependencies": {
    "expo": ">=49.0.0",
    "react": ">=18.0.0",
    "react-native": ">=0.72.0"
  }
}
```

### 4.2 Android Publishing (Maven Central)

**bluetooth-sdk/android/build.gradle additions:**

```gradle
apply plugin: 'maven-publish'
apply plugin: 'signing'

group = 'com.mentra'
version = packageJson.version

android {
    namespace 'com.mentra.bluetoothsdk'

    publishing {
        singleVariant("release") {
            withSourcesJar()
            withJavadocJar()
        }
    }
}

publishing {
    publications {
        release(MavenPublication) {
            groupId = 'com.mentra'
            artifactId = 'bluetooth-sdk'
            version = project.version

            from components.release

            pom {
                name = 'Mentra Bluetooth SDK'
                description = 'SDK for communicating with smart glasses'
                url = 'https://github.com/Mentra-Community/MentraOS'
                licenses {
                    license {
                        name = 'MIT License'
                        url = 'https://opensource.org/licenses/MIT'
                    }
                }
            }
        }
    }
}
```

### 4.3 iOS Publishing (CocoaPods + SPM)

**bluetooth-sdk/ios/MentraBluetoothSDK.podspec:**

```ruby
Pod::Spec.new do |s|
  s.name             = 'MentraBluetoothSDK'
  s.version          = package['version']
  s.summary          = 'SDK for communicating with smart glasses'
  s.homepage         = 'https://github.com/Mentra-Community/MentraOS'
  s.license          = 'MIT'
  s.author           = 'Mentra'
  s.source           = { :git => 'https://github.com/Mentra-Community/MentraOS.git', :tag => "bluetooth-sdk-v#{s.version}" }

  s.ios.deployment_target = '15.1'
  s.swift_version = '5.9'
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp,c}'
  s.frameworks = 'CoreBluetooth', 'AVFoundation'
  s.resource_bundles = {
    'MentraBluetoothSDKPrivacy' => ['Source/PrivacyInfo.xcprivacy']
  }
end
```

### 4.4 iOS Privacy Manifest (Required by Apple)

**bluetooth-sdk/ios/Source/PrivacyInfo.xcprivacy:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSPrivacyTracking</key>
    <false/>
    <key>NSPrivacyCollectedDataTypes</key>
    <array/>
    <key>NSPrivacyTrackingDomains</key>
    <array/>
    <key>NSPrivacyAccessedAPITypes</key>
    <array>
        <!-- UserDefaults for settings storage -->
        <dict>
            <key>NSPrivacyAccessedAPIType</key>
            <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
            <key>NSPrivacyAccessedAPITypeReasons</key>
            <array>
                <string>CA92.1</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
```

### 4.5 Versioning

Bluetooth SDK and Crust versions will be kept in sync for simplicity. When either changes, both get a version bump. This avoids compatibility matrix headaches.

---

## Phase 5: Documentation

Phase 5 documentation should be split by audience:

- The public package README stays intentionally thin: install, minimal usage, and partner support pointer.
- Detailed getting started material, API reference, production checklist, troubleshooting, and example apps live in a new private partner repo so they can be bundled with partner/commercial SDK access.

Private repo name: `Mentra-Bluetooth-SDK-Partner-Kit`.

### 5.1 Public README for Bluetooth SDK

The npm/package README should not become the full customer playbook. Keep it short:

- Package purpose
- Development-build requirement
- Install commands
- Minimal connect/display snippet
- Pointer to private partner docs for full onboarding and support

### 5.2 Private Partner Documentation Repo

Initial contents:

- `README.md`
- `docs/getting-started.md`
- `docs/api-reference.md`
- `docs/display-guide.md`
- `docs/audio-guide.md`
- `docs/hardware-integration.md`
- `docs/troubleshooting.md`
- `docs/production-checklist.md`
- `examples/react-native`

The private repo should be the customer-facing source of truth for:

- Bare Android setup
- Bare iOS setup
- Device scanning/discovery
- Connection management
- Display text/images
- Audio streaming and local transcription
- Button/gesture/head-up events
- Camera/gallery/streaming APIs
- OTA and production release validation

### 5.3 Example App

The private repo should include bare native examples demonstrating:

- Device scanning/discovery
- Connection management
- Display text
- Display clearing
- Status subscriptions
- Button/battery event handling

React Native / Expo docs can remain a small MentraOS adapter note unless/until React Native becomes an external product requirement.

---

## Phase 6: Native SDK API Extraction

Goal: make the Bluetooth SDK a true bare Android and bare iOS SDK. React Native/Expo should be a wrapper over this API, not the core customer-facing integration path.

Detailed platform plans:

- Android: [Mentra Bluetooth SDK Android Native API Plan](./mentra-bluetooth-sdk-android-native-api-plan.md)
- iOS: [Mentra Bluetooth SDK iOS Native API Plan](./mentra-bluetooth-sdk-ios-native-api-plan.md)

### 6.0 Store Sync Decision

Today there are two state layers:

- MentraOS TypeScript uses Zustand stores such as `useSettingsStore`, `useBluetoothStore`, and `useGlassesStore`.
- The native Bluetooth SDK uses `DeviceStore` / `ObservableStore` for native hardware state and settings side effects.

The current bridge syncs blobs between those layers:

- MentraOS settings -> native through `BluetoothSdk.updateBluetoothSettings(...)`.
- Native `glasses_status` / `bluetooth_status` -> MentraOS Zustand stores.
- Native `save_setting` -> MentraOS `useSettingsStore.setSetting(...)`.

That is acceptable as a temporary MentraOS compatibility layer, but it should not be the public SDK paradigm. External native customers should use typed commands and typed events, not key/value store categories or MentraOS setting names.

Phase 6 should move toward this boundary:

- Keep Zustand as the MentraOS app state layer.
- Keep native `DeviceStore` as an internal SDK implementation detail for now.
- Add public native facades that expose typed commands/events and hide native store sync.
- Let MentraOS have an adapter/service that watches Zustand and calls typed SDK methods.
- Keep `updateBluetoothSettings(...)`, `"core"` category normalization, and `save_setting` only as compatibility plumbing while MentraOS migrates.
- Do not document store blob syncing in the Partner Kit or customer-facing native API docs.

### 6.1 Public Android API

Create a stable Kotlin/Java facade, for example:

```kotlin
class MentraBluetoothSdk private constructor(
    private val context: Context,
    private val listener: MentraBluetoothSdkListener,
) {
    companion object {
        fun initialize(context: Context, listener: MentraBluetoothSdkListener): MentraBluetoothSdk
    }

    fun getGlassesStatus(): GlassesStatus
    fun getBluetoothStatus(): BluetoothStatus
    fun scan(model: String)
    fun connectDefault()
    fun connectByName(deviceName: String)
    fun disconnect()
    fun forget()
    fun displayText(request: DisplayTextRequest)
    fun clearDisplay()
    fun setMicState(sendPcmData: Boolean, sendTranscript: Boolean, bypassVad: Boolean)
}

interface MentraBluetoothSdkListener {
    fun onGlassesStatusChanged(status: GlassesStatusUpdate)
    fun onBluetoothStatusChanged(status: BluetoothStatusUpdate)
    fun onEvent(event: MentraBluetoothEvent)
    fun onLog(message: String)
}
```

Android extraction tasks:

- Add public Kotlin data classes for status, search results, display requests, and events.
- Move SDK initialization out of `BluetoothSdkModule` and into the native facade.
- Make `Bridge.initialize(context, callback)` usable without Expo/React Native.
- Ensure `DeviceManager` is controlled through the facade, not exposed as public API.
- Remove Android Gradle dependency on Expo module build plugins from the bare SDK artifact.
- Keep an Expo/RN adapter module that depends on the native SDK facade.
- Create a tiny bare Android sample app that uses Maven/local Gradle dependency and the public facade.

### 6.2 Public iOS API

Create a stable Swift facade, for example:

```swift
public final class MentraBluetoothSDK {
    public weak var delegate: MentraBluetoothSDKDelegate?

    public init(configuration: MentraBluetoothSDKConfiguration = .default)

    public func getGlassesStatus() async -> GlassesStatus
    public func getBluetoothStatus() async -> BluetoothStatus
    public func scan(model: String)
    public func connectDefault()
    public func connectByName(_ deviceName: String)
    public func disconnect()
    public func forget()
    public func displayText(_ request: DisplayTextRequest)
    public func clearDisplay()
    public func setMicState(sendPcmData: Bool, sendTranscript: Bool, bypassVad: Bool)
}

public protocol MentraBluetoothSDKDelegate: AnyObject {
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlassesStatus status: GlassesStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateBluetoothStatus status: BluetoothStatusUpdate)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didReceiveEvent event: MentraBluetoothEvent)
    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didLog message: String)
}
```

iOS extraction tasks:

- Add public Swift structs/enums for status, search results, display requests, and events.
- Make the public facade the only supported external API; keep `DeviceManager` internal.
- Make event emission work through delegate/closure callbacks without Expo/React Native.
- Remove `ExpoModulesCore` from the bare SDK podspec.
- Keep an Expo/RN adapter pod/module that depends on the native SDK facade.
- Add or defer SPM support based on dependency feasibility; CocoaPods is the first native target.
- Create a tiny bare iOS sample app that uses the CocoaPod and public facade.

### 6.3 MentraOS Adapter

MentraOS should continue to work, but it should use the native SDK through a thin adapter/service:

- `BluetoothSdkModule.kt` calls `MentraBluetoothSdk`.
- `BluetoothSdkModule.swift` calls `MentraBluetoothSDK`.
- A MentraOS TypeScript service watches relevant Zustand settings and calls typed SDK methods such as `setBrightness`, `setPreferredMic`, `connectDefault`, and `setMicState`.
- Native status callbacks update `useBluetoothStore` / `useGlassesStore`; MentraOS TypeScript remains responsible for cloud/websocket formatting.
- The legacy TypeScript API can remain stable during migration while native customers use the native facade.
- Generic store blob syncing should be deprecated once MentraOS has moved to typed calls.
- Existing regression tests should continue to pass with little/no changes.

### 6.4 Native API Documentation

Update `Mentra-Bluetooth-SDK-Partner-Kit` to lead with:

- Bare Android getting started
- Bare iOS getting started
- Native API reference
- Permission setup by platform
- Native sample apps
- React Native/Expo adapter note for MentraOS only

### 6.5 Validation

Phase 6 is not complete until:

- Bare Android sample app builds and can initialize the SDK.
- Bare iOS sample app runs `pod install`, builds, and can initialize the SDK.
- MentraOS still builds and uses the SDK through the Expo adapter.
- `podspec` and Gradle publication no longer require Expo modules for native consumers.
- Partner Kit docs match the native-first integration path.

---

## Implementation Checklist

### Phase 1: Rename (Week 1)

- [ ] Create branch `feature/bluetooth-sdk-rename`
- [ ] Rename `mobile/modules/core` to `mobile/modules/bluetooth-sdk`
- [ ] Update package.json name to `@mentra/bluetooth-sdk`
- [ ] Update Android package: `com.mentra.core` -> `com.mentra.bluetoothsdk`
- [ ] Update iOS module name
- [ ] Update all imports in `mobile/src/`
- [ ] Update expo-module.config.json
- [ ] Verify build works

### Phase 2: Extract to Crust (Week 2)

- [ ] Move NotificationListener service to Crust
- [ ] Move NotificationListener manifest entry to Crust
- [ ] Keep the state split practical instead of redesigning it:
  - [ ] Move obvious MentraOS-only native features to Crust
  - [ ] Keep `contextual_dashboard`, `auth_email`, `core_token`, and incident plumbing in Bluetooth SDK where hardware still depends on them
- [ ] Leave offline STT control (`offline_mode` / `offline_captions_running`) unchanged in this branch
- [ ] Update GlassesStore.apply() to remove handlers for deleted keys
- [ ] Create Crust TypeScript interface
- [ ] Wire up Crust to MentraOS app layer
- [ ] Verify MentraOS still works end-to-end

### Phase 3: Clean Up Bridge - Delete Duplicates (Week 2-3)

- [x] Audit all Bridge functions for duplicates
- [x] Find call sites of cloud-formatting functions in native code
- [x] Update call sites to use raw event emitters
- [x] Move cloud protocol formatting to TypeScript layer
- [x] Delete duplicate functions from Bridge.kt and Bridge.swift
- [x] Keep only raw hardware event emitters in Bluetooth SDK
- [x] Document public API surface

### Phase 4: Publishing Setup (Week 3)

- [ ] Set up Sonatype OSSRH account
- [x] Configure Gradle for Maven Central publishing metadata
- [x] Update CocoaPods podspec for external publishing
- [ ] Create Swift Package Manager manifest
- [x] Create iOS PrivacyInfo.xcprivacy manifest
- [x] Configure npm publishing metadata
- [ ] Set up CI/CD for automated publishing
- [ ] Ensure native library is usable without Expo (pure Android/iOS apps)

### Phase 5: Documentation & Example (Week 4)

- [ ] Create private GitHub partner docs repo and push scaffold
- [x] Draft private partner docs repo scaffold locally
- [x] Write thin public package README
- [x] Write private repo main README
- [x] Create initial private getting started guide
- [x] Document initial private API reference
- [ ] Rewrite Partner Kit docs around bare Android and bare iOS first
- [ ] Replace React Native example focus with bare Android and bare iOS samples
- [x] Create initial private example app demonstrating current wrapper path:
  - Device scanning/discovery
  - Connection management
  - Display text
  - Display clearing
  - Status subscriptions
  - Button/battery events
- [ ] Expand private example app with:
  - Display images
  - Audio streaming
  - Camera/gallery flows
- [ ] Validate a fresh third-party Expo/RN consumer app can install the published package, prebuild iOS/Android, and run `pod install`

### Phase 6: Native SDK API Extraction

- [ ] Define public Android facade and listener/event types
- [ ] Define public iOS facade and delegate/event types
- [ ] Document native `DeviceStore` as internal-only and keep it out of public API docs
- [ ] Move Expo module initialization/event forwarding behind native facades
- [ ] Add/define MentraOS TypeScript adapter that translates Zustand settings into typed SDK calls
- [ ] Keep `updateBluetoothSettings` as temporary compatibility plumbing only
- [ ] Keep `DeviceManager` / `DeviceStore` internal implementation details
- [ ] Remove Expo module dependency from bare Android publication artifact
- [ ] Remove `ExpoModulesCore` dependency from bare iOS podspec
- [ ] Keep MentraOS Expo adapter working on top of native facades
- [ ] Create bare Android sample app
- [ ] Create bare iOS sample app
- [ ] Update Partner Kit docs for native-first setup
- [ ] Validate bare Android sample build
- [ ] Validate bare iOS `pod install` and build
- [ ] Validate MentraOS mobile app still passes relevant regression tests

### Phase 7: MentraOS Migration

When we delete the duplicate cloud-formatting functions from Bridge, the MentraOS TypeScript layer needs to handle that formatting instead.

**Current flow:**

```
Android today: button pressed → Bridge.sendButtonPressEvent() emits typed event → TS handles / forwards as needed
iOS today: button pressed → Bridge.sendButtonPress() emits typed event → TS handles / forwards as needed

Some other helpers (battery / VAD / video / ws_text passthroughs) still format MentraOS cloud payloads in native and should move to TypeScript.
```

**New flow:**

```
Native: hardware emits typed/raw device events only → TypeScript formats any MentraOS cloud payloads that are still needed → TypeScript sends to WebSocket
```

**Files to update in MentraOS TypeScript:**

- Find where `ws_text` events are being listened to
- Make typed hardware events the source of truth (`button_press`, `head_up`, `touch_event`, etc.)
- Format the cloud protocol JSON in TypeScript
- Send via WebSocket from TypeScript

This is cleaner anyway - all cloud protocol logic lives in one place (TypeScript) instead of being split between native and TS.

### Phase 8: Release

- [ ] Final testing
- [ ] Publish v1.0.0 to all registries
- [ ] Announce release
- [ ] Update MentraOS to use published package (optional - can continue using monorepo)

---

## Success Criteria

1. **Published Packages**
   - `@mentra/bluetooth-sdk` on npm
   - `com.mentra:bluetooth-sdk` on Maven Central
   - `MentraBluetoothSDK` on CocoaPods

2. **Clean Separation**
   - Bluetooth SDK has no MentraOS-specific code
   - Crust contains all OS-specific native code
   - Enterprise customers can use Bluetooth SDK standalone

3. **Working Examples**
   - Example apps demonstrating standalone usage
   - Documentation for all platforms

4. **MentraOS Compatibility**
   - MentraOS app continues to work
   - Uses Bluetooth SDK + Crust together
   - No regression in functionality
