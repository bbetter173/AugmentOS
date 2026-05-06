# Doppler + Porter Integration

How secrets flow from Doppler into Porter pods at runtime.

## The flow

1. A Doppler **service-account token** is stored in Porter as a
   Kubernetes secret named `DOPPLER_TOKEN` (set in the Porter
   dashboard, not in `porter.yaml`).
2. The pod's `run` command starts with `doppler run --`. For
   example, `cloud/porter-us-west.yaml` has:
   ```yaml
   run: doppler run -- bun run start
   ```
3. At process start, `doppler run` uses `DOPPLER_TOKEN` to fetch
   the secrets for the project + config that token is scoped to.
4. The secrets are exported as environment variables in the
   process's env block.
5. `bun run start` is then exec'd. The Bun process sees the
   secrets as ordinary `process.env` values.

This means:

- Code reads secrets via `process.env.FOO`, the same as any
  local dev script that ran with `doppler run --`.
- A secret update in Doppler does not affect a running pod.
  Pods load secrets at process start, not on demand.

## Service-account tokens

Each region's pods have a Doppler service-account token scoped
to one project + one config. Examples:

| Porter app | Doppler project | Doppler config |
| --- | --- | --- |
| `cloud-prod-us-west` | `mentraos-cloud` | `prod_us-west` |
| `cloud-prod-us-east` | `mentraos-cloud` | `prod_us-east` |
| `cloud-prod` (central) | `mentraos-cloud` | `prod_central-us` |
| `cloud-stress` | `mentraos-cloud` | dedicated stress config (verify in dashboard) |

Verify the actual token-to-config mapping in the Doppler
dashboard under Tokens. The mapping above is the intended state;
the dashboard is the source of truth.

## Where the token lives

In Porter, not in the repo. The token is a Kubernetes secret in
the Porter cluster, referenced as the env var `DOPPLER_TOKEN`
in the pod's runtime environment.

To set or rotate it:

1. Generate a new service token in Doppler:
   Doppler dashboard -> Project -> Config -> Tokens ->
   Generate Service Token.
2. Copy the token value (you only get it once).
3. In Porter, open the app -> Settings -> Environment.
4. Set or update `DOPPLER_TOKEN` to the new value. Mark it as
   secret.
5. Restart the pods (Porter dashboard -> Restart).
6. Verify the pods come up healthy. If they crashloop with
   "doppler: invalid token", roll back to the previous token.
7. Revoke the old token in Doppler.

## What the central config does differently

`cloud/porter.yaml` (central US) uses:

```yaml
run: ./start.sh
```

instead of `doppler run -- ...`. That is because the central
deployment's `start.sh` does its own secret loading (verify in
the script). Either path is fine; they accomplish the same thing.

If you stand up a new region from scratch, follow the
us-east / us-west pattern (`run: doppler run -- bun run start`).
It is the simpler of the two and matches what we recommend
going forward.

## Local dev parity

For local dev that needs the same secrets prod has, run:

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

## Common failures

- **Pod fails to start with "doppler: token not found"**: the
  `DOPPLER_TOKEN` env var is missing in Porter. Re-add it, then
  restart.
- **Pod fails with "doppler: invalid token"**: the token was
  revoked or rotated without updating Porter. Generate a new
  token, update Porter, restart.
- **Pod starts but a required env var is missing**: the
  Doppler config does not have that secret. Add it
  (`adding-secrets.md`), then restart.
- **One region works, another does not**: per-region configs
  drifted. See the cross-config drift check in
  `adding-secrets.md`.

## Auditing

Quarterly:

- [ ] List all service tokens in each Doppler project
      (Dashboard -> Project -> Access -> Tokens). Anything that
      does not map to a current Porter app or tool should be
      revoked.
- [ ] Verify each Porter app's `DOPPLER_TOKEN` is scoped to the
      right config (no central-US token wired into a us-east
      pod, etc.).
- [ ] Cross-check secrets across regional configs for drift.
