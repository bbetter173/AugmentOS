# Spike: Captions 30-Second Latency — March 23–24, 2026

## Overview

**What this doc covers:** Investigation of a pattern of captions latency complaints and complete dropouts across multiple G1 users on March 23–24, 2026, including what the logs actually show vs what is still unknown.
**Why this doc exists:** At least three users reported the same symptom in the same 24-hour window. A team member responded in Discord saying "we had some issues last 24 hours, we're fixing" — but that's an unverified claim, not a confirmed incident. This spike is the investigation of whether there actually was a cloud-side issue, what the evidence shows, and what the root cause might be.
**Who should read this:** Cloud engineers (transcription pipeline), anyone triaging future captions latency regressions.

---

## Background

The captions transcription pipeline for a connected G1 session:

```
Phone mic → LC3 encode → UDP → Cloud AudioManager
                                     ↓
                              TranscriptionManager
                                     ↓ (Soniox SDK stream)
                              Soniox ASR
                                     ↓ transcript tokens
                              com.mentra.captions (cloud app)
                                     ↓ display request
                              Glasses display
```

Normal end-to-end latency is ~1 second. The `UDP audio stats in AudioManager` log fires every 10 seconds and is independent of transcription — it tracks packet counts, not transcript output. Display updates from `com.mentra.captions` are the observable proxy for "transcription is working."

There is also a separate path: if the phone has `enforce_local_transcription: true`, the phone runs Sherpa ONNX locally and sends transcript tokens to the cloud. Whether the captions app subscribes to that local stream or still goes through the cloud Soniox stream regardless is not confirmed — see Finding 5.

---

## User Reports

Three independent reports in the same 24-hour window:

**User 1 (Discord):** Complete stop of both transcription and MentraOS 20 minutes into use of G1. Restarted 4 times with no recovery. Disconnected and used Even Realities native transcription — worked fine for 40 minutes. Filed bug report in-app. _(See also: issue 051 — BLE reconnect failure cascade compounded this experience specifically.)_

**User 2 (Discord, "Connolly"):** 15–20 minute window of ~30-second latency under stable network conditions. Self-resolved after ~20 minutes. Latency returned to 5–6 seconds.

**User 3 (in-app bug report, incident `310702d2`):** Sudden jump to ~30-second latency after captions were functioning normally. Restarting the app and the captions mini-app did not help. G1, phone internal mic, cellular, Stockholm timezone.

**Team acknowledgment (Discord):** A team member replied at 10:15 PM on March 23: _"Sorry, we had some issues last 24 hours, we're fixing."_ This is Discord chat, not a confirmed incident report. It's context, not evidence.

The timing correlation across all three reports is real. Whether the cause was a single cloud-side event or multiple independent failures that happened to coincide is still open.

---

## BetterStack Analysis (User 3)

Queried per-minute display update counts and UDP audio stats for User 3's session on 2026-03-24 07:00–07:40 UTC.

### Display updates per minute (proxy for transcription throughput)

| UTC minute  | Display updates | UDP stats | Actual captions | State                               |
| ----------- | --------------- | --------- | --------------- | ----------------------------------- |
| 07:00       | 66              | 6         | ~60             | ✅ Normal                           |
| 07:01       | 73              | 6         | ~67             | ✅ Normal                           |
| 07:02       | 59              | 6         | ~53             | ✅ Normal                           |
| 07:03       | 54              | 6         | ~48             | ✅ Normal                           |
| 07:04       | 79              | 6         | ~73             | ✅ Normal                           |
| 07:05       | 15              | 6         | ~9              | ⚠️ Degrading                        |
| 07:06       | 6               | 6         | ~0              | ❌ Zero output                      |
| 07:07       | 6               | 6         | ~0              | ❌ Zero output                      |
| 07:08       | 6               | 6         | ~0              | ❌ Zero output                      |
| 07:09–07:27 | ~12–17          | ~10–13    | minimal         | ❌ Severely degraded                |
| 07:28–07:29 | 2–5             | 2–5       | ~0              | ❌ Near silence                     |
| 07:30–07:37 | 6–16            | 5–6       | occasional      | ⚠️ Partial recovery + burst pattern |

UDP stats = 6 per minute throughout = audio flowing every 10 seconds, uninterrupted. The audio transport path never broke. Only transcription output stopped.

### The burst pattern (07:30–07:37)

This is the window visible in the incident-provided cloud logs. Display updates arrive in tight clusters separated by ~30-second silence:

```
07:36:07  ✅ Display sent (captions)
[~13 second gap]
07:36:20  ✅ Display sent
07:36:21  ✅ Display sent  ←─┐
07:36:21  ✅ Display sent    │ burst: 10 updates in ~1 second
07:36:21  ✅ Display sent    │
...                        ←─┘
[~30 second gap]
07:36:52  ✅ Display sent
07:36:52  ✅ Display sent  ← another burst
```

This is not latency in the normal sense. The pipeline is buffering ~30 seconds of transcript tokens and flushing them at once. From the user's perspective: silence for 30 seconds, rapid catch-up, silence again. Impossible to follow in real-time.

### Degradation onset

The drop from 79 display updates/minute (07:04) to 0 (07:06) happened over approximately 90 seconds, starting at roughly **07:04:30–07:05:00 UTC** (08:04–08:05 AM Stockholm local time).

The user filed the report at 12:37 AM local (07:37 UTC) — approximately 32 minutes after degradation began.

---

## Findings

### 1. The audio transport path was healthy throughout

UDP audio stats every 10 seconds without interruption from 07:00 to 07:39. The phone was encoding and sending audio. The cloud was receiving it. Whatever broke was downstream of audio ingestion.

### 2. Transcription output flatlined abruptly at ~07:05 UTC

The drop was not gradual — it went from 79 display updates/minute to zero within two minutes. No client-side state change is visible in the cloud logs at this time (no WebSocket disconnect, no BLE event). The failure is somewhere between audio arriving at the cloud and transcripts being dispatched to the captions app.

### 3. The stream stayed "open" — no error was logged

The cloud logs (89 total) contain no `Soniox stream error`, `STREAM CLOSED`, `Disposing Soniox provider`, or any transcription-related error in the 07:04–07:08 window. Unlike issue 051, where `Soniox translation provider disposed` is clearly visible, this session shows nothing. From the cloud's perspective, everything appeared healthy while producing no output.

This is either:

- A silent failure at the Soniox SDK level (stream object alive, upstream stopped returning tokens)
- A stall in the routing layer between transcript tokens and the captions app subscription
- Something else in the pipeline we haven't identified yet

We did not find any public Soniox status page or incident report for this date to confirm or rule out an upstream issue on their side.

### 4. The burst flush pattern rules out a network gap

If the 30-second silence were a network issue (phone → cloud), UDP audio would also drop. It didn't. If it were a display delivery failure (cloud → glasses), display sends would fail. They don't — every `Display sent successfully` completes cleanly once a transcript arrives. The burst pattern points to transcripts backing up somewhere in the pipeline and being flushed when the blockage clears.

### 5. `enforce_local_transcription: true` adds uncertainty

User 3 has `enforce_local_transcription: true`. If this setting actually routes the captions app through the local Sherpa ONNX path rather than the cloud Soniox stream, then a Soniox issue would have no effect on this user — yet their captions still stopped. This either means:

- The captions app subscribes to Soniox regardless of the phone-side setting
- Local transcription results are routed through the same pipeline segment that stalled
- The `enforce_local_transcription` setting doesn't work the way it's documented

This needs to be traced in the code before drawing conclusions.

### 6. Self-resolving behavior is consistent with a temporary upstream issue

User 2's latency resolved on its own after ~20 minutes without any app restart or intervention. This pattern fits a transient upstream degradation (Soniox, an internal queue, or something else) that recovered, not a permanent misconfiguration or client bug. But it's consistent with — not proof of — an upstream issue.

---

## Conclusions

What we know for certain:

- Transcription output stopped while audio kept flowing, for at least one user, starting around 07:05 UTC on March 24
- Multiple users reported the same symptom in the same 24-hour window
- No errors were logged in the cloud when transcription stopped — it failed silently
- The burst pattern means transcripts were buffering somewhere, not disappearing entirely

What we do not know:

- The root cause — Soniox upstream degradation, internal cloud pipeline stall, and captions app connection issues are all plausible hypotheses
- Whether the three user reports share the same root cause or are independent failures that coincided
- How many other sessions were affected (no aggregate query run yet)
- What `enforce_local_transcription: true` actually controls for the captions app end-to-end
- What the team member was "fixing" when they posted in Discord

| Finding                                             | Confidence                 |
| --------------------------------------------------- | -------------------------- |
| Audio path healthy throughout                       | High                       |
| Transcription output stopped abruptly at ~07:05 UTC | High                       |
| Silent failure — no error logged                    | High                       |
| Burst pattern = buffered backlog, not network drop  | High                       |
| Root cause is upstream Soniox degradation           | Unknown — hypothesis only  |
| Root cause is internal cloud pipeline stall         | Unknown — hypothesis only  |
| `enforce_local_transcription` bypasses Soniox       | Unknown — needs code trace |

---

## Next Steps

1. **Add silent stream detection**: If a stream has been open >60s with 0 tokens returned while audio is actively flowing, log a warning. Right now this failure mode is completely invisible. This applies regardless of what the root cause turns out to be.
2. **Trace `enforce_local_transcription` end-to-end**: Does it affect what the captions app subscribes to? If not, the setting is misleading users.
3. **Aggregate BetterStack query**: How many sessions had zero display updates + active UDP audio in the 07:00–07:30 UTC window on March 24? If it was widespread, it points more strongly to a shared upstream cause.
4. **Reach out to Soniox**: Ask if they had any degradation or incidents on their end around March 23–24. Their SDK doesn't surface errors unless the stream closes — a slowdown or internal queue backup on their side would look exactly like what we observed.
5. **Add error logging to token dispatch path**: If transcripts stop flowing through any part of the pipeline, it should produce a log entry, not silence.
