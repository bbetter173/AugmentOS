# Spec: UDP Endpoint Hostname Migration for IPv6 Compatibility

## Overview

**What this doc covers:** What needs to change across infrastructure, cloud, and mobile to make UDP audio work on IPv6-only cellular networks — and the rollout order to do it safely.
**Why this doc exists:** Issue 051 confirmed that Australian users on IPv6-only cellular (Telstra, Optus, Vodafone) cannot reach the UDP audio endpoint because we send a raw IPv4 address. NAT64 — the mechanism that lets IPv6 hosts reach IPv4 — only works with hostnames, not raw IPs. No hostname, no NAT64, no audio, no transcription.
**What you need to know first:** [cloud/issues/051-g1-captions-dropout-after-ble-reconnect/spike.md](../051-g1-captions-dropout-after-ble-reconnect/spike.md) (Finding 3), [cloud/issues/udp-loadbalancer/](../udp-loadbalancer/) (how the UDP LB is set up today).
**Who should read this:** Cloud engineers, mobile engineers, anyone managing DNS or Porter deployments.

## The Problem in 30 Seconds

The phone gets the UDP audio endpoint as a raw IPv4 address (`20.239.105.210`) from the cloud's `CONNECTION_ACK`. On IPv6-only cellular networks, the phone cannot open a UDP socket to a raw IPv4 literal — NAT64 requires a hostname so DNS64 can synthesize an IPv6 address. The phone logs `IPv6 has been deactivated due to bind/connect, and DNS lookup found no IPv4 address(es)` and UDP never connects. Audio never reaches the cloud. Transcription dies silently.

This affects any user on an IPv6-only carrier. Australia is the first confirmed case, but IPv6-only cellular is increasingly common globally (T-Mobile US, EE UK, Jio India, most carriers in parts of Asia).

## Current Architecture

```
Phone ← CONNECTION_ACK { udpHost: "20.239.105.210", udpPort: 8000 }
         ↓
Phone opens UDP socket to 20.239.105.210:8000 (raw IPv4)
         ↓
On IPv6-only network: FAILS — no IPv4 route, no DNS lookup to trigger NAT64
```

The raw IP comes from:

1. Azure assigns a public IPv4 to the Kubernetes `LoadBalancer` service (`cloud-{env}-udp`)
2. We copy that IP into Porter env var `UDP_HOST` (or Doppler)
3. Cloud reads `process.env.UDP_HOST` and sends it in `CONNECTION_ACK`
4. Phone passes it directly to `UdpManager.configure(host, port)` — no DNS, no resolution

Hostnames were documented as a "nice to have" in `cloud/issues/udp-loadbalancer/udp-loadbalancer-spec.md` but never implemented. Every reference in the codebase uses raw IPv4.

## Spec

### 1. Create DNS hostnames for every region's UDP endpoint

Create a DNS-only A record in Cloudflare for each cluster's UDP LoadBalancer IP. **Proxy must be OFF (gray cloud)** — Cloudflare cannot proxy UDP traffic.

Naming convention: `udp-{env}-{region}.mentra.glass`

| Cluster | Region         | Current UDP_HOST    | New hostname                      |
| ------- | -------------- | ------------------- | --------------------------------- |
| 4689    | central-us     | `52.189.74.237`     | `udp-prod-uscentral.mentra.glass` |
| 4965    | us-west        | (check via kubectl) | `udp-prod-uswest.mentra.glass`    |
| 4977    | us-east        | (check via kubectl) | `udp-prod-useast.mentra.glass`    |
| 4696    | france         | (check via kubectl) | `udp-prod-france.mentra.glass`    |
| 4754    | east-asia      | `20.239.105.210`    | `udp-prod-eastasia.mentra.glass`  |
| 4978    | australia-east | (check via kubectl) | `udp-prod-au.mentra.glass`        |
| 4753    | canada-central | (check via kubectl) | `udp-prod-canada.mentra.glass`    |

For clusters with both dev and prod, also create `udp-dev-{region}.mentra.glass`.

**To get the actual IPs for clusters not listed above:**

```
porter kubectl -- get svc -n default -l porter.run/app-name=cloud-prod --cluster <ID> | grep udp
```

### 2. Update `UDP_HOST` env vars to use hostnames

For each cloud deployment, change the Porter env var `UDP_HOST` from the raw IP to the new hostname:

```
porter env set -a cloud-prod --cluster 4754 \
  -v 'UDP_HOST=udp-prod-eastasia.mentra.glass'
```

Repeat for every cluster. The cloud code (`bun-websocket.ts`) already passes `UDP_HOST` as a string — no cloud code change needed for this step.

The phone now receives `udpHost: "udp-prod-eastasia.mentra.glass"` in `CONNECTION_ACK` instead of `udpHost: "20.239.105.210"`.

### 3. Mobile: ensure UDP socket handles hostname resolution and IPv6

The phone's `UdpManager` currently receives the host string and passes it to the React Native UDP library. Two things need to be verified and potentially fixed:

**a) Hostname resolution:** The UDP library must resolve the hostname before sending. On IPv6-only networks with DNS64, the resolver returns a synthesized IPv6 address (e.g., `64:ff9b::14ef:69d2` for `20.239.105.210`). The library must use this IPv6 address for the socket.

**b) Dual-stack socket:** The current error (`IPv6 has been deactivated due to bind/connect`) suggests the socket is created in IPv4-only mode. The socket creation needs to support both IPv4 and IPv6 (dual-stack), or detect the network type and choose accordingly.

This is the part that requires mobile code changes. The specific fix depends on which React Native UDP library is in use — check `mobile/package.json` for the UDP dependency and its IPv6 support.

**Fallback behavior:** If hostname resolution fails (e.g., DNS is unreachable), the phone should log a clear error and retry. It should NOT fall back to WebSocket for audio — that's a separate transport with different latency characteristics and would mask the problem.

### 4. Keep raw IP as fallback during migration

To avoid breaking existing clients during rollout, the cloud should send both hostname and raw IP:

```typescript
// cloud/packages/cloud/src/services/websocket/bun-websocket.ts
const udpHost = process.env.UDP_HOST; // now a hostname
const udpIp = process.env.UDP_HOST_IP; // raw IP fallback (optional)
const udpPort = process.env.UDP_PORT ? parseInt(process.env.UDP_PORT, 10) : 8000;
if (udpHost) {
  (ackMessage as any).udpHost = udpHost;
  (ackMessage as any).udpHostFallbackIp = udpIp || null;
  (ackMessage as any).udpPort = udpPort;
}
```

Mobile clients that understand `udpHost` as a hostname use it directly (with DNS resolution). Older clients that can't resolve hostnames fall back to `udpHostFallbackIp`. Once all clients are updated, the fallback can be removed.

## Rollout Order

1. **Create DNS records** — zero risk, no client impact, purely additive
2. **Verify DNS resolution** — `dig udp-prod-au.mentra.glass` returns the correct IP from multiple locations
3. **Update one non-production deployment** (e.g., `cloud-dev` on central-us) — change `UDP_HOST` to hostname, test with a phone on WiFi (dual-stack) and cellular
4. **Mobile release with dual-stack UDP** — update `UdpManager` to handle hostname resolution and IPv6 sockets
5. **Roll hostnames to all production clusters** — update `UDP_HOST` for every cluster
6. **Verify on an IPv6-only network** — test with an Australian SIM or use an IPv6-only WiFi hotspot (many guides online for creating one with a Mac)
7. **Clean up** — remove `UDP_HOST_IP` fallback after all clients are updated (minimum 2 app versions later)

## Decision Log

| Decision                                            | Alternatives considered               | Why we chose this                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DNS-only A records in Cloudflare (gray cloud)       | Cloudflare proxy (orange cloud)       | Cloudflare cannot proxy UDP — only HTTP/WS. Orange cloud would silently drop all UDP packets.                                                                                             |
| Hostname in CONNECTION_ACK (not build-time env var) | `EXPO_PUBLIC_UDP_HOST_OVERRIDE`       | The CONNECTION_ACK path is already how every production phone gets the UDP endpoint. Build-time env vars are only for dev/debug. Changing CONNECTION_ACK fixes all users on next connect. |
| `mentra.glass` domain (not `augmentos.cloud`)       | `augmentos.cloud` subdomain           | `mentra.glass` is the production domain. Using it for UDP keeps DNS management in one zone.                                                                                               |
| Keep raw IP as temporary fallback                   | Hard cut to hostname-only             | Old mobile clients that don't handle hostname resolution would break. Fallback avoids a forced update.                                                                                    |
| Per-region hostnames (not a single global hostname) | Single `udp.mentra.glass` with GeoDNS | Each region has a separate Azure LB with a separate IP. GeoDNS adds complexity and a failure mode we don't need. Per-region hostnames match the existing per-region `UDP_HOST` env vars.  |

## Testing

- **Dual-stack WiFi (IPv4 + IPv6):** UDP should work exactly as before. Hostname resolves to IPv4 A record. No behavior change.
- **IPv6-only cellular (Australia):** UDP should now work. DNS64 synthesizes an IPv6 address from the A record. Phone opens IPv6 socket. Packets flow through carrier's NAT64 gateway to the IPv4 Azure LB.
- **IPv4-only network:** UDP should work exactly as before. Hostname resolves to IPv4 A record.
- **DNS failure:** Phone should log a clear error and retry. No silent failure.
- **Old client + new cloud (hostname in CONNECTION_ACK):** If the old client passes the hostname string to the UDP library and the library tries to use it as a raw IP, it will fail. This is why the fallback IP field exists — old clients can use `udpHostFallbackIp` if `udpHost` doesn't look like an IP.

## Edge Cases

- **Azure LB IP changes:** If the Kubernetes service is deleted and recreated, Azure assigns a new IP. The DNS A record must be updated. This is the same operational burden as updating `UDP_HOST` today — but now it's one DNS record update instead of N Porter env var updates.
- **DNS propagation delay:** Cloudflare DNS-only records propagate within seconds (not hours). But if a phone caches a stale DNS result, it would fail to reach the new IP. TTL should be set low (60–300 seconds) during the migration period.
- **Multiple pods behind one LB:** The UDP LoadBalancer service already handles this — Azure LB distributes packets across pods. Hostname resolution doesn't change this behavior.
