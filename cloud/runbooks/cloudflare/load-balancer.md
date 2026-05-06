# Regional Load Balancer

Public API traffic enters at `api.mentra.glass`, which is a
Cloudflare load balancer that geo-steers users to a Porter
cluster in the nearest region. This doc covers how it is wired
up, what settings we have, and how to add a new region or
cluster to the rotation.

> Values in this doc were pulled live from the Cloudflare API
> and the Porter CLI. Treat tables as a snapshot. Re-pull with
> the commands at the bottom of this doc when verifying state.

## Traffic flow

```
User
  -> api.mentra.glass (Cloudflare anycast IP, e.g. 104.21.87.160)
    -> Cloudflare LB "Mentra Cloud Load Balancer"
      -> geo-steered to nearest healthy pool
        -> pool origin hostname (e.g. uscentralapi.mentraglass.com)
          -> AKS public ingress IP (e.g. 128.203.164.18)
            -> nginx ingress in Porter cluster
              -> Porter pod (Bun process)
```

TLS terminates at Cloudflare. Cloudflare opens a backend
connection to the pool origin. The origin hostname resolves to
the AKS LoadBalancer service IP for that cluster's nginx
ingress. Each cluster's `cloud-prod` app declares
`api.mentra.glass` as a domain, so nginx accepts traffic for
that hostname and routes to the cloud pod.

## What we have today

### Load balancer

| Field | Value |
| --- | --- |
| Hostname | `api.mentra.glass` |
| Zone | `mentra.glass` |
| Proxied | yes (orange cloud, traffic flows through Cloudflare) |
| Steering policy | `geo` (Cloudflare regions to pool list) |
| Session affinity | `ip_cookie`, TTL 3600s |
| Adaptive routing | failover across pools disabled |
| Fallback pool | `asiaeast` |

Session affinity by `ip_cookie` means once a user is steered to
a pool, Cloudflare drops a cookie that pins them there for an
hour. Useful for our WebSocket-heavy traffic; reduces the number
of times a user reconnects to a new pod across regions.

### Pools

5 pools exist. 4 of them are wired into the steering map; 1
(`us-east`) is provisioned but inactive (no monitor, not in any
region's pool list).

| Pool | Origin hostname | AKS public IP | Porter cluster | Monitor | Active in steering |
| --- | --- | --- | --- | --- | --- |
| `uscentral` | `uscentralapi.mentraglass.com` | 128.203.164.18 | mentra-cluster-central-us (4689) | yes (`/health`, 60s) | yes |
| `france` | `franceapi.mentraglass.com` | 172.189.45.70 | france (4696) | yes (`/health`, 60s) | yes |
| `asiaeast` | `asiaeastapi.mentraglass.com` | 20.6.155.16 | east-asia (4754) | yes (`/health`, 60s) | yes |
| `us-west` | `uswestapi.mentraglass.com` | 4.155.178.137 | us-west (4965) | yes (`/health`, 60s) | yes (default pool list) |
| `us-east` | `useastapi.mentraglass.com` | 4.157.182.57 | us-east (4977) | none | no (orphaned) |

### Region steering

Cloudflare's `geo` steering maps each Cloudflare region code to
a pool list. The first healthy pool in the list wins.

| CF region | Covers | Pool used |
| --- | --- | --- |
| `WNAM` | West North America | `uscentral` |
| `ENAM` | East North America | `uscentral` |
| `NSAM` | North South America | `uscentral` |
| `SSAM` | South South America | `uscentral` |
| `WEU` | West Europe | `france` |
| `EEU` | East Europe | `france` |
| `OC` | Oceania | `asiaeast` |
| `ME` | Middle East | `asiaeast` |
| (other) | Africa, Asia (non-ME) | `asiaeast` (fallback) |

The default pool list (used when geo lookup is ambiguous) is
`uscentral, france, asiaeast`, in that order.

### Monitors

All four active pools share the same monitor shape:

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

## Porter clusters not in the LB

Two clusters run `cloud-prod` but are not in the load balancer
rotation. Their `cloud-prod` apps only have an auto-generated
`*.onporter.run` hostname.

| Porter cluster | Cluster ID | Status |
| --- | --- | --- |
| canada-central | 4753 | Provisioned, no LB pool, no API hostname domains |
| australia-east | 4978 | Provisioned, no LB pool, no API hostname domains |

If you want one of these to take traffic from `api.mentra.glass`,
follow "Adding a new region" below; the work is the same as a
new cluster, except the cluster already exists.

## Adding a new region

End-to-end. Roughly: provision the AKS cluster in Porter,
deploy `cloud-prod` with regional domains, create a Cloudflare
pool + monitor + DNS record, plug the pool into the region
steering map.

### 1. Provision the AKS cluster in Porter

The Porter CLI does not create clusters. Use the dashboard:

1. Open https://dashboard.porter.run/
2. Project: `mentra` -> Add Cluster.
3. Pick Azure -> AKS -> the Azure region you want
   (e.g. South-East Asia, Brazil South, etc.).
4. Use the standard node SKU and node count we use elsewhere
   (verify against an existing cluster's settings).
5. Wait for provisioning (15-30 minutes).

Once it shows up:

```bash
porter cluster list
# new row appears with an ID, e.g. 5012 brazil-south
```

Note the cluster ID; you will pass it as `--cluster <ID>` for
the rest of this procedure.

### 2. Deploy `cloud-prod` to the new cluster

The repo has a single `cloud/porter.yaml` that is shared across
clusters at deploy time. Per-cluster differences (regional
domain names, env groups) live in the deployment target's
overrides on Porter, not as separate yaml files in the repo.

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
the regional domains to the `domains:` list:

```yaml
domains:
  - name: api.mentra.glass            # shared LB hostname
  - name: api.mentraglass.com         # legacy, mirrors api.mentra.glass
  - name: <region>api.mentra.glass    # new
  - name: <region>api.mentraglass.com # new
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

### 5. Plug the pool into region steering

Patch the load balancer to add the new pool to the right
region(s):

```bash
LB_ID=0d6e09e5427a8b94d3ce47f58496e1b8
ZONE=5bb5c71a90dc175143eb10edaad85d49

# First fetch current state to copy region_pools and edit
curl -s "https://api.cloudflare.com/client/v4/zones/$ZONE/load_balancers/$LB_ID" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -m json.tool > /tmp/lb.json

# Edit /tmp/lb.json: add <POOL_ID> to whichever region keys
# should route to it. e.g. for a Brazil cluster, add to NSAM/SSAM:
#   "NSAM": ["<POOL_ID>", "<existing-uscentral-pool-id>"]
# Order matters: the first healthy pool wins.

# PATCH the LB
curl -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE/load_balancers/$LB_ID" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/lb.json
```

### 6. Verify end to end

```bash
# Pool reports healthy
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools/<POOL_ID>" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['result']['healthy'])"
# expect: True

# A user in the new region resolves api.mentra.glass through the
# new pool. Easiest check: from inside the new region's network,
# or via a VPN, hit:
curl -s https://api.mentra.glass/health
# Then look at bstack logs to confirm the new region served the
# request:
bstack logs --region <new-region-slug>
```

### 7. Update the doc

Re-run the verification commands at the bottom of this doc,
update the tables in this file with the new pool, region steering
row, and Porter cluster.

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

To re-enable, set `enabled` back to `true`.

### Disable a single origin in a pool

Same shape as drain, but at the origin level. Useful when a
pool has multiple clusters and you want to take one out:

```bash
# Fetch, edit origins[i].enabled = false, PUT back
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/load_balancers/pools/<POOL_ID>" \
  -H "Authorization: Bearer $CF_TOKEN" > /tmp/pool.json
# edit
curl -X PUT "..." -d @/tmp/pool.json
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
ZONE=5bb5c71a90dc175143eb10edaad85d49
LB_ID=0d6e09e5427a8b94d3ce47f58496e1b8

# Full LB config
curl -s "https://api.cloudflare.com/client/v4/zones/$ZONE/load_balancers/$LB_ID" \
  -H "Authorization: Bearer $CF_TOKEN" | python3 -m json.tool

# All pools
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
