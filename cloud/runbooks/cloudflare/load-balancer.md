# Regional Load Balancers

We run two Cloudflare load balancers in front of the cloud. Both
geo-steer users to a Porter cluster in the nearest healthy
region. They share the same pool inventory but differ in
hostname and steering policy.

| LB | Hostname | Used by |
| --- | --- | --- |
| Production | `api.mentra.glass` | Mobile app, today's production traffic |
| Secondary | `api.mentraglass.com` | No production customers; not pointed at by any production client |

The mobile app points at `api.mentra.glass`. Anything that lives
only on `api.mentraglass.com` (today: the `us-west` pool in WNAM)
is reachable but not getting real production traffic.

> Values in this doc were pulled live from the Cloudflare API
> and the Porter CLI. Treat tables as a snapshot. Re-pull with
> the commands at the bottom of this doc when verifying state.

## Traffic flow

```
User
  -> api.mentra.glass (Cloudflare anycast IP, e.g. 104.21.87.160)
    -> Cloudflare LB (production)
      -> geo-steered to nearest healthy pool
        -> pool origin hostname (e.g. uscentralapi.mentraglass.com)
          -> AKS public ingress IP (e.g. 128.203.164.18)
            -> nginx ingress in Porter cluster
              -> Porter pod (Bun process)
```

TLS terminates at Cloudflare. Cloudflare opens a backend
connection to the pool origin. The origin hostname resolves to
the AKS LoadBalancer service IP for that cluster's nginx
ingress. Each cluster's `cloud-prod` app declares the LB
hostnames as domains, so nginx accepts traffic for them and
routes to the cloud pod.

## What we have today

### Production LB: `api.mentra.glass`

| Field | Value |
| --- | --- |
| Zone | `mentra.glass` |
| LB ID | `0d6e09e5427a8b94d3ce47f58496e1b8` |
| Proxied | yes (orange cloud) |
| Steering policy | `geo` (Cloudflare regions to pool list) |
| Session affinity | `ip_cookie`, TTL 3600s |
| Adaptive routing | failover across pools disabled |
| Fallback pool | `asiaeast` |

Region steering:

| CF region | Covers | Pool used |
| --- | --- | --- |
| `WNAM` | West North America | `uscentral` |
| `ENAM` | East North America | `uscentral` |
| `NSAM` / `SSAM` | The Americas, south | `uscentral` |
| `WEU` / `EEU` | Europe | `france` |
| `OC` / `ME` | Oceania, Middle East | `asiaeast` |
| (other) | Africa, Asia (non-ME) | `asiaeast` (fallback) |

`us-west` is NOT in any region's pool list on this LB. WNAM
traffic goes to `uscentral`.

### Secondary LB: `api.mentraglass.com`

| Field | Value |
| --- | --- |
| Zone | `mentraglass.com` |
| LB ID | `b34e8b4b2d960e78ba48fa235f4742c2` |
| Proxied | yes (orange cloud) |
| Steering policy | `proximity` (great-circle distance to pool lat/long) |
| Session affinity | `ip_cookie`, TTL 3600s |
| Fallback pool | `uscentral` |

Region steering (mostly mirrors production, except WNAM):

| CF region | Pool used |
| --- | --- |
| `WNAM` | `us-west` |
| `ENAM` | `uscentral` |
| `NSAM` / `SSAM` | `uscentral` |
| `WEU` / `EEU` | `france` |
| `OC` / `ME` | `asiaeast` |

The two LBs differ in two places:

1. **Steering policy.** Production uses `geo` (each region maps
   to one pool, fixed). Secondary uses `proximity` (Cloudflare
   picks the closest healthy pool by lat/long). Practically they
   route the same way most of the time; `proximity` falls over
   more gracefully if a pool is unhealthy.
2. **WNAM pool.** Production routes WNAM to `uscentral`.
   Secondary routes WNAM to `us-west`. Today this means
   `us-west` only receives traffic from clients pointing at
   `api.mentraglass.com`, which is no production client.

### Pools (shared between both LBs)

| Pool | Origin hostname | AKS public IP | Porter cluster | Monitor | In production LB | In secondary LB |
| --- | --- | --- | --- | --- | --- | --- |
| `uscentral` | `uscentralapi.mentraglass.com` | 128.203.164.18 | mentra-cluster-central-us (4689) | yes | yes (WNAM, ENAM, NSAM, SSAM) | yes (ENAM, NSAM, SSAM, fallback) |
| `france` | `franceapi.mentraglass.com` | 172.189.45.70 | france (4696) | yes | yes (WEU, EEU) | yes (WEU, EEU) |
| `asiaeast` | `asiaeastapi.mentraglass.com` | 20.6.155.16 | east-asia (4754) | yes | yes (OC, ME, fallback) | yes (OC, ME) |
| `us-west` | `uswestapi.mentraglass.com` | 4.155.178.137 | us-west (4965) | yes | no | yes (WNAM) |
| `us-east` | `useastapi.mentraglass.com` | 4.157.182.57 | us-east (4977) | no (intentionally) | no | no |

`us-east` is intentionally excluded from both LBs. The us-east
AKS cluster has insufficient nodes for the `cloud-prod` workload
and deploys often fail. The pool is left in place so it is easy
to enable later when capacity is fixed; until then it has no
monitor and is not wired into either LB's region map.

`us-west` is in the secondary LB only. No production client
points at `api.mentraglass.com` today, so traffic to `us-west`
is essentially zero in practice. Putting it in the production
LB is a separate decision (capacity check + cutover plan).

### Monitors

The 4 active pools share the same monitor shape:

| Field | Value |
| --- | --- |
| Type | HTTPS |
| Method | GET |
| Path | `/health` |
| Interval | 60s |
| Timeout | 5s |
| Retries | 2 |
| Expected codes | 200 |
| Follow redirects | no |
| Allow insecure | no |

`/health` is the cloud's readiness endpoint. It iterates
sessions, counts WebSockets, updates gauges, serializes JSON.
A 5-second timeout is generous; a healthy region should respond
in well under a second.

### nginx ingress timeouts

Each Porter cluster's `cloud-prod` app sets these annotations on
its nginx ingress:

```yaml
ingressAnnotations:
  nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
  nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

The 3600-second read/send timeouts are what keep WebSocket
connections alive at the nginx layer. Cloudflare's idle timeout
is the tighter constraint (next section).

## The 100-second WebSocket idle timeout

Cloudflare drops idle WebSocket connections at around 100
seconds. If neither side sends a frame within that window the
connection is closed. The cloud and SDK exchange application-
level pings well under this interval, so it does not bite in
normal operation.

It bites in two cases:

1. A new ping cadence above 100s, or pings that get silenced
   somewhere in the stack.
2. A change to the SDK that defers pings until after the first
   user message. Always send pings unconditionally.

If WebSockets disconnect clustered exactly at 100 seconds,
application-level pings are misconfigured. Look at
`@mentra/sdk` and the cloud heartbeat logic.

## Porter clusters not in any LB

Some Porter clusters run `cloud-prod` but are not wired into
either LB. Their `cloud-prod` apps only have an auto-generated
`*.onporter.run` hostname.

| Porter cluster | Cluster ID | Status |
| --- | --- | --- |
| canada-central | 4753 | Provisioned, no LB pool, no API hostname domains |
| australia-east | 4978 | Provisioned, no LB pool, no API hostname domains |

If you want one of these to take traffic from either LB, follow
"Adding a new region" below. The work is the same as a new
cluster, except the cluster already exists.

## Adding a new region

End-to-end. Roughly: provision the AKS cluster in Porter,
deploy `cloud-prod` with regional domains, create a Cloudflare
pool + monitor + DNS record, plug the pool into one or both
LBs' region steering map.

If the new region should serve production traffic, plug it into
the production LB (`api.mentra.glass`). If you only want to
test it on the secondary LB first, plug it into the secondary LB
and leave the production LB alone.

### 1. Provision the AKS cluster in Porter

The Porter CLI does not create clusters. Use the dashboard:

1. Open https://dashboard.porter.run/
2. Project: `mentra` -> Add Cluster.
3. Pick Azure -> AKS -> the Azure region you want
   (e.g. South-East Asia, Brazil South, etc.).
4. Use the standard node SKU and node count we use elsewhere
   (verify against an existing cluster's settings).
5. Wait for provisioning (15-30 minutes).

Confirm the cluster exists:

```bash
porter cluster list
# new row appears with an ID, e.g. 5012 brazil-south
```

Note the cluster ID; you will pass it as `--cluster <ID>` for
the rest of this procedure.

### 2. Deploy `cloud-prod` to the new cluster

```bash
# From repo root, with the appropriate branch checked out
cd cloud

# The deployment target is auto-named <cluster-name>-default.
porter app create cloud-prod \
  --file ./porter.yaml \
  --cluster <NEW_CLUSTER_ID> \
  --target <region>-default

# Watch the build
porter app logs cloud-prod \
  --cluster <NEW_CLUSTER_ID> --target <region>-default --build
```

Once the build completes and the pod is Ready, find the
auto-generated `*.onporter.run` hostname:

```bash
porter app yaml cloud-prod \
  --cluster <NEW_CLUSTER_ID> --target <region>-default \
  | grep onporter.run
```

That hostname maps to the AKS LoadBalancer service IP for the
nginx ingress in this cluster. Resolve it to get the IP:

```bash
dig +short cloud-XXXX-XXXX.onporter.run
```

### 3. Create the regional API hostname

In Porter, edit the `cloud-prod` app for this cluster and add
the API hostnames to the `domains:` list. Include both LB
hostnames (so the cluster accepts requests from either LB) plus
the regional hostnames in both zones:

```yaml
domains:
  - name: api.mentra.glass            # production LB
  - name: api.mentraglass.com         # secondary LB
  - name: <region>api.mentra.glass    # zone-internal regional
  - name: <region>api.mentraglass.com # the actual LB origin name
```

Replace `<region>` with the slug you'll use for the pool
(`brazilsouth`, `southeastasia`, etc.). Lowercase, no dashes,
matches the existing naming pattern.

In Cloudflare, add an A record in the `mentraglass.com` zone:

- Name: `<region>api`
- Type: A
- IPv4: the AKS LoadBalancer IP from step 2
- Proxy: gray cloud (DNS only)

The origin hostname must NOT be proxied. The Cloudflare LB needs
to reach the origin directly to send traffic.

Optional: also add `<region>api.mentra.glass` in the `mentra.glass`
zone, gray cloud, same IP. Useful if you want a direct-access
hostname; not strictly required for the LB to work since the LB
uses the `mentraglass.com` origin.

Verify:

```bash
dig +short <region>api.mentraglass.com
# should return the AKS IP, not a Cloudflare IP

curl -I https://<region>api.mentraglass.com/health
# 200 OK
```

### 4. Create the Cloudflare LB pool

```bash
CF_TOKEN=$(doppler secrets get CLOUDFLARE_LB_API_TOKEN \
  --project mentra-sre --config dev --plain)
ACCOUNT_ID=3c764e987404b8a1199ce5fdc3544a94

# Create the monitor first (the pool references it)
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/monitors" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "https",
    "description": "<Region> Monitor",
    "method": "GET",
    "path": "/health",
    "interval": 60,
    "timeout": 5,
    "retries": 2,
    "expected_codes": "200",
    "follow_redirects": false,
    "allow_insecure": false
  }'
# returns { "result": { "id": "<MONITOR_ID>", ... } }

# Then create the pool
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<region-slug>",
    "description": "<Region> Cloud",
    "enabled": true,
    "minimum_origins": 1,
    "monitor": "<MONITOR_ID>",
    "latitude": <approximate-latitude>,
    "longitude": <approximate-longitude>,
    "origins": [
      {
        "name": "<region-slug>",
        "address": "<region>api.mentraglass.com",
        "enabled": true,
        "weight": 1
      }
    ]
  }'
# returns { "result": { "id": "<POOL_ID>", ... } }
```

Pool name conventions: lowercase, matches the regional hostname
slug. Latitude/longitude can be approximate; Cloudflare uses
them for proximity steering only.

### 5. Plug the pool into one or both LBs

For a production-serving pool, update the production LB:

```bash
PROD_LB_ID=0d6e09e5427a8b94d3ce47f58496e1b8
PROD_ZONE=5bb5c71a90dc175143eb10edaad85d49

# Fetch current state, copy region_pools, edit
curl -s "https://api.cloudflare.com/client/v4/zones/$PROD_ZONE/load_balancers/$PROD_LB_ID" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -m json.tool > /tmp/prod-lb.json

# Edit /tmp/prod-lb.json: add <POOL_ID> to whichever region
# keys should route to it. Order matters: first healthy pool wins.
# e.g. for a Brazil cluster, change SSAM/NSAM:
#   "NSAM": ["<POOL_ID>", "<existing-uscentral-pool-id>"]

# PUT the LB back
curl -X PUT "https://api.cloudflare.com/client/v4/zones/$PROD_ZONE/load_balancers/$PROD_LB_ID" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/prod-lb.json
```

For the secondary LB, same procedure with different IDs:

```bash
SECONDARY_LB_ID=b34e8b4b2d960e78ba48fa235f4742c2
SECONDARY_ZONE=86a59033615f078d613b3cd22fd30c44

curl -s "https://api.cloudflare.com/client/v4/zones/$SECONDARY_ZONE/load_balancers/$SECONDARY_LB_ID" \
  -H "Authorization: Bearer $CF_TOKEN" \
  > /tmp/secondary-lb.json
# edit
curl -X PUT "https://api.cloudflare.com/client/v4/zones/$SECONDARY_ZONE/load_balancers/$SECONDARY_LB_ID" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/secondary-lb.json
```

Common pattern when bringing up a new region: put it in the
secondary LB first, run real traffic at it via a test client,
verify health, then add it to the production LB.

### 6. Verify end to end

```bash
# Pool reports healthy
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools/<POOL_ID>" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['result']['healthy'])"
# expect: True

# A user in the new region resolves api.mentra.glass through
# the new pool. Easiest check: from inside the new region's
# network, or via a VPN, hit:
curl -s https://api.mentra.glass/health
# Then look at bstack logs to confirm the new region served the
# request:
bstack logs --region <new-region-slug>
```

### 7. Update this doc

Re-run the verification commands at the bottom of this doc and
update the tables here with the new pool, region steering rows,
and Porter cluster.

## Adding a cluster to an existing region

Sometimes you want to scale a region by adding a second cluster
behind the same pool. Less common; the steps shorten:

1. Provision the new AKS cluster (step 1 above).
2. Deploy `cloud-prod` with the same domain list as the existing
   regional cluster (step 2 + 3 above; reuse the regional
   hostname, do not invent a new one).
3. Add a second origin to the existing pool:

```bash
# Fetch current pool state
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools/<POOL_ID>" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -m json.tool > /tmp/pool.json

# Edit /tmp/pool.json: append to "origins": [...] with weight 1
# and address pointing at the new cluster's regional hostname.

# PUT the pool
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools/<POOL_ID>" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/pool.json
```

The pool then load-balances within itself across the two
clusters. Session affinity (`ip_cookie`) keeps a user pinned to
one cluster for the affinity TTL.

## Promoting `us-west` to production

The `us-west` pool is in the secondary LB but not the
production LB. To promote it:

1. Verify capacity in the us-west AKS cluster (4965). The pool
   today serves zero production traffic, so capacity has not
   been validated under load.
2. Add the `us-west` pool ID
   (`d2cd10f549c74159581d5963aad2ec28`) to the production LB's
   WNAM region pool list. Decide whether it goes ahead of or
   behind `uscentral`:
   - Ahead means WNAM users prefer `us-west`, fall back to
     `uscentral`. This is the migration path if you want to move
     west-coast traffic off `uscentral`.
   - Behind means WNAM still goes to `uscentral` first, with
     `us-west` as failover. Lower risk; useful as a smoke test.
3. Watch BetterStack for the new region to start serving
   traffic. Use `bstack health --region us-west` and
   `bstack incidents`.
4. Adjust the order if needed.

## Re-enabling `us-east`

The `us-east` cluster has node provisioning issues; deploys to
that cluster often fail. When that's resolved:

1. Verify `cloud-prod` deploys cleanly to the cluster:
   ```bash
   porter app yaml cloud-prod --cluster 4977 --target us-east-default
   porter app status cloud-prod --cluster 4977 --target us-east-default
   ```
2. Confirm `useastapi.mentraglass.com` resolves and `/health`
   returns 200.
3. Attach a monitor to the `us-east` pool (it has none today):
   ```bash
   curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/monitors" \
     -H "Authorization: Bearer $CF_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{ "type":"https","description":"US East Monitor","method":"GET","path":"/health","interval":60,"timeout":5,"retries":2,"expected_codes":"200","follow_redirects":false,"allow_insecure":false }'

   # Then PATCH the pool with the new monitor id
   curl -X PATCH "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools/db72728f6d03b46205bfb2bcef78e5fb" \
     -H "Authorization: Bearer $CF_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"monitor": "<NEW_MONITOR_ID>"}'
   ```
4. Add the pool to one of the LBs' region maps. Likely ENAM in
   the secondary LB first, then promote to the production LB
   after a soak period.

## Common operational tasks

### Drain a pool (stop sending it new traffic)

Disable the pool. Existing connections stay; new ones go
elsewhere.

```bash
curl -X PATCH "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools/<POOL_ID>" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

To re-enable, set `enabled` back to `true`. Disabling the pool
affects both LBs since they share the inventory.

### Disable a single origin in a pool

Same shape as drain, but at the origin level. Useful when a
pool has multiple clusters and you want to take one out:

```bash
# Fetch, edit origins[i].enabled = false, PUT back
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools/<POOL_ID>" \
  -H "Authorization: Bearer $CF_TOKEN" > /tmp/pool.json
# edit
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools/<POOL_ID>" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/pool.json
```

### Check pool health

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools/<POOL_ID>" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import sys,json; r=json.load(sys.stdin); p=r['result']; print(p['name'], 'healthy=', p['healthy']); [print(o['name'], 'enabled=', o['enabled']) for o in p['origins']]"
```

If a pool flips unhealthy, the LB stops sending it traffic.
Cloudflare keeps health-checking; the pool comes back when
`/health` returns 200 again. To investigate the underlying
cause, see `cloud/tools/bstack/runbooks/pod-crash.md`.

## Re-pull live state

The tables in this doc go stale. To refresh:

```bash
CF_TOKEN=$(doppler secrets get CLOUDFLARE_LB_API_TOKEN \
  --project mentra-sre --config dev --plain)
ACCOUNT_ID=3c764e987404b8a1199ce5fdc3544a94

# Both LBs (one per zone)
PROD_ZONE=5bb5c71a90dc175143eb10edaad85d49
PROD_LB=0d6e09e5427a8b94d3ce47f58496e1b8
SECONDARY_ZONE=86a59033615f078d613b3cd22fd30c44
SECONDARY_LB=b34e8b4b2d960e78ba48fa235f4742c2

curl -s "https://api.cloudflare.com/client/v4/zones/$PROD_ZONE/load_balancers/$PROD_LB" \
  -H "Authorization: Bearer $CF_TOKEN" | python3 -m json.tool
curl -s "https://api.cloudflare.com/client/v4/zones/$SECONDARY_ZONE/load_balancers/$SECONDARY_LB" \
  -H "Authorization: Bearer $CF_TOKEN" | python3 -m json.tool

# All pools (account-wide; same pools serve both LBs)
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools" \
  -H "Authorization: Bearer $CF_TOKEN" | python3 -m json.tool

# All monitors
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/monitors" \
  -H "Authorization: Bearer $CF_TOKEN" | python3 -m json.tool

# Porter clusters and apps
porter cluster list
for cid in $(porter cluster list 2>/dev/null | awk 'NR>1{print $1}'); do
  echo "--- cluster $cid ---"
  porter app list --cluster $cid
done
```

If the actual state differs from this doc, update the doc.
