# Issue 107 Spike: Reconnect Storm Thundering-Herd Crash

## Summary

On May 11, 2026, the us-central production cloud pod restarted after a broad WebSocket disconnect and reconnect storm. The restart was not caused by memory growth. The container was killed by Kubernetes after health checks timed out.

The failure mode is best described as:

> WebSocket reconnect storm with thundering-herd amplification.

A large number of client and miniapp WebSockets disappeared at almost the same time. Clients and miniapps then reconnected in a tight burst. Each reconnect triggered repeated app initialization work, including database-backed installed-app refreshes and app-state broadcasts. That work appears to have overwhelmed the cloud process long enough that `/health` and `/livez` stopped responding, causing Kubernetes to restart the container.

The important fix is not fancy storm-mode logic first. The reconnect path should stop doing nonessential work all the time.

## Incident Timeline

All times are May 11, 2026.

| Time | Event |
| --- | --- |
| 10:27 PM PDT, May 10 / 05:27 UTC | BetterStack host-memory alerts fired across many AKS nodes. |
| 04:53 AM PDT / 11:53 UTC | Host-memory alerts resolved together. |
| 10:46:02 AM PDT / 17:46:02 UTC | Last normal pre-crash `system-vitals` log from us-central prod. RSS about 401 MB, active sessions about 74. |
| 10:46:10 AM PDT / 17:46:10 UTC | 62 glasses/client WebSockets closed with code 1006 in one second. 49 app WebSockets also closed with code 1006 in the same window. |
| 10:46:11-10:46:13 AM PDT / 17:46:11-17:46:13 UTC | 72 slow app-connect diagnostics emitted across 29 users and 11 packages. |
| 10:46:15-10:46:16 AM PDT / 17:46:15-17:46:16 UTC | 29 users reconnected, all after code 1006 closes, with downtime around 5.5-6.3 seconds. |
| 10:47:06 AM PDT / 17:47:06 UTC | BetterStack uptime incident started: `prod.augmentos.cloud/health` timeout. |
| 10:47:41 AM PDT / 17:47:41 UTC | Kubernetes killed and restarted the container in place. |
| 10:48:13 AM PDT / 17:48:13 UTC | New container emitted post-restart `system-vitals`. |
| 10:51:36 AM PDT / 17:51:36 UTC | BetterStack uptime incident resolved. |

## What We Confirmed

### This was not a Cloud memory leak

Kubernetes showed the previous container state as:

```text
Last State: Terminated
Reason: Error
Exit Code: 137
Started: Sun, 10 May 2026 10:29:58 -0700
Finished: Mon, 11 May 2026 10:47:41 -0700
```

The pod events showed repeated readiness and liveness probe timeouts before the kill:

```text
Readiness probe failed: /health context deadline exceeded
Liveness probe failed: /livez context deadline exceeded
Container cloud-prod-cloud failed liveness probe, will be restarted
```

The container was not marked `OOMKilled`. RSS before the stall was roughly 400 MB, far below the 4096 MB container limit.

### This was a same-pod container restart, not pod rescheduling

The pod name stayed the same:

```text
cloud-prod-cloud-97cd59c8f-tz6cv
```

Only the container restarted. That means this was not a node eviction or a pod replacement.

### The host-memory BetterStack emails were a separate infrastructure alert

The host-memory emails started around 05:27 UTC and resolved around 11:53 UTC. They affected many AKS nodes at nearly the same time. The old node from the email, `aks-u4689eahyt4-84412711-vmss00001h`, was no longer in the cluster when checked.

Those alerts are worth tracking as AKS/Porter infrastructure noise, but they were not the direct cause of the 17:47 UTC prod restart.

### Both Cloud-to-client and Cloud-to-miniapp sockets were affected

At 17:46:10 UTC:

| Socket type | Count | Distinct users | Distinct packages | Close code |
| --- | ---: | ---: | ---: | --- |
| Glasses/client WebSockets | 62 | 62 | N/A | 1006 |
| App WebSockets | 47-49 | 31-34 depending on log field | 12-14 | 1006 |

Code 1006 means the socket disappeared without a normal close frame. That points to a network-shaped or transport-shaped interruption, not a clean application shutdown.

Affected app packages included:

- `com.mentra.captions`
- `com.mentra.ai`
- `cloud.augmentos.notify`
- `com.mentra.notes`
- `com.mentra.merge`
- `com.mentra.streamer`
- `com.mentra.translation`
- `com.kai.glasses`
- `com.youfeng.dashboard`
- `com.youfeng.g2-orchestrator`
- `napa-xccelerator-prod`

### The reconnect work was expensive

After the socket drop, the new diagnostics showed 72 slow app-connect logs across 29 users and 11 packages.

The raw slow-connect logs showed this shape:

```json
{
  "feature": "slow-app-connect",
  "mode": "connection_init",
  "durationMs": 119.7,
  "packageName": "com.mentra.captions",
  "phaseTimings": {
    "attachAppSocket": 12.7,
    "broadcastAppState": 97.1,
    "validateApiKey": 9.9
  },
  "slowPhases": ["broadcastAppState"]
}
```

And:

```json
{
  "feature": "slow-app-connect",
  "mode": "broadcast_app_state",
  "durationMs": 111.4,
  "phaseTimings": {
    "refreshInstalledApps": 111.3,
    "snapshotForClient": 0
  },
  "slowPhases": ["refreshInstalledApps"]
}
```

This says the hot path is:

```text
connection_init -> broadcastAppState -> refreshInstalledApps
```

## Relevant Code Path

In `cloud/packages/cloud/src/services/session/AppManager.ts`, `broadcastAppState()` always calls `refreshInstalledApps()`:

```ts
async broadcastAppState(): Promise<AppStateChange | null> {
  await this.refreshInstalledApps();
  const clientSessionData = await this.userSession.snapshotForClient();
  ...
  this.userSession.websocket.send(JSON.stringify(appStateChange));
}
```

`refreshInstalledApps()` calls:

```ts
const installedAppsList = await appService.getAllApps(this.userSession.userId);
```

In `cloud/packages/cloud/src/services/core/app.service.ts`, `getAllApps(userId)` does:

```ts
const user = await User.findOne({ email: userId });
const _appstoreApps = await App.find({ packageName: { $in: _installedApps } });
```

So reconnect can perform database-backed installed-app refreshes even when the installed app list has no reason to be stale.

## Working Hypothesis

The crash is not caused by the socket drops alone. The crash is caused by the server work triggered after the drops.

The sequence appears to be:

1. A network-shaped event causes many client and app WebSockets to close with code 1006.
2. Clients and apps reconnect almost together.
3. Reconnect runs too much per-user and per-app initialization work.
4. `connection_init` calls `broadcastAppState`.
5. `broadcastAppState` refreshes installed apps from Mongo.
6. Many reconnects do this at once.
7. The event loop stops responding to `/health` and `/livez`.
8. Kubernetes kills the container after repeated liveness failures.

## Why This Is a Thundering Herd

This is a thundering herd because many clients wake up from the same event and perform the same expensive work at the same time.

In this case, the herd is:

- app and glasses WebSockets reconnecting together
- each reconnect doing state refresh and broadcast work
- DB reads and session updates multiplying across users and apps

The fix is to make reconnect cheap and idempotent.

## What We Should Not Do First

Do not start with a complicated special-case "storm mode" as the primary fix.

Storm mode may still be useful as a safety net, but the first-order problem is that normal reconnect does unnecessary work. If work is not needed on a normal reconnect, it should not run during any reconnect.

## Open Questions

1. What caused the initial 1006 socket drop?
   - Public Cloudflare/Azure status did not show a matching obvious incident.
   - The close pattern still looks network-shaped or transport-shaped.

2. How many previous prod restarts show the same pattern?
   - Back-test prior incidents for `1006` close burst followed by slow `connection_init` / `broadcastAppState` / `refreshInstalledApps`.

3. Is `user.addRunningApp(packageName)` also a meaningful contributor?
   - `attachAppSocket()` calls it after ACK.
   - It may be unnecessary or backgroundable if the app is already running.

4. Is `validateApiKey` ever slow enough to matter during storms?
   - In the sampled raw logs it was smaller than `broadcastAppState`, but should stay in diagnostics.

5. Are app WebSocket reconnects and glasses reconnects triggered by the same upstream event?
   - Both closed with 1006 in the same second.
   - That strongly suggests common transport or pod-facing network disruption, but does not prove where.

## Evidence Queries

### Per-second storm shape

```sql
SELECT toStartOfSecond(dt) AS second,
  count() AS rows,
  countIf(JSONExtractString(raw,'feature')='ws-close') AS ws_close,
  countIf(JSONExtractString(raw,'feature')='ws-reconnect') AS ws_reconnect,
  countIf(JSONExtractString(raw,'feature')='app-ws-close') AS app_ws_close,
  countIf(JSONExtractString(raw,'feature')='slow-app-connect') AS slow_app_connect,
  countIf(JSONExtractString(raw,'feature')='slow-app-message') AS slow_app_message,
  uniqExact(JSONExtractString(raw,'userId')) AS users
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type = 1
  AND dt >= '2026-05-11 17:45:30'
  AND dt <= '2026-05-11 17:47:00'
  AND JSONExtractString(raw,'server') = 'cloud-prod'
  AND JSONExtractString(raw,'region') = 'us-central'
GROUP BY second
ORDER BY second;
```

### App WebSocket close package breakdown

```sql
SELECT JSONExtractString(raw,'packageName') AS packageName,
  JSONExtractInt(raw,'code') AS code,
  JSONExtractString(raw,'inferredCloseSource') AS inferred,
  count() AS closes,
  uniqExact(JSONExtractString(raw,'userId')) AS users
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type = 1
  AND dt >= '2026-05-11 17:46:09'
  AND dt <= '2026-05-11 17:46:12'
  AND JSONExtractString(raw,'server') = 'cloud-prod'
  AND JSONExtractString(raw,'region') = 'us-central'
  AND JSONExtractString(raw,'feature') = 'app-ws-close'
GROUP BY packageName, code, inferred
ORDER BY closes DESC;
```

### Slow app-connect breakdown

```sql
SELECT JSONExtractString(raw,'packageName') AS packageName,
  JSONExtractString(raw,'message') AS message,
  count() AS c,
  round(avg(JSONExtractFloat(raw,'durationMs')),1) AS avg_ms,
  max(JSONExtractFloat(raw,'durationMs')) AS max_ms,
  uniqExact(JSONExtractString(raw,'userIdHash')) AS users
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type = 1
  AND dt >= '2026-05-11 17:46:08'
  AND dt <= '2026-05-11 17:46:14'
  AND JSONExtractString(raw,'server') = 'cloud-prod'
  AND JSONExtractString(raw,'region') = 'us-central'
  AND JSONExtractString(raw,'feature') IN ('slow-app-connect','slow-app-message','slow-subscription-fanout')
GROUP BY packageName, message
ORDER BY c DESC, max_ms DESC;
```

## Conclusion

The observed crash is preventable even if the original socket drop is outside our control.

We do not need to guarantee that all WebSockets stay connected forever. We need to guarantee that a reconnect storm does not make the cloud process stop answering health checks.

The fix should make reconnect cheap:

- no installed-app refresh on every reconnect
- no duplicate app-state broadcast per app reconnect
- no DB write on reconnect when state is already true
- bounded/coalesced reconnect work
- reconnect-path tests that prove `/livez` stays responsive under a 50-100 connection burst

## Implementation Spike: Cheap Reconnect Prototype

Branch: `codex/issue-107-reconnect-storm`, based on `origin/staging`.

Prototype changes tried:

- `AppManager.broadcastAppState()` uses cached `userSession.installedApps` by default.
- callers can still request `broadcastAppState({ refreshInstalledApps: true })` for real app-list changes.
- `AppManager.scheduleBroadcastAppState()` coalesces duplicate broadcasts over a short 150 ms window.
- app `connection_init` schedules a cheap app-state broadcast instead of awaiting a DB-backed installed-app refresh inline.
- install and uninstall routes request an explicit installed-app refresh.
- the local Mentra-path storm harness waits for scheduled broadcasts and reports installed-app lookup counts.

Local harness command:

```bash
cd cloud
bun run tools/ws-storm-local/mentra-path-storm-harness.ts \
  --connect-mode=init \
  --users=56 \
  --apps-per-user=1 \
  --rounds=2 \
  --subscription-updates=1 \
  --user-db-async-ms=100 \
  --app-db-async-ms=20 \
  --broadcast-settle-ms=400 \
  --label=issue-107-incident-shaped-after
```

Result:

```text
round 1: 56 reconnects, 0 installed-app User.findOne lookups, 1 App.find query, max heartbeat gap 2 ms
round 2: 56 reconnects, 0 installed-app User.findOne lookups, 0 App.find queries, max heartbeat gap 2 ms
```

Interpretation:

- The reconnect burst no longer repeats `refreshInstalledApps()` per app connection.
- The event loop stayed responsive in the local harness.
- The remaining dominant phase is `attachAppSocket`, mostly because it still reads the user document for legacy app-specific settings and running-app persistence. That is async DB work, not the loop-pinning installed-app refresh fanout seen in the incident logs.
- Avoiding the legacy settings DB read may be possible later, but it is a broader behavior change and should not be mixed into this crash-prevention PR unless debug/staging still shows reconnect pressure after this fix.
