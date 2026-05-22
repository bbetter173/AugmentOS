# MicrophoneManager Documentation

## Overview

MicrophoneManager handles all microphone state management for user sessions in MentraOS. It controls when the glasses' microphone is enabled/disabled based on app subscriptions and provides a keep-alive mechanism to ensure the client maintains microphone access.

## Core Responsibilities

1. **State Management**: Tracks microphone enabled/disabled state
2. **Debounced Updates**: Prevents rapid state changes from overwhelming the client
3. **Keep-Alive Messages**: Sends periodic reminders to maintain microphone access
4. **Subscription Coordination**: Responds to app audio subscription changes
5. **WebSocket Communication**: Sends state changes to glasses client

## Key Features

### Debounced State Updates

The manager implements intelligent debouncing to handle rapid state changes:

- **First Update**: Sent immediately
- **Subsequent Updates**: Debounced with configurable delay (default 1000ms)
- **Smart Coalescing**: Multiple rapid changes result in a single final update
- **State Tracking**: Only sends if final state differs from last sent state

### Performance Optimization

To avoid expensive repeated lookups, the manager caches subscription state:

- **Cached State**: Stores `hasPCM`, `hasTranscription`, and `hasMedia` flags
- **Cache Updates**: Only recalculated when:
  - Initial construction
  - Subscription changes occur
  - Glasses connection state changes
  - After unauthorized audio debounce expires (sanity check)
- **High-Frequency Calls**: `onAudioReceived()` uses cached state (called 50+ times/second)
- **Significant Performance Gain**: Reduces subscription service calls from thousands to just a few per session

### Microphone Keep-Alive

**Purpose**: Some glasses clients may release microphone access when the app goes to background (to allow other apps to use the mic). The keep-alive ensures the client maintains microphone access continuously, even while in the background.

**Behavior**:

- Sends `MICROPHONE_STATE_CHANGE` message every 10 seconds
- Only active when:
  - Microphone is enabled
  - WebSocket connection is open
  - Active media/audio subscriptions exist
- Automatically stops when conditions are no longer met
- Keeps the microphone active even when the app is backgrounded

### Unauthorized Audio Detection

**Purpose**: Ensures the glasses client properly disables the microphone when instructed. If audio data continues to arrive after the mic should be off, the system immediately forces a mic off command.

**Behavior**:

- Monitors incoming audio when mic should be disabled
- If unauthorized audio detected:
  - Immediately sends `MICROPHONE_STATE_CHANGE` with enabled=false
  - Logs the incident for debugging
  - Ignores further unauthorized audio for 5 seconds (debounce period)
  - After debounce, refreshes cached subscription state before resuming detection
- Prevents spam by not sending multiple off commands within 5 seconds
- Ensures mic is disabled when no apps have active subscriptions

**Design Rationale**:
The immediate response ensures quick security enforcement, while the debounce period prevents flooding the client with repeated off commands when receiving a stream of unauthorized audio (50+ chunks per second). The cache refresh after debounce handles edge cases where subscriptions might have changed during the 5-second window, ensuring we don't incorrectly flag legitimate audio as unauthorized.

### Subscription-Based Activation

The microphone automatically activates based on app needs:

- **PCM Audio**: Apps needing raw audio data
- **Transcription**: Apps needing speech-to-text
- **PCM or Transcription**: Apps that can work with either

The manager calculates the optimal `requiredData` array based on all active subscriptions.

## Message Protocol

### Outgoing Messages

**MICROPHONE_STATE_CHANGE**

```typescript
{
  type: CloudToGlassesMessageType.MICROPHONE_STATE_CHANGE,
  sessionId: string,
  userSession: {
    sessionId: string,
    userId: string,
    startTime: Date,
    activeAppSessions: string[],
    loadingApps: Set<string>,
    isTranscribing: boolean
  },
  isMicrophoneEnabled: boolean,
  requiredData: Array<'pcm' | 'transcription' | 'pcm_or_transcription'>,
  bypassVad: boolean,  // Bypass Voice Activity Detection for PCM
  timestamp: Date
}
```

## Edge Cases Handled

1. **Rapid Subscription Changes**
   - Debounced to prevent excessive state changes
   - Final state always reflects actual subscription needs

2. **WebSocket Disconnection**
   - Keep-alive pauses when connection is lost
   - Resumes automatically on reconnection

3. **Session Cleanup**
   - All timers properly cleared on disposal
   - Prevents memory leaks

4. **Glasses Connection State**
   - Checks subscriptions when glasses connect
   - Ensures proper initial microphone state

5. **VAD Bypass**
   - Automatically bypasses Voice Activity Detection when apps need PCM data
   - Ensures continuous audio stream for apps that process raw audio

6. **Unauthorized Audio**
   - Detects when audio arrives but mic should be off
   - Immediately sends mic off command
   - Ignores further detections for 5 seconds (debounce)
   - Prevents accidental audio capture and command spam

## Integration Points

1. **UserSession**: Created and owned by each user session
2. **SubscriptionService**: Queries to determine if audio subscriptions exist
3. **WebSocket**: Sends state changes to glasses client
4. **AppManager**: Notified via subscription changes
5. **AudioManager**: Notifies MicrophoneManager when audio is received

## Usage Example

```typescript
// When app subscribes to audio
userSession.microphoneManager.handleSubscriptionChange();

// When glasses connect
userSession.microphoneManager.handleConnectionStateChange("CONNECTED");

// Manual state update
const requiredData = ["pcm", "transcription"];
userSession.microphoneManager.updateState(true, requiredData, 1000);

// Cleanup
userSession.microphoneManager.dispose();
```

## Why This Design?

1. **Centralized Control**: All microphone logic in one place
2. **Reliability**: Keep-alive ensures consistent microphone access
3. **Efficiency**: Debouncing prevents unnecessary messages, caching prevents expensive lookups
4. **Flexibility**: Supports various audio processing needs
5. **Maintainability**: Clear separation of concerns
6. **Performance**: Cached subscription state reduces service calls by 99%+

The keep-alive mechanism specifically addresses real-world issues where glasses clients lose microphone access when backgrounded, ensuring continuous audio capture even while the app remains in the background. The unauthorized audio detection provides an additional safety layer, ensuring the microphone is truly disabled when no apps need audio, even if the client fails to respond to the initial off command.
