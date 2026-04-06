# 090 — HLS URL Not Delivered to Mini App When Restreaming

## Spike: Investigation & Findings

**Date:** April 6, 2026
**Author:** Isaiah, with Claude
**Status:** Needs investigation — filed from user bug report
**Reported by:** CTO (zpkns8zrvv@privaterelay.appleid.com) via Mentra Alert Service
**Severity:** 🔴 5/5

---

## Bug Report

> **Summary:** I'm running streamer and I think the hls url didn't get sent to
> the miniapp when doing a stream to twitter
>
> **System:** App 2.9.0 | iOS 26.3.1 | iPhone | Glasses: Connected | Mentra Live
>
> **Incident ID:** b11e9b08...

The user was running the **Livestreamer** app (v2 SDK, published) and started a
managed stream with a Twitter RTMP restream destination. The stream apparently
started (glasses were streaming) but the HLS URL was never received by the mini
app, so the app couldn't show the viewer URL or confirm the stream was live.

---

## Context

### The Livestreamer app

- Published v2 SDK app (`@mentra/sdk` 2.x)
- Uses `startManagedStream()` (v2 API, not the unified `startStream()`)
- Supports restream destinations (YouTube, Twitch, Twitter RTMP URLs)
- When restreaming, the cloud uses **SRT ingest → HLS/DASH playback** (not WebRTC/WHIP)
- The app expects `managed_stream_status` with `hlsUrl` in the response

### The restream code path (different from WebRTC)

When `restreamDestinations` is present in `MANAGED_STREAM_REQUEST`:

1. Cloud creates Cloudflare Live Input with restream outputs configured
2. Cloud tells glasses to stream **SRT** to the Cloudflare ingest URL
3. Cloudflare ingests SRT → creates HLS/DASH segments → fans out to RTMP destinations
4. Cloud should send `managed_stream_status` with `hlsUrl` and `dashUrl` back to app
5. **WebRTC URL is NOT available** in restream mode (WHIP ingest is not used)

This is a separate code path from the WebRTC mode we've been testing in
stream-test. The `ManagedStreamingExtension.startManagedStream()` branches
based on `useWebRTC = !restreamDestinations || restreamDestinations.length === 0`.

---

## Potential Causes

### 1. Issue 087 — Dedup cache blocking status delivery (LIKELY)

The `lastSentStatus` dedup cache on `ManagedStreamingExtension` could be
blocking the `managed_stream_status` for the restream case, just like it
blocked it for the WebRTC case. If the user had a previous stream (even
from a different session), the cache might match and skip delivery.

**Our fix** (clearing cache on reconnect via `clearLastSentStatus()`) is
on the `cloud/issues-048` branch but **NOT YET DEPLOYED to production**.
The Livestreamer app runs against the **production** cloud, not debug.

If this is the cause, deploying the 087 fix to production would resolve it.

### 2. Restream-specific URL timing issue

In restream mode, Cloudflare may take longer to provision HLS/DASH URLs
because it needs to set up the RTMP fan-out outputs first. The cloud polls
Cloudflare for the stream to go live. If the HLS URL isn't ready when the
cloud sends the initial `managed_stream_status`, it might send the message
with `hlsUrl: undefined`.

The cloud has a polling loop (`🔍 Polling for stream details and live status`)
that checks every 2 seconds for up to 30 seconds. If the HLS URL arrives
during polling, it should send an updated `managed_stream_status`. But the
dedup cache might block this update if the initial status (without URL) was
already sent.

### 3. SRT ingest + HLS readiness gap

In WebRTC/WHIP mode, the stream goes live almost instantly (sub-second).
In SRT mode, there's a pipeline: SRT ingest → transcode → HLS segmentation.
This can take 10-30 seconds before the first HLS segment is available. The
`managed_stream_status` might be sent before HLS is ready, and no follow-up
status is sent when HLS becomes available.

### 4. Cloud changes on debug branch affecting production (UNLIKELY)

Our changes to `AppManager.ts` and `ManagedStreamingExtension.ts` are on
`cloud/issues-048` which deploys to **debug**, not production. The
Livestreamer app runs against production. Unless the CTO was testing against
the debug cloud, our changes are not involved.

**Need to confirm:** Which cloud was the Livestreamer app connected to?

### 5. v2 SDK `onManagedStreamStatus` handler mismatch

The v2 SDK listens for `managed_stream_status` via the legacy event system.
If the cloud sends the status in a slightly different format (e.g., different
field names), the v2 handler might not recognize it. This would be a
pre-existing bug, not related to our changes.

---

## Investigation Steps

### Step 1: Determine which cloud was used

Check the incident: was the Livestreamer app connected to production or debug?
If production, our branch changes are not involved.

### Step 2: Check BetterStack logs for the incident

Query the production cloud logs for the user's managed stream request:

```sql
SELECT dt, service, msg
FROM s3Cluster(primary, t373499_mentra_us_central_s3)
WHERE _row_type = 1
  AND dt BETWEEN '2026-04-06 19:00:00' AND '2026-04-06 19:30:00'
  AND JSONExtract(raw, 'message', 'userId', 'Nullable(String)') = '<user_id>'
  AND (
    JSONExtract(raw, 'message', 'service', 'Nullable(String)') LIKE '%Stream%'
    OR JSONExtract(raw, 'message', 'service', 'Nullable(String)') LIKE '%Cloudflare%'
  )
ORDER BY dt ASC
LIMIT 50
```

Look for:
- `📡 Starting managed stream in SRT mode` — confirms restream path
- `Sent managed stream status to app` — was the status sent?
- `Skipping duplicate managed stream status` — dedup cache blocked it?
- `⏱️ Timeout waiting for stream to go live` — HLS not ready?
- Any errors in the Cloudflare API calls

### Step 3: Check if HLS URL was in the status message

If the cloud DID send `managed_stream_status`, check whether `hlsUrl` was
populated or `undefined`/`null`. The restream path constructs URLs differently
from the WebRTC path.

### Step 4: Check Livestreamer app's v2 handler

Review the Livestreamer app's `onManagedStreamStatus` handler to see if it
correctly extracts `hlsUrl` from the status message. The v2 SDK's
`CameraManagedExtension` processes `managed_stream_status` and resolves the
pending promise with the URLs.

### Step 5: Reproduce with stream-test app

Try starting a managed stream with restream destinations from the stream-test
app (v3 SDK) against the debug cloud to see if the same issue occurs:

```typescript
session.camera.startStream({
  destinations: [{ url: "rtmp://twitter-ingest-url/stream-key", name: "Twitter" }],
});
```

If it reproduces, it's a cloud-side issue in the restream path. If it doesn't,
it's specific to v2 SDK or the production cloud.

---

## Relationship to Recent Changes

| Change | Affects this bug? | Why |
|--------|------------------|-----|
| Issue 087 — clearLastSentStatus | **Possibly** — if on prod cloud | Dedup cache could block HLS URL delivery |
| Issue 085 — deliverActiveStreamState | **No** — not deployed to prod | Only on debug branch |
| Issue 089 — APP_STOPPED reconnect | **No** — different issue | About stop lifecycle, not streaming |
| Issue 088 — ASG silent START_STREAM | **No** — ASG client issue | Glasses did start streaming in this case |
| CameraManager unified startStream | **No** — v2 app uses old API | Livestreamer uses v2 `startManagedStream()` |

---

## Key Question

**Was this a pre-existing bug in the restream path, or did something change
recently?**

The CTO's phrasing ("I think the hls url didn't get sent") suggests uncertainty.
The stream may have been working (going to Twitter) but the app just didn't
receive the viewer URL. This could be a long-standing issue in the restream
path that was never noticed because most users watch via the app's WebRTC
player (which doesn't work in restream mode anyway).

---

## Related Issues

| Issue | Relationship |
|-------|-------------|
| **087** — Dedup cache blocks status delivery | Most likely cause if on same cloud |
| **085** — Orphaned stream lifecycle | Same streaming infrastructure |
| **083** — Unified streaming API | Designed the restream `destinations` parameter |
| **088** — ASG client silent START_STREAM | Different failure mode, same pipeline |