# Updated Feedback on `@mentra/bluetooth-sdk` - Hackathon Follow-Up

Current as of May 19, 2026. This refreshes the older internal hackathon feedback against the current SDK and starter-kit worktrees. It separates issues that are fixed or mostly addressed from items that still need product or engineering follow-up.

## Executive Summary

The SDK is in a much better place than the original feedback implied:

- The React Native starter kit now documents Bun-based setup and the iOS GStreamer requirement.
- The starter kit includes `setup-gstreamer-ios.sh`, and the iOS podspec attempts to install GStreamer automatically when missing from the default path.
- `connectFirst` is no longer the relevant API shape. The SDK now exposes `scan(model, {onResults, timeoutMs})`, and the React layer exposes `useBluetoothScan` / `useMentraBluetooth` for picker-oriented flows.
- `searchResults` now has an explicit stable-order contract in the SDK types.
- The React Native public surface is being moved away from raw native status snapshots toward shaped hook state.

The main remaining problems are less about "does the demo run at all?" and more about API clarity and production readiness:

- The React Native direct receiver still makes GStreamer a default native dependency for the example app, even for developers who only want phone photo upload.
- `setMicState(..., bypassVad=false)` remains the default across React Native, Android, and iOS, but that mode is dangerous for third-party STT because it can emit VAD-gated, discontinuous PCM.
- `MicPcmEvent` and `MicLc3Event` still lack payload metadata.
- Photo request rate limiting / queue overflow still appears silent from the app-facing API.
- iOS background BLE and audio requirements still need first-class docs.

## Open Issues

### 1. Direct Receiver GStreamer Is Documented Now, But Still Too Heavy As A Default

Status: partially addressed.

The original "fresh clone cannot build iOS because GStreamer is missing" report is no longer accurate in its strict form. The React Native README now tells developers to run `bun run ios:setup`, explains that the companion direct receiver needs the GStreamer iOS SDK, and documents `GSTREAMER_ROOT_IOS`. The starter kit also has `modules/mentra-direct-receiver/scripts/setup-gstreamer-ios.sh`, and the iOS podspec attempts to run it during pod install when GStreamer is absent from the default location.

What remains open:

- `MentraDirectReceiver.podspec` still links `GStreamer.framework` and includes all Objective-C/Swift sources by default.
- A developer who only wants direct phone photo upload still pays the GStreamer install/build cost because the photo receiver and WebRTC receiver live in the same native module/podspec.
- GStreamer-iOS is still a large, unusual dependency for a starter app. It may be fine as an advanced demo, but it should not be unavoidable for the common photo-only path.

Recommended follow-up:

- Split the direct receiver into photo-only and WebRTC-capable variants, or add a build flag that excludes `GStreamerWhipReceiver.*`, `gst_ios_init.*`, and `WhipHeaderProxy.swift`.
- Make the default React Native starter path photo-only unless the developer opts into direct WebRTC preview.
- Keep GStreamer docs, but frame it as optional advanced setup rather than baseline starter-kit setup.

### 2. `bypassVad=false` Is Still The Wrong Default For External STT PCM

Status: still open.

The public APIs still default `bypassVad` to `false`:

- React Native wrapper: `setMicState(enabled, useGlassesMic = true, bypassVad = false, ...)`
- Android native SDK: `setMicState(enabled = true, useGlassesMic = true, bypassVad = false, ...)`
- iOS native SDK: `setMicState(enabled: true, useGlassesMic: true, bypassVad: false, ...)`

That default is good only if the consumer expects SDK-owned VAD behavior. It is a bad default for third-party STT pipelines that expect continuous PCM, because VAD-gated PCM can drop leading/trailing frames and arrive in irregular bursts. The previous Roastbook symptom, repeated hallucinated tokens from downstream STT, is exactly the kind of failure this produces.

Recommended follow-up:

- Prefer changing the default to `bypassVad=true` for app-facing PCM.
- If changing the default is too risky, document this prominently in `audio.mdx`, README, and API reference:
  - Use `bypassVad=true` when sending PCM to external STT.
  - Use `bypassVad=false` only when intentionally accepting SDK VAD-gated audio.
- Consider a clearer API name or helper, such as `startPcmMic({continuous: true})`, so developers do not need to understand VAD internals on day one.

### 3. `MicPcmEvent` And `MicLc3Event` Still Need Metadata

Status: still open.

React Native still exposes:

```ts
export type MicPcmEvent = {
  type: "mic_pcm"
  pcm: ArrayBuffer
}

export type MicLc3Event = {
  type: "mic_lc3"
  lc3: ArrayBuffer
}
```

The event payload does not say whether PCM is 16 kHz, 16-bit, mono, signed little-endian, or VAD-gated. Native code and docs imply the PCM path is 16 kHz PCM, but consumers should not need to read Kotlin/Swift to know how to feed the stream into STT, WAV writing, or playback.

Recommended follow-up:

```ts
export type MicPcmEvent = {
  type: "mic_pcm"
  pcm: ArrayBuffer
  sampleRate: 16000
  bitsPerSample: 16
  channels: 1
  encoding: "pcm_s16le"
  vadGated: boolean
}
```

For LC3, document or emit:

- frame duration
- sample rate
- channel count
- expected frame size or size range
- bitrate if fixed
- whether frames are packetized exactly as received from glasses

### 4. Scan Progress Is Much Better; Keep `connectFirst` Out Of The Happy Path

Status: mostly addressed.

The old feedback criticized `connectFirst(DeviceModels.MentraLive)` because it hid scan progress and could connect to the wrong glasses in a room full of devices. That API is not present in the current React Native SDK surface.

Current good state:

- `BluetoothSdk.scan(DeviceModels.MentraLive, {onResults, timeoutMs})` supports progressive picker updates.
- Native Android and iOS scan APIs also expose progressive results callbacks.
- `useBluetoothScan` and `useMentraBluetooth` give React apps a higher-level path without manually wiring status listeners.
- Docs now explicitly say `onResults` is for live UI updates and the returned list is the final scan result.

Recommended follow-up:

- Keep docs steering app developers toward explicit device pickers in multi-device environments.
- Avoid presenting any future "connect to first nearby glasses" helper as the primary getting-started path.
- Consider adding a starter-kit picker that sorts by RSSI only when RSSI is available, while keeping the SDK-provided stable order as the default display order.

### 5. RSSI Is Optional And Should Be Documented That Way

Status: partially addressed.

The SDK type correctly has `Device.rssi?: number`, and `searchResults` now documents stable discovery order. The old report that an item can appear first with `rssi=?` and update later is still plausible because scan results may be discovered before RSSI is available or before platform-specific scan metadata has settled.

Recommended follow-up:

- Document that `rssi` may be undefined at first discovery.
- In example pickers, do not sort undefined RSSI entries below everything if that causes visible jumping or broken-looking lists.
- If native scan callbacks can populate RSSI earlier for Mentra Live, do that, but the public contract should still allow `undefined`.

### 6. Photo Request Queue / Rate Limit Failures Still Need App-Facing Feedback

Status: still open.

The previous feedback described rapid `requestPhoto` calls eventually producing no shutter, no `photo_response`, and no app-facing error. The current SDK does not appear to expose an explicit queue-depth or rate-limit error for this path.

Recommended follow-up:

- Add an SDK-side in-flight guard or documented minimum interval for Mentra Live photo requests.
- Emit `photo_response` with an error code such as `rate_limited`, `queue_full`, `busy`, or `timeout` when the request cannot be accepted or does not complete in time.
- Document the recommended app behavior: one photo request at a time, user-visible busy state, and retry/backoff on rate-limit or timeout.

### 7. iOS Background BLE And Mic Requirements Need Dedicated Docs

Status: still open.

The iOS docs currently cover deployment target, CocoaPods, and permission strings, but they do not explain what developers must configure for BLE and microphone behavior while the phone is locked or the app backgrounds.

Recommended follow-up:

- Add a "Background Operation" section to the iOS and React Native docs.
- Document required `UIBackgroundModes`, at minimum:
  - `bluetooth-central` for BLE central behavior.
  - `audio` for microphone/audio session behavior when using continuous mic capture.
- For Expo / React Native, document the relevant `app.json` config and audio-session call, for example using `expo-audio` with background recording/playback enabled.
- Explicitly state whether the SDK uses `CBCentralManagerOptionRestoreIdentifierKey` for state restoration. If it does not, document that terminated-app BLE restoration is not supported yet.

### 8. `Device.id` Semantics Should Be Documented

Status: partially addressed in code, not clearly documented.

The native SDKs now consistently derive `Device.id` from the platform address/identifier when available, otherwise from `model:name`.

Recommended follow-up:

- Document that `id` is the stable app-facing key for a scan result within the limits of the platform data available.
- Document that Android commonly uses a Bluetooth address when available, while iOS commonly uses a CoreBluetooth identifier when available.
- Tell apps not to parse `id` for model/name/address; use the typed fields.

### 9. React Native Status Shape Is Improving; Native Status Is Still Broad

Status: partially addressed.

The current React Native direction is good: public docs are moving developers toward `useMentraBluetooth()` with shaped state:

- `mentra.glasses`
- `mentra.sdk`
- `mentra.scan`

This is better than asking apps to merge raw `glasses_status` and `bluetooth_status` snapshots. It also keeps snake_case native store details out of normal React app code.

Recommended follow-up:

- Finish the public/private boundary so raw native status events and getters are not part of the supported React Native root export.
- Keep raw native store keys private to `_private` / internal hooks.
- For native Android/iOS, consider grouped status docs even if the SDK structs remain broad for backward compatibility.

### 10. iOS SDK Source Organization Is Still Hard To Read

Status: still open, low priority.

`MentraBluetoothSDK.swift` is still very large. This does not block usage, but it makes source-level debugging harder for SDK consumers and Mentra engineers.

Recommended follow-up:

- Split the iOS SDK source into focused files over time:
  - public types
  - scan/default-device connection logic
  - mic/audio
  - camera/gallery
  - streaming
  - event dispatch

## Items That Are Now Outdated

These should not be repeated as current blockers:

- "React Native iOS example has no GStreamer setup script." It now has one.
- "README does not mention GStreamer." It now does.
- "`connectFirst` blocks the UI without scan progress." The current API direction is `scan(..., {onResults})` plus React hooks.
- "Search result list can reorder on every update." The SDK type now explicitly requires stable order for `searchResults`.
- "Camera flash/light can be disabled." The public React Native photo API no longer exposes a flash toggle, and docs say the camera light is always enabled for photo capture and streaming.

## What Is Working Well

- The starter-kit direct photo receiver has the right ergonomics: start a phone-local receiver, pass the upload URL to `requestPhoto`, and receive an on-disk JPEG URI.
- `scan(..., {onResults})` is the right primitive for user-facing pickers.
- `useMentraBluetooth()` is a strong React Native direction because it gives app developers shaped state instead of native-store snapshots.
- Stable scan-result ordering avoids UI churn when devices refresh.
- The Expo plugin continues to hide most Android/iOS permission plumbing from React Native apps.
- Continuous PCM with `bypassVad=true` is a good signal source once developers know to use it for external STT.

## Suggested Next Priority Order

1. Document and/or change the `bypassVad` default for external STT.
2. Add PCM/LC3 metadata to mic events.
3. Add iOS background operation docs.
4. Split or gate GStreamer in the React Native direct receiver.
5. Add photo request timeout/rate-limit errors.
6. Document `Device.id` and optional `rssi` semantics.
7. Continue polishing the React Native public/private status boundary.
