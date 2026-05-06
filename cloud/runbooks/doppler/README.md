# Doppler

Doppler is our secrets manager. Every secret used by the cloud
or by team tooling lives here. Production pods load secrets from
Doppler at process startup; the `bstack` CLI loads its
credentials the same way.

We do not check secrets into the repo. We do not put secrets in
`porter.yaml`. They live in Doppler.

## Projects

| Project | What it holds | Who uses it |
| --- | --- | --- |
| `mentraos-cloud` | Production cloud secrets, per region | Porter pods |
| `mentra-sre` | SRE tooling credentials (BetterStack, admin JWTs) | `bstack` CLI, runbooks |

If a third project shows up later, document it here.

Each project has multiple "configs" (think environments). For
`mentraos-cloud` we have a config per region:
`prod_central-us`, `prod_us-east`, `prod_us-west`, `prod_france`,
`prod_east-asia`. For `mentra-sre` the configs are typically
`dev`, `staging`, `prod`.

## Access

You need a Doppler account that has been added to the relevant
project. Ask Isaiah or Israelov.

- Web: https://dashboard.doppler.com/
- CLI: `brew install dopplerhq/cli/doppler` then `doppler login`.

Verify access:

```bash
doppler projects                           # lists projects you can see
doppler secrets --project mentra-sre --config dev
```

If you cannot see a project, you have not been added.

## Procedures

- `daily-use.md`: log in, switch projects, read and run with
  secrets locally.
- `adding-secrets.md`: add a new secret, sync across configs.
- `porter-integration.md`: how Doppler injects into Porter pods.

## Related

- `../porter/env-vars.md`: what is static in `porter.yaml` vs
  what comes from Doppler.
- `../betterstack/bstack-cli.md`: the bstack CLI loads its
  credentials from Doppler.
