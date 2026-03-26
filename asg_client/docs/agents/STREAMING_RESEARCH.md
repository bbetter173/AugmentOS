# Streaming Research: RTMP → SRT Migration & YouTube Latency

## Streaming Pipeline Overview

End-to-end flow for video from glasses to a viewer:

```
Third-party app (SDK)
  → Cloud backend (WebSocket)
    → Mobile app bridge (SocketComms.ts)
      → Native Android module (CoreModule.kt)
        → RtmpStreamingService.java
          → StreamPackLite (CameraRtmpLiveStreamer)
            → RTMP ingest URL
```

### Key Files by Layer

| Layer                       | File                                                                                                     | Role                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Actual RTMP push            | `asg_client/app/src/main/java/com/mentra/asg_client/io/streaming/services/RtmpStreamingService.java:853` | Calls `mStreamer.startStream(mRtmpUrl)`                                             |
| Command handler             | `asg_client/.../service/core/handlers/RtmpCommandHandler.java:68`                                        | Parses `rtmpUrl` from WebSocket JSON, calls `RtmpStreamingService.startStreaming()` |
| Cloud → glasses command     | `cloud/packages/cloud/src/services/session/UnmanagedStreamingExtension.ts:213`                           | Sends `START_RTMP_STREAM` WebSocket message to glasses                              |
| Managed stream + Cloudflare | `cloud/packages/cloud/src/services/streaming/ManagedStreamingExtension.ts:238`                           | Provisions Cloudflare live input, sends ingest URL to glasses                       |
| Cloudflare API              | `cloud/packages/cloud/src/services/streaming/CloudflareStreamService.ts:284`                             | Creates RTMP live input via Cloudflare Stream API                                   |
| Mobile bridge               | `mobile/src/services/SocketComms.ts:532`                                                                 | Receives `START_RTMP_STREAM`, calls `CoreModule.startRtmpStream(msg)`               |
| SDK public API              | `cloud/packages/sdk/src/app/session/modules/camera.ts:295`                                               | `session.camera.startStream({ rtmpUrl })`                                           |

### Two Stream Modes

**Unmanaged** — app provides its own RTMP URL directly (e.g. YouTube ingest URL). Cloud passes it straight to glasses.

**Managed** — cloud provisions a Cloudflare live input, gets the RTMP ingest URL, sends it to glasses. Provides HLS/DASH playback URLs back to the app.

---

## RTMP → SRT Migration

There is already a `// TODO: Use srtUrl instead of rtmpUrl` comment in `mobile/src/services/SocketComms.ts:533`.

`CloudflareStreamService.createLiveInput()` already returns `srtUrl` in `LiveInputResult` but it is hardcoded to `""` — the Cloudflare SRT data is available in the response (`liveInput.srt.url` + `liveInput.srt.streamId`) but not yet wired up.

### Files to Change

**`asg_client` (most work)**

- `settings.gradle` — add `:extension-srt` StreamPackLite module
- `app/build.gradle` — replace `implementation project(':extension-rtmp')` with `':extension-srt'`
- `RtmpStreamingService.java` — replace `CameraRtmpLiveStreamer` with SRT equivalent; update URL validation from `rtmp://`/`rtmps://` to `srt://`; SRT connect may need separate host/port/streamId params parsed from the URL
- `RtmpStreamConfig.java` — optionally add SRT-specific params (latency ms, passphrase)
- `RtmpCommandHandler.java` — parse `srtUrl` instead of `rtmpUrl` from JSON

**Mobile bridge**

- `mobile/src/services/SocketComms.ts:533` — read `msg.srtUrl` instead of `msg.rtmpUrl` (TODO already noted)

**Cloud backend**

- `UnmanagedStreamingExtension.ts:125` — update URL validation to accept `srt://`
- `UnmanagedStreamingExtension.ts` — rename `rtmpUrl` → `srtUrl` throughout
- `ManagedStreamingExtension.ts:238` — send `srtUrl` instead of `rtmpUrl` in `StartRtmpStream` message
- `CloudflareStreamService.ts:396` — populate `srtUrl` from `liveInput.srt.url + liveInput.srt.streamId` (currently hardcoded `""`)

**SDK types**

- `cloud/packages/sdk/src/types/messages/cloud-to-glasses.ts` — add `srtUrl` to `StartRtmpStream` interface
- `cloud/packages/sdk/src/types/messages/app-to-cloud.ts` — add `srtUrl` to `RtmpStreamRequest`
- `cloud/packages/sdk/src/app/session/modules/camera.ts` — add `srtUrl` to `RtmpStreamOptions`, update `startStream()`

### RTMP vs SRT Latency

| Protocol | Ingest latency | Notes                                           |
| -------- | -------------- | ----------------------------------------------- |
| RTMP     | 1–5s           | TCP-based, retransmission overhead              |
| SRT      | 100–500ms      | Configurable buffer via `latency=` param in URL |

**Important:** SRT only improves the ingest leg (glasses → server). If playback delivery is still HLS/DASH, viewer latency stays at 5–30s. To realize end-to-end low latency, the playback side also needs SRT or WebRTC.

---

## Minimizing Latency to YouTube

YouTube only accepts RTMP ingest — SRT migration does not help for YouTube destinations.

### Latency breakdown (glasses → YouTube → viewer)

| Hop                                  | Latency   | Controllable?        |
| ------------------------------------ | --------- | -------------------- |
| Glasses → Cloudflare (RTMP ingest)   | ~1–2s     | Marginally           |
| Cloudflare → YouTube (RTMP restream) | ~1–2s     | No                   |
| YouTube CDN → viewer                 | **5–30s** | **Yes — main lever** |

### Recommendations (highest impact first)

**1. Enable YouTube Ultra Low Latency mode**
In YouTube Studio → stream settings, set latency to "Ultra low latency". Brings viewer latency to ~2–5s. Tradeoff: no DVR/rewind for viewers.

**2. Stream directly to YouTube (skip Cloudflare)**
The managed stream path adds a Cloudflare hop (~1–2s). Use unmanaged streaming to go directly:

```typescript
session.camera.startStream({
  rtmpUrl: "rtmp://a.rtmp.youtube.com/live2/YOUR-STREAM-KEY",
})
```

Downside: no HLS/DASH playback URLs from the managed stream.

**3. Lower keyframe interval**
Reduces encoder buffering by ~0.5–1s:

```typescript
video: { bitrate: 2500000, frameRate: 30 }
// Configure 1–2s keyframe interval on the encoder side
```

### Realistic best case to YouTube

~3–6s end-to-end with direct RTMP + ultra low latency mode. YouTube's ingest pipeline has a hard floor of ~2s regardless of ingest path.

### Sub-2s latency

If sub-2s viewer latency is a hard requirement, YouTube is not the right platform. Options:

- **Cloudflare WebRTC playback** — Cloudflare already provisions a WebRTC URL in the managed stream (`webrtcUrl`)
- **LiveKit** — already integrated in the MentraOS stack for other use cases
