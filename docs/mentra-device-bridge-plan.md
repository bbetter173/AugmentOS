# Mentra Device Bridge SDK Plan

## Overview

The **Mentra Device Bridge** is a standalone SDK for communicating with smart glasses. It provides a unified API for Bluetooth communication, audio streaming, display control, and device management.

### Why Build This?

Enterprise customers want to integrate smart glasses into their own mobile apps without using MentraOS or our cloud infrastructure. They need a simple SDK that handles the complex BLE protocols, audio codecs, and device quirks - and that's it.

### What Is It?

The Device Bridge is the existing `mobile/modules/core` module, cleaned up and published as a standalone package. It's already 95% of the way there - we just need to:

1. Rename it (`core` → `device-bridge`)
2. Remove MentraOS-specific code (move to `crust` module)
3. Delete duplicate cloud-formatting functions (handle in TypeScript instead)
4. Publish to npm, Maven Central, and CocoaPods

### Supported Devices

- **MentraLive** (K900/BES2800) - Camera/mic glasses
- **MentraNex** / **MentraDisplay** - Protobuf-based display glasses
- **G1** - Display glasses
- **Mach1** - Display glasses
- **Simulated** - For testing without hardware

### Key Distinction

**MentraOS** is an operating system and application that _uses_ the Mentra Device Bridge. The Device Bridge is purely hardware-focused - BLE, audio, display, camera. No cloud, no OS features, no notification forwarding.

## Monorepo Approach

Everything stays in the existing monorepo structure. We rename `core` to `device-bridge` and move MentraOS-specific code to `crust`.

```
mobile/modules/
├── device-bridge/           # Renamed from core - publishes as SDK
│   ├── src/                 # TypeScript interface
│   ├── android/             # Android native (com.mentra.devicebridge)
│   └── ios/                 # iOS native (MentraDeviceBridge)
│
└── crust/                   # MentraOS-specific native code
    ├── src/                 # TypeScript interface
    ├── android/             # Android (com.mentra.crust)
    └── ios/                 # iOS (MentraCrust)
```

---

## What Stays in Device Bridge vs Moves to Crust

### Device Bridge (Hardware Communication)

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
- Mach1
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

**Bridge Events (hardware events to JS):**

- `head_up`, `button_press`, `touch_event`, `battery_status`
- `mic_data`, `local_transcription`
- `wifi_status_change`, `hotspot_status_change`
- `gallery_status`, `rtmp_stream_status`
- `imu_data_event`, `imu_gesture_event`
- `ota_update_available`, `ota_progress`

### Crust (MentraOS-Specific)

Everything that's about the MentraOS application layer:

**State Keys to Move:**

```
# OS FEATURES:
contextual_dashboard      # OS decides when to show dashboard
always_on_status_bar      # OS UI preference
offline_mode              # OS offline caption feature
offline_captions_running  # OS offline caption state
metric_system             # OS display preference
power_saving_mode         # OS battery optimization
```

**Note:** `auth_email` and `auth_token` stay in Device Bridge because they get sent to MentraLive hardware via `sgc?.sendAuthEmail()`. Even though they're conceptually OS authentication, the hardware needs them.

**Services to Move:**

- `NotificationListener` - Phone notification forwarding (MentraOS feature)

**Services that STAY in Device Bridge:**

- `ForegroundService` - Required for maintaining BLE connection in background (hardware need)

**Bridge Functions - DELETE (not move):**

These duplicate functions format data for MentraOS cloud protocol. They will be DELETED from native code entirely. The TypeScript layer will handle cloud formatting instead (see Phase 3).

- `sendVadStatus()` - DELETE (TypeScript will format)
- `sendCoreStatus()` - DELETE (TypeScript will format)
- `sendButtonPress()` - DELETE (use `sendButtonPressEvent()` instead)
- `sendPhotoResponse()` - DELETE (TypeScript will format)
- `sendHeadPosition()` - DELETE (use `sendHeadUp()` instead)
- `sendVideoStreamResponse()` - DELETE (TypeScript will format)
- `updateAsrConfig()` - DELETE (TypeScript will format)
- `sendPhoneNotification()` - Moves to Crust with NotificationListener
- `sendPhoneNotificationDismissed()` - Moves to Crust with NotificationListener

---

## Phase 1: Rename and Restructure

### 1.1 Rename core to device-bridge

```bash
# In mobile/modules/
mv core device-bridge

# Update all imports and references
```

**Files to update:**

- `device-bridge/package.json` - name: `@mentra/device-bridge`
- `device-bridge/android/` - package: `com.mentra.devicebridge`
- `device-bridge/ios/` - module: `MentraDeviceBridge`
- `device-bridge/expo-module.config.json`
- All imports in `mobile/src/` that reference `@mentra/core`

### 1.2 Update Namespaces

**Android:**

```kotlin
// Before: com.mentra.core
// After: com.mentra.devicebridge

package com.mentra.devicebridge

class DeviceBridgeModule : Module() { ... }
class DeviceManager { ... }  // renamed from CoreManager
class DeviceStore { ... }    // renamed from GlassesStore
```

**iOS:**

```swift
// Before: MentraCore module
// After: MentraDeviceBridge module

public class DeviceBridge { ... }
public class DeviceManager { ... }  // renamed from CoreManager
public class DeviceStore { ... }    // renamed from GlassesStore
```

**TypeScript:**

```typescript
// Before
import {CoreModule} from "@mentra/core"

// After
import {DeviceBridge} from "@mentra/device-bridge"
```

---

## Phase 2: Extract MentraOS Code to Crust

### 2.1 Move NotificationListener

**From:** `device-bridge/android/src/main/java/com/mentra/devicebridge/services/NotificationListener.kt`
**To:** `crust/android/src/main/java/com/mentra/crust/services/NotificationListener.kt`

**Also move from Device Bridge's AndroidManifest.xml to Crust's AndroidManifest.xml:**

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

The Device Bridge will expose a generic "send notification to display" API. Crust will handle listening to phone notifications and calling that API.

### 2.2 Move OS-Specific State

Create extension in Crust for MentraOS-specific state:

```kotlin
// crust/android/src/main/java/com/mentra/crust/MentraOSStore.kt
object MentraOSStore {
    // OS-specific settings
    var contextualDashboard: Boolean
    var alwaysOnStatusBar: Boolean
    var offlineMode: Boolean
    var offlineCaptionsRunning: Boolean
    var metricSystem: Boolean
    var powerSavingMode: Boolean
    // Note: auth_email/auth_token STAY in Device Bridge (hardware needs them)
}
```

### 2.3 Update GlassesStore.apply()

Remove MentraOS-specific side effects from Device Bridge. The `apply()` function should only handle hardware-related side effects:

**Keep in Device Bridge:**

```kotlin
"core" to "brightness" -> sgc?.setBrightness(...)
"core" to "auto_brightness" -> sgc?.setBrightness(...)
"core" to "dashboard_height" -> sgc?.setDashboardPosition(...)
"core" to "head_up_angle" -> sgc?.setHeadUpAngle(...)
"core" to "gallery_mode" -> sgc?.sendGalleryMode()
"core" to "button_mode" -> sgc?.sendButtonModeSetting()
"core" to "button_photo_size" -> sgc?.sendButtonPhotoSettings()
"core" to "preferred_mic" -> setMicState(...)
"core" to "default_wearable" -> initSGC(...)
```

**Move to Crust:**

```kotlin
"core" to "offline_mode" -> // OS handles this
"core" to "offline_captions_running" -> // OS handles this
// Note: auth_email/auth_token STAY because hardware needs them
```

---

## Phase 3: Clean Up Bridge.kt

### 3.1 Keep (Hardware Events)

```kotlin
// Raw hardware events - stay in Device Bridge
fun sendHeadUp(isUp: Boolean)
fun sendButtonPressEvent(buttonId: String, pressType: String)
fun sendTouchEvent(deviceModel: String, gestureName: String, timestamp: Long)
fun sendMicData(data: ByteArray)
fun sendLocalTranscription(text: String, isFinal: Boolean, language: String)
fun sendBatteryStatus(level: Int, charging: Boolean) // raw event to JS
fun sendDiscoveredDevice(deviceModel: String, deviceName: String)
fun sendWifiStatusChange(connected: Boolean, ssid: String?, localIp: String?)
fun sendHotspotStatusChange(enabled: Boolean, ssid: String, password: String, gatewayIp: String)
fun sendGalleryStatus(...)
fun sendImuDataEvent(...)
fun sendImuGestureEvent(...)
fun sendOtaUpdateAvailable(...)
fun sendOtaProgress(...)
fun sendRtmpStreamStatus(...)
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
fun sendButtonPress(...)                       // DELETE - sendButtonPressEvent() exists
fun sendPhotoResponse(...)                     // DELETE - format in TS
fun sendHeadPosition(...)                      // DELETE - sendHeadUp() exists
fun sendVideoStreamResponse(...)              // DELETE - format in TS
fun updateAsrConfig(...)                       // DELETE - format in TS
fun sendPhoneNotification(...)                // MOVE to Crust with NotificationListener
fun sendPhoneNotificationDismissed(...)       // MOVE to Crust with NotificationListener
```

**KEEP raw event emitters:**

```kotlin
fun sendButtonPressEvent()  // Raw hardware event to app
fun sendHeadUp()            // Raw hardware event to app
fun sendBatteryStatus()     // Raw hardware event to app (rename from cloud version)
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

The current code is already well-structured for native consumption. Expo dependencies are isolated to:

- `DeviceBridgeModule.kt` (Android entry point)
- `DeviceBridgeModule.swift` (iOS entry point)

All core logic (`DeviceManager`, `DeviceStore`, `Bridge`, SGC implementations) is pure native with no Expo/React Native dependencies.

**Architecture:**

```
com.mentra.devicebridge (Android) / MentraDeviceBridge (iOS)
├── DeviceManager          # Main orchestrator (pure native)
├── DeviceStore            # State management (pure native)
├── Bridge                 # Event emission (pure native)
├── sgcs/                  # Device implementations (pure native)
│   ├── MentraLive
│   ├── MentraNex
│   ├── G1
│   ├── Mach1
│   └── Simulated
└── DeviceBridgeModule     # Expo wrapper (only RN dependency)
```

**For Native Apps:**

- Use the library directly via Maven/CocoaPods
- Initialize `DeviceManager` and set up callbacks
- No React Native required

**For React Native Apps:**

- Use `@mentra/device-bridge` npm package
- Expo module provides JS interface to native library

---

## Phase 4: Publishing Infrastructure

### 4.1 Package Configuration

**device-bridge/package.json:**

```json
{
  "name": "@mentra/device-bridge",
  "version": "1.0.0",
  "description": "SDK for communicating with smart glasses",
  "main": "build/index.js",
  "types": "build/index.d.ts",
  "react-native": "src/index.ts",
  "repository": {
    "type": "git",
    "url": "https://github.com/AugmentOS/AugmentOS.git",
    "directory": "mobile/modules/device-bridge"
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

**device-bridge/android/build.gradle additions:**

```gradle
plugins {
    id 'maven-publish'
    id 'signing'
}

android {
    namespace 'com.mentra.devicebridge'

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
            artifactId = 'device-bridge'
            version = project.version

            afterEvaluate {
                from components.release
            }

            pom {
                name = 'Mentra Device Bridge'
                description = 'SDK for communicating with smart glasses'
                url = 'https://github.com/AugmentOS/AugmentOS'
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

**device-bridge/ios/MentraDeviceBridge.podspec:**

```ruby
Pod::Spec.new do |s|
  s.name             = 'MentraDeviceBridge'
  s.version          = '1.0.0'
  s.summary          = 'SDK for communicating with smart glasses'
  s.homepage         = 'https://github.com/AugmentOS/AugmentOS'
  s.license          = { :type => 'MIT' }
  s.author           = { 'Mentra' => 'dev@mentra.glass' }
  s.source           = { :git => 'https://github.com/AugmentOS/AugmentOS.git', :tag => s.version.to_s }

  s.ios.deployment_target = '13.0'
  s.swift_version = '5.0'
  s.source_files = 'ios/Source/**/*.swift'
  s.frameworks = 'CoreBluetooth', 'AVFoundation'
  s.resource_bundles = {
    'MentraDeviceBridge' => ['ios/Source/PrivacyInfo.xcprivacy']
  }
end
```

### 4.4 iOS Privacy Manifest (Required by Apple)

**device-bridge/ios/Source/PrivacyInfo.xcprivacy:**

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

Device Bridge and Crust versions will be kept in sync for simplicity. When either changes, both get a version bump. This avoids compatibility matrix headaches.

---

## Phase 5: Documentation

### 5.1 README for Device Bridge

```markdown
# Mentra Device Bridge

SDK for communicating with smart glasses.

## Installation

### React Native / Expo

npm install @mentra/device-bridge

### Android (Maven)

implementation 'com.mentra:device-bridge:1.0.0'

### iOS (CocoaPods)

pod 'MentraDeviceBridge'

## Quick Start

import { DeviceBridge } from '@mentra/device-bridge';

// Start scanning for devices
await DeviceBridge.startScanning();

// Connect to a device
await DeviceBridge.connect(deviceId);

// Display text
await DeviceBridge.displayText('Hello World');

// Listen for button presses
DeviceBridge.onButtonPress((event) => {
console.log('Button pressed:', event.buttonId);
});
```

### 5.2 Documentation Site

- Getting Started (Android, iOS, React Native)
- API Reference
- Supported Devices
- Audio Streaming Guide
- Display Control Guide
- Camera Control Guide

---

## Implementation Checklist

### Phase 1: Rename (Week 1)

- [ ] Create branch `feature/device-bridge-rename`
- [ ] Rename `mobile/modules/core` to `mobile/modules/device-bridge`
- [ ] Update package.json name to `@mentra/device-bridge`
- [ ] Update Android package: `com.mentra.core` -> `com.mentra.devicebridge`
- [ ] Update iOS module name
- [ ] Update all imports in `mobile/src/`
- [ ] Update expo-module.config.json
- [ ] Verify build works

### Phase 2: Extract to Crust (Week 2)

- [ ] Move NotificationListener service to Crust
- [ ] Move NotificationListener manifest entry to Crust
- [ ] Move OS-specific state keys to Crust (contextual_dashboard, always_on_status_bar, etc.)
- [ ] Update GlassesStore.apply() to remove OS-specific side effects
- [ ] Create Crust TypeScript interface
- [ ] Wire up Crust to MentraOS app layer
- [ ] Verify MentraOS still works end-to-end

### Phase 3: Clean Up Bridge - Delete Duplicates (Week 2-3)

- [ ] Audit all Bridge functions for duplicates
- [ ] Find call sites of cloud-formatting functions in native code
- [ ] Update call sites to use raw event emitters
- [ ] Move cloud protocol formatting to TypeScript layer
- [ ] Delete duplicate functions from Bridge.kt and Bridge.swift
- [ ] Keep only raw hardware event emitters in Device Bridge
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

### Phase 5: Documentation (Week 4)

- [ ] Write main README
- [ ] Create getting started guides
- [ ] Generate API reference
- [ ] Create example apps
- [ ] Write migration guide for existing users

### Phase 6: MentraOS Migration

When we delete the duplicate cloud-formatting functions from Bridge, the MentraOS TypeScript layer needs to handle that formatting instead.

**Current flow:**

```
Native: button pressed → Bridge.sendButtonPress() formats JSON → emits ws_text event → TS sends to WebSocket
```

**New flow:**

```
Native: button pressed → Bridge.sendButtonPressEvent() emits raw event → TS formats JSON → TS sends to WebSocket
```

**Files to update in MentraOS TypeScript:**

- Find where `ws_text` events are being listened to
- Instead, listen for raw events (`button_press`, `head_up`, `battery_status`, etc.)
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
   - `@mentra/device-bridge` on npm
   - `com.mentra:device-bridge` on Maven Central
   - `MentraDeviceBridge` on CocoaPods

2. **Clean Separation**
   - Device Bridge has no MentraOS-specific code
   - Crust contains all OS-specific native code
   - Enterprise customers can use Device Bridge standalone

3. **Working Examples**
   - Example apps demonstrating standalone usage
   - Documentation for all platforms

4. **MentraOS Compatibility**
   - MentraOS app continues to work
   - Uses Device Bridge + Crust together
   - No regression in functionality
