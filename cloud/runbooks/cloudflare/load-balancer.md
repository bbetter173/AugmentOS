# Cloudflare Load Balancer & DNS

Cloudflare sits in front of every public-facing API hostname.
This doc covers what is configured, how to audit it, and the
gotchas that have bitten us.

## Hostnames currently behind Cloudflare

| Hostname | Points at | Proxy | Used for |
| --- | --- | --- | --- |
| `uscentralapi.mentraglass.com` | central nginx ingress | orange (proxied) | Cloud API + WebSockets |
| `useastapi.mentraglass.com` | us-east nginx ingress | orange (proxied) | Cloud API + WebSockets |
| `uswestapi.mentraglass.com` | us-west nginx ingress | orange (proxied) | Cloud API + WebSockets |
| `rtmp-relay-uscentral.mentra.glass` | RTMP relay LB | (verify) | RTMP ingest |
| `udp.debug.augmentos.cloud` | central LoadBalancer IP | gray (DNS only) | UDP audio |

Verify the live state in the dashboard; this table is a snapshot
that needs to be kept current.

[screenshot: Cloudflare DNS list filtered by `mentraglass.com`,
showing the three regional API records with orange-cloud proxy
status]

[screenshot: same for `mentra.glass`]

## Proxy mode (orange vs gray)

- **Orange cloud (proxied)**: traffic flows through Cloudflare.
  We get TLS termination, DDoS protection, WAF, and bot
  mitigation. The origin IP is hidden. This is the default for
  HTTP and WebSocket traffic.
- **Gray cloud (DNS only)**: Cloudflare resolves the record but
  traffic goes directly to the origin IP. The origin IP is
  public. Used for protocols Cloudflare cannot proxy, primarily
  UDP.

Switching a record from orange to gray exposes the origin IP
publicly. Switching from gray to orange breaks anything that
depends on the origin IP being reachable directly (e.g. UDP).
Treat each switch as an intentional change, not an incidental
toggle.

[screenshot: Cloudflare DNS edit modal showing the proxy toggle]

## The 100-second idle timeout

Cloudflare drops idle WebSocket connections at around 100
seconds. If neither side sends a frame within that window the
connection is closed.

Our SDK and cloud already exchange application-level pings well
under that interval, so this is not a problem in normal
operation. It bites in two cases:

1. **A new SDK ping cadence above 100s.** If you tune the
   interval, keep it well under 100s. We currently ping every
   ~10s on the cloud side; the SDK pings as well.
2. **An nginx-side timeout that is shorter than the
   application-level ping interval.** The nginx ingress has its
   own idle timeout (3600s for WebSocket paths in our config).
   Cloudflare's 100s is the tighter constraint.

If you see WebSocket disconnects clustered exactly at the
100-second mark, the application-level ping is misconfigured or
silenced.

## Audit walk-through

Quarterly or after any infra change. Takes ~10 minutes.

### 1. DNS records vs reality

Pull the list of records and compare to what Porter / AKS
actually exposes:

```bash
# From AKS, list the LoadBalancer service IPs you care about
porter kubectl --cluster <CLUSTER_ID> -- get svc -A \
  -o wide | grep LoadBalancer
```

For each ingress IP, find the matching Cloudflare A record. Any
record that does not match a live ingress is stale; either
update or delete it.

[screenshot: Cloudflare DNS page filtered by record type A, with
TTLs visible]

### 2. Proxy mode

For each API hostname:

- HTTP/WS hostnames: orange cloud
- UDP hostnames: gray cloud
- One-off debug hostnames: usually gray; mark explicitly

Anything that changed without an associated ticket or runbook
update is suspicious.

### 3. TLS settings

Dashboard -> SSL/TLS -> Overview:

- **Encryption mode**: Full (strict). The origin must have a
  valid public cert. Anything weaker (Flexible, Full
  non-strict) is unsafe and should not be used in production.
- **Minimum TLS version**: at least 1.2. 1.3 preferred.
- **HSTS**: enabled for production hostnames. Verify max-age is
  at least 1 year.

[screenshot: SSL/TLS Overview page showing encryption mode]

[screenshot: Edge Certificates page showing HSTS settings]

### 4. WAF and Page Rules

Dashboard -> Security -> WAF:

- Review any custom rules. Are they still needed?
- Check the recent activity log for false positives. Look for
  rules blocking legitimate user agents (mobile clients,
  internal tools).

Dashboard -> Rules -> Page Rules and Configuration Rules:

- Confirm none of them touch API hostnames in ways that change
  cache behavior or strip headers.

[screenshot: WAF Custom Rules list]

### 5. Spectrum / non-HTTP services

If we ever add Cloudflare Spectrum (paid TCP/UDP proxying), it
shows up under a separate section. Today we do not use it. UDP
goes direct to the AKS LoadBalancer IP via gray-cloud DNS.

## Common changes

### Adding a new region

1. Stand up the AKS cluster + nginx ingress in the new region.
   Note the public LoadBalancer IP.
2. In Cloudflare DNS, add an A record:
   - Name: `<region>api.mentraglass.com`
   - IPv4: the LoadBalancer IP
   - Proxy: orange (HTTP/WS goes through Cloudflare)
   - TTL: Auto
3. Wait ~30 seconds, then verify:
   ```bash
   curl -I https://<region>api.mentraglass.com/health
   # 200 OK with `cf-ray` header proves Cloudflare is in path
   ```
4. Update this table at the top of this doc.
5. If UDP audio is needed in the new region, add a separate gray-
   cloud record (e.g. `udp.<region>.mentra.glass`) pointing at the
   AKS LoadBalancer service IP, not the ingress IP.

### Rotating an origin IP

If a region's nginx ingress IP changes (cluster recreate, etc.):

1. Update the Cloudflare A record to the new IP.
2. Verify with `curl` (above).
3. The orange-cloud proxy means clients should not notice the
   change; Cloudflare hides the origin IP.

### Pausing Cloudflare for an origin

If you suspect Cloudflare is breaking traffic and want to test
direct, switch the record to gray (DNS only) temporarily.
Clients hit the origin directly. Switch back to orange when
done. Do not leave production records on gray; we lose DDoS
protection.

## Common failures

- **403 with Cloudflare branding**: WAF rule blocked the
  request. Check Security -> WAF -> Activity log with the
  request's `cf-ray` header.
- **520 / 521 / 522 errors**: origin unreachable from Cloudflare.
  Almost always nginx ingress or Porter pod, not Cloudflare.
  Check Porter, then `bstack health`.
- **TLS errors after a cert change**: encryption mode is "Full
  (strict)" but the origin cert is expired or self-signed. Fix
  the origin cert; do not weaken the encryption mode.
- **WebSocket disconnects every ~100s**: application-level
  pings are not happening. Check the SDK ping config and the
  cloud's heartbeat logic.
- **UDP suddenly stops**: someone flipped a UDP record from gray
  to orange. Flip it back.
