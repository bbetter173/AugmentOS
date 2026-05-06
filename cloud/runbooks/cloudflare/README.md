# Cloudflare

We use Cloudflare for DNS, edge proxy (HTTP/WebSocket), and DDoS
protection. Public traffic flows through Cloudflare into our
nginx ingress in AKS, then to the Porter pods.

```
Mobile / browser
  -> Cloudflare (DNS + edge proxy)
    -> nginx Ingress (in AKS)
      -> Porter pod (Bun process)
```

UDP audio is the exception: Cloudflare's proxy does not support
UDP, so UDP traffic uses a "DNS only" Cloudflare record (gray
cloud) and goes directly to the LoadBalancer IP. See
`cloud/issues/udp-loadbalancer/udp-loadbalancer-architecture.md`
for the historical design.

## Access

You need a Cloudflare account that has been added to the Mentra
zone. Ask Isaiah or Israelov.

- Dashboard: https://dash.cloudflare.com/
- API tokens are in Doppler if you need scripted access.

## What lives in Cloudflare

- DNS records for every public-facing hostname
  (`uscentralapi.mentraglass.com`, `useastapi.mentraglass.com`,
  `uswestapi.mentraglass.com`, `*.mentra.glass` web properties,
  the Porter dashboards, etc.).
- Edge proxy (orange cloud) for HTTP/WebSocket traffic.
- Page Rules / Configuration Rules (when needed).
- WAF rules (when needed). Keep the rule set small; surprising
  WAF blocks are hard to debug from inside the app.

## Procedures

- `load-balancer.md`: how the load balancer is set up, the idle
  timeout that bites WebSockets, DNS-only mode for UDP, common
  audit checklist.

## Things to know before changing anything

1. **The 100-second idle timeout.** Cloudflare drops idle
   WebSockets at around 100s. Our SDK and cloud already exchange
   pings well below that interval. If you change the ping
   cadence, verify the new interval is well under 100s.
2. **Orange cloud vs gray cloud.** Orange = proxied through
   Cloudflare (TCP/HTTP/WS, also gives DDoS protection). Gray =
   DNS only, traffic goes straight to the origin IP. UDP must be
   gray. If you flip a UDP record to orange, UDP stops working.
3. **DNS changes propagate fast inside Cloudflare** (seconds)
   but external resolvers can cache for the record TTL. Plan
   accordingly.
4. **Cache Rules can serve stale responses.** We do not currently
   cache API responses, but if you add a Page Rule or Cache Rule,
   double-check it does not catch a hostname that should never be
   cached.

## Audit checklist

Quarterly or after any infra change:

- [ ] DNS records match what Porter / AKS actually exposes
- [ ] No DNS records pointing at old IPs / decommissioned regions
- [ ] WAF rules (if any) reviewed for false positives in logs
- [ ] No Page Rules or Cache Rules caching API responses
- [ ] TLS settings: at least TLS 1.2, full strict mode if origin
      has a valid cert
- [ ] HSTS still enabled for production hostnames
- [ ] All API hostnames have orange cloud (proxied)
- [ ] UDP-related records still gray cloud (DNS only)

`load-balancer.md` has the screenshots and walk-through for the
audit.

## Related

- `../porter/`: what runs behind nginx ingress.
- `../infra.md`: full traffic flow including BetterStack and
  Vector.
- `cloud/issues/udp-loadbalancer/`: history of how the
  UDP-direct path got set up. Useful context if you ever change
  it.
