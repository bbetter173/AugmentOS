# Doppler + Porter Integration

How secrets flow from Doppler into Porter pods. Production
relies on Porter's native Doppler integration, not on
`doppler run --` at process start. The two are easy to confuse
because both end with secrets in `process.env`; the difference
is who fetches them and when.

## The flow

1. A Porter project has a **Doppler integration** linked once,
   at the project level. Setup: Porter dashboard -> Integrations
   -> Doppler -> connect with a Doppler service account.
2. Each Porter app's environment is configured to pull from a
   specific Doppler project + config. For `cloud-prod` in
   central US that means `mentraos-cloud:prod_central-us`.
3. At deploy time, Porter calls Doppler with the integration's
   credentials, fetches the current secrets for that project +
   config, and writes them into the Kubernetes Secret backing
   the deployment. Porter also injects three metadata env vars
   on the pod so you can identify the source: `DOPPLER_PROJECT`,
   `DOPPLER_CONFIG`, `DOPPLER_ENVIRONMENT`.
4. The pod starts. Its env block already contains the secrets.
   The `run` command is just `./start.sh` (which is
   `cd packages/cloud && bun run start`); no Doppler CLI
   involved.
5. The Bun process reads `process.env.FOO` normally.

This means:

- Code reads secrets via `process.env.FOO`, same as a local dev
  script.
- A secret update in Doppler does not affect a running pod.
  Pods read env at process start. To pick up new values:
  redeploy or restart.
- There is no `DOPPLER_TOKEN` in the pod. The integration's
  auth happens entirely on Porter's side. The Doppler CLI is
  not in the container image.

## How to verify it for any region

```bash
porter app run cloud-prod --cluster <CLUSTER_ID> --target <TARGET> -- \
  sh -c 'env | grep -E "^DOPPLER_(PROJECT|CONFIG|ENVIRONMENT)"'
```

You should see something like:

```
DOPPLER_PROJECT=mentraos-cloud
DOPPLER_CONFIG=prod_central-us
DOPPLER_ENVIRONMENT=prod
```

If those vars are present, the Porter Doppler integration is
wired up and the pod has whatever secrets that config holds. If
they are missing, the app is reading env from somewhere else
(manually-typed Porter env vars, or a different mechanism);
investigate before assuming Doppler is in the picture.

## Per-app config mapping

Each Porter app maps to one Doppler config:

| Porter app + cluster | Doppler project | Doppler config |
| --- | --- | --- |
| `cloud-prod` / central (4689) | `mentraos-cloud` | `prod_central-us` |
| `cloud-prod` / us-east (4977) | `mentraos-cloud` | `prod_us-east` |
| `cloud-prod` / us-west (4965) | `mentraos-cloud` | `prod_us-west` |
| `cloud-prod` / france (4696) | `mentraos-cloud` | `prod_france` |
| `cloud-prod` / east-asia (4754) | `mentraos-cloud` | `prod_east-asia` |
| `cloud-staging` / central | `mentraos-cloud` | `staging` |
| `cloud-dev` / central | `mentraos-cloud` | `dev` |

Source of truth is the Porter dashboard (the integration's
"Linked Configs" view) plus the verification command above. The
table here can drift; if Porter and Doppler dashboards disagree
with this table, the dashboards win and the table needs
updating.

## Setting up the integration for a new app

1. In Porter, open the app -> Settings -> Environment ->
   "Sync from integration" -> Doppler.
2. Pick the project and config (e.g. `mentraos-cloud` /
   `prod_brazil-south` for a hypothetical new region).
3. Save. Porter will sync on the next deploy.
4. Trigger a redeploy (push to the watched branch, or use
   "Restart" in the dashboard).
5. Verify with the env-grep command above; the new
   `DOPPLER_PROJECT` / `DOPPLER_CONFIG` should match what you
   selected.

## Stale `porter-*.yaml` files in the repo

The repo contains `cloud/porter-us-west.yaml`,
`cloud/porter-us-east.yaml`, etc. Some of those files have
`run: doppler run -- bun run start` instead of `./start.sh`.
That is leftover from when we were considering the runtime-
injection pattern; it is not what Porter is actually running.

```bash
# What the regional yamls in the repo say (often stale)
grep "run:" cloud/porter*.yaml

# What Porter is actually deploying for each region
for tuple in "4689 default" "4977 us-east-default" \
             "4965 us-west-default" "4696 france-default" \
             "4754 east-asia-default"; do
  cid=$(echo "$tuple" | awk '{print $1}')
  tgt=$(echo "$tuple" | awk '{print $2}')
  rline=$(porter app yaml cloud-prod --cluster $cid --target $tgt 2>/dev/null \
    | grep "^  run:" | head -1)
  echo "cluster $cid ($tgt): $rline"
done
```

If you ever see those two outputs disagree, the deployed config
wins. The repo yamls drift because Porter holds its own state
once the app is deployed. Worth cleaning up the stale yamls so
they match deployed reality, but that is its own task.

## Local dev parity

For local dev that needs the same secrets prod has, use the
local-dev pattern with the Doppler CLI directly:

```bash
doppler run --project mentraos-cloud --config prod_central-us -- \
  bun src/index.ts
```

This gives your local Bun process the exact same env vars the
production pod has. Be cautious: this connects to production
resources (DB, third-party APIs).

For dev-config local runs:

```bash
doppler run --project mentraos-cloud --config dev -- \
  bun src/index.ts
```

`doppler run --` is for local processes. Production pods use
the Porter integration above.

## Common failures

- **Pod starts but a required env var is missing**: the Doppler
  config does not have that secret. Add it
  (`adding-secrets.md`), then redeploy.
- **One region works, another does not**: per-region configs
  drifted. See the cross-config drift check in
  `adding-secrets.md`.
- **Updates to a secret are not visible in the pod**: the pod
  loaded its env at process start. Restart the pod.
- **`DOPPLER_PROJECT` etc. missing from pod env**: the Porter
  integration is not wired up for this app. Set it via Porter
  dashboard -> Settings -> Environment -> Sync from integration.

## Auditing

Quarterly:

- [ ] In each Porter app's Settings -> Environment, confirm the
      "Sync from integration" Doppler config matches the
      intended one (no central-US config wired into a us-east
      pod, etc.).
- [ ] Verify each app's pod env has the expected
      `DOPPLER_PROJECT` / `DOPPLER_CONFIG` (the env-grep command
      above).
- [ ] Review service tokens / integration credentials in the
      Doppler dashboard. Anything not used by an active Porter
      integration or local-dev tool should be revoked.
- [ ] Cross-check secrets across regional configs for drift
      (`adding-secrets.md`).
