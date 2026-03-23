# Private Runtime Architecture: SDK v3

**Issue:** 048  
**Status:** Working spec  
**Scope:** Hidden/internal SDK runtime design for `MiniAppServer`, `MentraSession`, transport, routing, subscriptions, lifecycle, and compatibility  
**Date:** 2025-02-14

---

## Purpose

This doc freezes the internal architecture for SDK v3 before more implementation lands.

It complements:

- [`spike.md`](./spike.md) for overall implementation direction
- [`reconnection-architecture-spike.md`](./reconnection-architecture-spike.md) for reconnect philosophy and cloud interaction
- [`cloud-websocket-bootstrap-spike.md`](./cloud-websocket-bootstrap-spike.md) for current cloud-side bootstrap and `UserSession` ownership
- [`../039-sdk-v3-api-surface/v2-v3-api-map.md`](../039-sdk-v3-api-surface/v2-v3-api-map.md) for the public API

This doc is about the parts developers do **not** directly code against:

- server/session orchestration
- transport abstraction
- message routing
- subscription bookkeeping
- hidden manager dependencies
- compatibility layer boundaries

---

## Goals

The internal runtime must:

1. Keep the current cloud wire protocol working.
2. Preserve backward compatibility for legacy SDK apps during the transition.
3. Make `MentraSession` transport-agnostic so the same session API can later run outside Node.
4. Make subscriptions derived from handler registrations, not manually maintained state.
5. Keep subsystem logic inside managers instead of one giant session class.
6. Support reconnection without treating every transport loss as session death.
7. Support a parked/reattach state where the cloud can temporarily defer reconnect acceptance during cloud restart/bootstrap without forcing the SDK to destroy `MentraSession` state.

---

## Non-Goals For This Pass

This refactor does **not** need to solve all future runtime concerns now.

Deferred:

- local runtime implementation
- mobile or ASG client changes
- full cloud-side `UserSession` identity redesign
- new wire protocol
- identity redesign beyond what is required for compatibility

---

## Top-Level Model

The internal runtime has three layers:

1. `MiniAppServer`
   - cloud/server host
   - owns HTTP endpoints, webhook ingress, and session creation

2. `MentraSession`
   - per-user runtime orchestrator
   - owns transport lifecycle, routing, subscriptions, and manager instances

3. Managers
   - subsystem implementations such as transcription, mic, speaker, device, phone, camera, storage

The compatibility layer sits beside this, not inside it:

4. `AppServer` / legacy session shims
   - old surface preserved temporarily
   - delegates into the new runtime or a compat adapter

There is also an explicit distinction between:

- public runtime classes
  - `MiniAppServer`
  - `MentraSession`
  - public subsystem managers such as `TranscriptionManager`, `MicManager`, `SpeakerManager`
- private implementation managers
  - underscore-prefixed internal classes such as `_SessionLifecycleManager` or `_SubscriptionManager`

The purpose of the underscore-prefixed layer is to keep the public top-level classes lean and readable while still giving the runtime clear internal responsibility boundaries.

---

## Class Responsibilities

### `MiniAppServer`

`MiniAppServer` is the cloud-only host wrapper.

It owns:

- Hono app construction
- Mentra webhook/tool/settings/health/photo-upload routes
- route aliasing for current cloud compatibility
- session registry keyed by SDK/cloud session identity
- creation and disposal of session runtime instances
- bridging incoming cloud webhook events into per-user session startup and shutdown

It does **not** own:

- stream-level event logic
- transport message parsing
- subscription derivation
- subsystem behavior like transcription, audio, notifications, location
- detailed internal workflow logic when that logic can live in a private underscore-prefixed runtime manager

### `MentraSession`

`MentraSession` is the real per-user runtime object.

It owns:

- injected `Transport`
- connection init
- connection ack handling
- reconnect attempt policy
- ping keepalive
- raw incoming message parsing
- top-level message dispatch
- `DataStream` dispatch
- subscription set bookkeeping
- manager construction and teardown
- session-scoped settings/capabilities/runtime state

It should remain relatively thin. Its job is orchestration, not feature logic.

It should also remain readable. If the class starts accumulating substantial hidden workflow logic, that logic should move into private underscore-prefixed runtime managers rather than turning `MentraSession` into a large god object.

It must also be able to preserve session-scoped in-memory state through three distinct cases:

- normal transport reconnect
- cloud-driven resurrection
- cloud restart / boot-time reattach deferral (`booting` / parked state)

Default runtime decisions:

- parked timeout defaults to 30 seconds
- deferred/booting app sockets stay open as unattached control channels rather than being immediately closed
- successful reconnect or reattach should emit a public `session.onReconnected()` signal
- cloud-side deferred app sockets should live outside `UserSession`; `UserSession` remains owned by the glasses/mobile connection

### Managers

Managers own subsystem behavior and public subsystem APIs.

Examples:

- `TranscriptionManager`
- `TranslationManager`
- `DisplayManager`
- `SpeakerManager`
- `MicManager`
- `DeviceManager`
- `PhoneManager`
- `PermissionsManager`
- `CameraManager`
- `LedManager`
- `LocationManager`
- `StorageManager`
- `DashboardManager`
- `TimeUtils`

Managers should:

- register their own router/message handlers
- request subscriptions through session-provided callbacks
- avoid direct WebSocket usage
- avoid global mutable state

Managers should not:

- own session reconnect policy
- parse raw transport frames directly unless explicitly given those frames by the session

### Private underscore-prefixed managers

These are internal implementation objects, not public SDK surface.

Examples of the kind of responsibilities that belong here:

- `_SessionLifecycleManager`
- `_SubscriptionManager`
- `_MessageRouter`
- `_ReconnectManager`
- `_SessionRegistry`
- `_WebhookRouteManager`
- `_CompatSessionAdapter`
- cloud-side `_DeferredAppConnectionRegistry`

These names are illustrative, not mandatory, but the pattern is intentional:

- underscore prefix means internal/private runtime implementation
- these classes may change freely without implying public API support
- they exist to keep `MiniAppServer` and `MentraSession` lean

Rule of thumb:

- public developer-facing subsystem concepts stay in normal manager classes
- hidden orchestration/business logic moves into underscore-prefixed private managers

This is preferred over allowing the top-level public runtime classes to accumulate large amounts of hidden control flow.

---

## Transport Boundary

`MentraSession` must depend on `Transport`, not directly on `ws`.

Current transport contracts:

- [`cloud/packages/sdk/src/transport/Transport.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/sdk/src/transport/Transport.ts)
- [`cloud/packages/sdk/src/transport/WebSocketTransport.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/sdk/src/transport/WebSocketTransport.ts)

Required transport responsibilities:

- send JSON text
- send binary data
- emit incoming text
- emit incoming binary
- emit close
- emit error
- expose ready state

The session layer must be able to run unchanged with:

- `WebSocketTransport` in cloud/server mode
- some future native bridge transport in local mode

That is the primary internal portability boundary.

## Cloud Recovery Boundary

The cloud runtime should preserve a hard boundary between:

- user presence on this cloud
- mini app transport presence on this cloud

That means:

- `UserSession` is still created by the glasses/mobile connection
- a reconnecting v3 mini app does not create a full speculative `UserSession`
- cloud boot/recovery should use a deferred unattached app-socket registry outside `UserSession`

This is the cloud-side equivalent of the SDK parked-session model:

- app transport may be connected
- logical attach may still be deferred
- the cloud remains authoritative about when the app is actually allowed to attach

---

## Routing Architecture

The routing model is two-stage.

### Stage 1: top-level message routing

`MessageHandlerRegistry` dispatches by `message.type`.

Examples:

- `tpa_connection_ack`
- `settings_update`
- `device_state_update`
- `capabilities_update`
- `data_stream`
- `photo_response`

### Stage 2: `data_stream` routing

`DataStreamRouter` dispatches by `streamType`.

Examples:

- `transcription:en`
- `translation:auto-es`
- `button_press`
- `touch_event:double_tap`
- `phone_notification`

This means:

- `MentraSession` owns the registries
- `MentraSession` bridges `data_stream` top-level messages into the stream router
- managers register only for the message or stream keys they care about

This replaces the legacy giant `handleMessage()` model.

The routing implementation itself may live inside private underscore-prefixed runtime helpers as long as the architectural boundary remains the same.

---

## Subscription Model

This is the most important hidden invariant.

### Source of truth

The SDK runtime must treat active handler registrations as the source of truth for subscriptions.

That means:

- if the app registers a handler requiring a stream, the SDK must subscribe
- if the app removes the last handler for that stream, the SDK must unsubscribe
- the session should not maintain an independent hand-edited subscription model that can drift

### Session responsibility

`MentraSession` owns the actual wire-visible subscription set and the `SUBSCRIPTION_UPDATE` send.

Managers do not send subscription update messages directly. They call:

- `addSubscription(stream)`
- `removeSubscription(stream)`

### Manager responsibility

Managers own their own ref-counting or registration bookkeeping so they only ask the session to add/remove subscriptions at the correct edges.

Examples:

- first `onChunk()` subscriber adds `audio_chunk`
- last one removes `audio_chunk`
- multiple transcription handlers for the same language should still collapse to one active wire subscription

### Cloud compatibility rule

For this pass, `SUBSCRIPTION_UPDATE` message shape must remain compatible with the current cloud.

The bookkeeping behind this may be implemented in a private `_SubscriptionManager` rather than directly inside `MentraSession`, and that is the preferred direction if session code starts becoming noisy.

---

## Private Session State

The runtime should consider these internal state groups canonical.

### Identity

- `packageName`
- `sessionId`
- `userId` if known
- server/base URL if needed for REST-backed managers

### Connection

- `transport`
- connected/disconnected flag
- explicit disconnect flag
- reconnect attempt counter
- reconnect timer
- ping interval

### Routing

- `MessageHandlerRegistry`
- `DataStreamRouter`
- manager cleanup callbacks

### Cloud-provided session state

- app settings
- MentraOS settings
- capabilities
- app config

### Runtime bookkeeping

- subscription set
- lifecycle event emitter

These should remain private to the session runtime, not exposed as public mutable fields.

They also do not all need to live directly on `MentraSession` if a private internal manager is the cleaner owner.

---

## Lifecycle Model

The expected lifecycle is:

1. `MiniAppServer` creates a `MentraSession`
2. transport connects
3. session sends `CONNECTION_INIT`
4. cloud returns `CONNECTION_ACK`
5. session applies:
   - settings
   - MentraOS settings
   - capabilities
6. session starts ping keepalive
7. session sends current `SUBSCRIPTION_UPDATE`
8. managers continue handling data and commands

On transport close:

- if explicit shutdown: clean teardown
- if unexpected: reconnect policy may run

On teardown:

- stop timers
- stop ping
- destroy managers
- clear router/registry state
- close transport

The lifecycle flow may be coordinated by a private `_SessionLifecycleManager` if that produces a cleaner implementation.

---

## Reconnection Model

For the current implementation pass:

- `MentraSession` owns reconnect attempt policy.
- reconnect is transport/session level, not manager level.
- manager subscriptions/config should be re-applied from current runtime state after reconnect.

Required principle:

- reconnect should preserve the session runtime instance whenever possible
- losing the transport should not automatically imply losing manager state or developer-installed handlers

The more ambitious cloud-side resurrection redesign remains governed by [`reconnection-architecture-spike.md`](./reconnection-architecture-spike.md) and may require additive cloud work later.

---

## Manager Dependency Contract

All managers should receive structural dependencies from the session rather than concrete session implementation references wherever practical.

Expected dependency shape includes some subset of:

- `router`
- `messageHandlers`
- `addSubscription`
- `removeSubscription`
- `sendMessage`
- `sendBinary`
- `logger`
- `getPackageName`
- `getSessionId`
- `getServerUrl`
- `permissions`

This is intentional:

- keeps managers testable
- reduces coupling
- allows the runtime to evolve without rewriting every manager

The same principle applies to private underscore-prefixed managers: they should also prefer narrow structural dependencies over hard coupling to giant top-level classes.

---

## Compatibility Boundary

This must stay explicit.

### New runtime

The target runtime is:

- `MiniAppServer`
- real `MentraSession`
- manager-based subsystem APIs

### Legacy compatibility

The compatibility surface is:

- `AppServer`
- legacy-style session aliases/shims where needed

The compatibility layer should be implemented as an adapter over the new runtime, not as the permanent core runtime.

That means the intended final direction is:

- old public names forward to new internals
- not the other way around

### Temporary current state

Right now the repo is still transitional:

- real `MentraSession` exists
- `MiniAppServer` still rides on legacy `AppServer`/`AppSession`

This is temporary and should be treated as a migration stage, not the target architecture.

---

## Risk Areas Explicitly Called Out

These internals are not equally stable yet.

### Lower-risk areas

- transport abstraction
- message routing pattern
- subscription ownership model
- manager-based split
- lean public classes with private implementation managers
- ping/reconnect ownership living in the session

### Higher-risk areas

- camera, because current cloud path still depends on `/photo-upload` behavior
- storage, because it depends on existing HTTP endpoints and auth assumptions
- permissions, because current cloud payloads are not yet ideal for the cleaner model
- exact `MiniAppServer` cutover strategy from legacy `AppServer`
- exact compat implementation for legacy `session.events`, `session.layouts`, `session.audio`, and similar aliases

---

## What Is Frozen By This Doc

The following should be considered decided unless we find a concrete incompatibility:

1. `MiniAppServer` is the cloud host abstraction.
2. `MentraSession` is the real per-user runtime abstraction.
3. `MentraSession` depends on `Transport`, not `ws`.
4. message routing is registry-based, not giant conditional-chain based.
5. subscriptions are derived from handler registrations.
6. managers are the primary private subsystem boundary.
7. `MiniAppServer` and `MentraSession` should stay lean, with heavier hidden orchestration moved into underscore-prefixed private managers where appropriate.
8. the compat layer is temporary and should wrap the new runtime.

---

## What Is Still Intentionally Open

These details are still allowed to evolve during implementation:

1. whether `MiniAppServer` swaps directly to `MentraSession` or via a compat adapter first
2. exact shape of legacy session shim properties and deprecation helpers
3. whether some managers are gated or partially deferred in the first runtime cutover
4. what minimal additive cloud changes are required for the new runtime to behave safely

---

## Missing Context Check

At this point, the major missing internal-spec gap should be closed.

We now have:

- public API spec
- runtime naming decision
- reconnect philosophy
- implementation progress log
- private runtime architecture

The main remaining unknowns are no longer architectural blind spots. They are implementation and compatibility decisions discovered while wiring the runtime into the active cloud path.
