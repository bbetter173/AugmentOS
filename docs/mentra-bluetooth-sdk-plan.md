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

# CORE STATE (SDK state):
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

**Core Functionality:**

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
- `sendCoreStatus()` - DELETE (TypeScript will format)
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

The Bluetooth SDK will expose a generic "send notification to display" API. Crust will handle listening to phone notifications and calling that API.

### 2.2 Move OS-Specific State

Keep the state split practical in this branch:

- Move obvious MentraOS-only native features to Crust, especially notification listening / permission management
- Keep hardware-driven state and settings in Bluetooth SDK
- Keep `contextual_dashboard`, `auth_email`, `core_token`, and incident plumbing in Bluetooth SDK for now because current hardware paths still depend on them
- Leave offline STT control (`offline_mode` / `offline_captions_running`) unchanged in this workstream

### 2.3 Update GlassesStore.apply()

Remove MentraOS-specific side effects from Bluetooth SDK. The `apply()` function should only handle hardware-related side effects:

**Keep in Bluetooth SDK:**

```kotlin
"core" to "brightness" -> sgc?.setBrightness(...)
"core" to "auto_brightness" -> sgc?.setBrightness(...)
"core" to "dashboard_height" -> sgc?.setDashboardHeightOnly(...)
"core" to "dashboard_depth" -> sgc?.setDashboardDepthOnly(...)
"core" to "head_up_angle" -> sgc?.setHeadUpAngle(...)
"core" to "gallery_mode" -> sgc?.sendGalleryMode()
"core" to "button_mode" -> sgc?.sendButtonModeSetting()
"core" to "button_photo_size" -> sgc?.sendButtonPhotoSettings()
"core" to "preferred_mic" -> setMicState(...)
"core" to "default_wearable" -> initSGC(...)
```

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
fun sendCoreStatus(status: Map<String, Any>)  // DELETE - format in TS
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

- `sendBatteryStatus()` does not yet match that clean end state on both platforms
- Today it still formats a `glasses_battery_update` payload over `ws_text`
- Decide during cleanup whether to replace that with a typed battery event path or keep it as an explicit passthrough on purpose

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

---

## Native SDK Architecture

The current codebase already has most of the device logic grouped in one module, which is a good starting point for a standalone SDK. But there is still cleanup to do around Expo module wrappers, config plugins, packaging metadata, and a few React Native assumptions before it is polished for external consumption.

The React Native / Expo entry points stay here:

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
└── BluetoothSdkModule     # Expo wrapper / JS entry point
```

**For Native Apps:**

- Target end state: use the library directly via Maven/CocoaPods
- Native consumers should be able to initialize `DeviceManager` and set up callbacks directly
- We still need the Phase 4 packaging cleanup before this is ready as a polished external story

**For React Native Apps:**

- Use `@mentra/bluetooth-sdk` npm package
- Expo module provides JS interface to native library

---

## Phase 4: Publishing Infrastructure

### 4.0 What Still Needs Cleanup Before Publishing

Publishing is not just opening registry accounts. Before release we still need to:

- Finish the rename from `core` / `device-bridge` to `bluetooth-sdk` across package names, namespaces, podspec/module names, and docs
- Replace template metadata and placeholder repository/package info with Mentra-owned values
- Remove or generalize monorepo-specific assumptions in Expo config plugins, Gradle paths, and Podfile modifications so the package installs cleanly outside MentraOS
- Verify the external install flow end-to-end for React Native, Maven Central, and CocoaPods before first release

### 4.1 Package Configuration

**bluetooth-sdk/package.json:**

```json
{
  "name": "@mentra/bluetooth-sdk",
  "version": "1.0.0",
  "description": "SDK for communicating with smart glasses",
  "main": "build/index.js",
  "types": "build/index.d.ts",
  "react-native": "src/index.ts",
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
plugins {
    id 'maven-publish'
    id 'signing'
}

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

            afterEvaluate {
                from components.release
            }

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
  s.version          = '1.0.0'
  s.summary          = 'SDK for communicating with smart glasses'
  s.homepage         = 'https://github.com/Mentra-Community/MentraOS'
  s.license          = { :type => 'MIT' }
  s.author           = { 'Mentra' => 'dev@mentra.glass' }
  s.source           = { :git => 'https://github.com/Mentra-Community/MentraOS.git', :tag => s.version.to_s }

  s.ios.deployment_target = '13.0'
  s.swift_version = '5.0'
  s.source_files = 'ios/Source/**/*.swift'
  s.frameworks = 'CoreBluetooth', 'AVFoundation'
  s.resource_bundles = {
    'MentraBluetoothSDK' => ['ios/Source/PrivacyInfo.xcprivacy']
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

### 5.1 README for Bluetooth SDK

```markdown
# Mentra Bluetooth SDK

SDK for communicating with smart glasses.

## Installation

### React Native / Expo

npm install @mentra/bluetooth-sdk

### Android (Maven)

implementation 'com.mentra:bluetooth-sdk:1.0.0'

### iOS (CocoaPods)

pod 'MentraBluetoothSDK'

## Quick Start

import BluetoothSdk from '@mentra/bluetooth-sdk';

const buttonSub = BluetoothSdk.addListener('button_press', (event) => {
  console.log('Button pressed:', event.buttonId);
});

// Find compatible devices for a model
await BluetoothSdk.findCompatibleDevices('Mentra Live');

// Connect using the saved/default device, or use connectByName(...)
await BluetoothSdk.connectDefault();

// Display text
await BluetoothSdk.displayText({
  text: 'Hello World',
  x: 0,
  y: 0,
  size: 24,
});

// Later
buttonSub.remove();
```

### 5.2 Documentation Site

- Getting Started (Android, iOS, React Native)
- API Reference
- Hardware Integration Notes
- Audio Streaming Guide
- Display Control Guide
- Camera Control Guide

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

- [ ] Audit all Bridge functions for duplicates
- [ ] Find call sites of cloud-formatting functions in native code
- [ ] Update call sites to use raw event emitters
- [ ] Move cloud protocol formatting to TypeScript layer
- [ ] Delete duplicate functions from Bridge.kt and Bridge.swift
- [ ] Keep only raw hardware event emitters in Bluetooth SDK
- [ ] Document public API surface

### Phase 4: Publishing Setup (Week 3)

- [ ] Set up Sonatype OSSRH account
- [ ] Configure Gradle for Maven Central publishing
- [ ] Create CocoaPods podspec
- [ ] Create Swift Package Manager manifest
- [ ] Create iOS PrivacyInfo.xcprivacy manifest
- [ ] Configure npm publishing
- [ ] Set up CI/CD for automated publishing
- [ ] Ensure native library is usable without Expo (pure Android/iOS apps)

### Phase 5: Documentation & Example (Week 4)

- [ ] Write main README
- [ ] Create getting started guide (React Native focus)
- [ ] Document API reference
- [ ] Create React Native example app demonstrating:
  - Device scanning/discovery
  - Connection management
  - Display text/images
  - Audio streaming
  - Button/gesture events

### Phase 6: MentraOS Migration

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

### Phase 7: Release

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
