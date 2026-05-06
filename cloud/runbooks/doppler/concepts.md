# Doppler: Concepts and Prerequisites

Read this first if you are new to the stack. Operational
procedures live in `daily-use.md`, `adding-secrets.md`, and
`porter-integration.md`.

The summary: Doppler holds every secret used by the cloud and
by team tooling. Production pods load secrets from Doppler at
process startup. The CLI and the web UI are the two ways to
read or change them.

If terms below are unfamiliar, the rest of this doc explains
each one.

## Why we use a secrets manager at all

The simplest way to give a process its config is environment
variables. The simplest way to set them in production is in a
config file checked into the repo. That file ends up in git
history forever. Anyone who clones the repo gets the secrets.
If a single secret leaks, the only fix is to rotate every
secret and audit every consumer.

A secrets manager solves this by being the single source of
truth. The repo references secrets by name; the actual values
live in Doppler with access controls, audit logs, and the
ability to rotate without code changes. Pods authenticate to
Doppler with a service token at startup and pull the values
they need.

For our setup: the repo's `porter.yaml` files declare
non-secret env vars literally; secrets are pulled at runtime
via `doppler run --`.

## Project

A project is a top-level container in Doppler. Each project
has its own access controls and its own set of configs.

We have a handful of projects:

| Project | Purpose |
| --- | --- |
| `mentraos-cloud` | Production cloud secrets, per region |
| `mentra-sre` | SRE tooling secrets (BetterStack, Cloudflare LB token, admin JWTs) |
| `live-captions`, `mentra-notes`, `recorder` | Per-app secrets for those apps |

A project can hold any number of secrets. The same secret name
across projects is independent (e.g. `BETTERSTACK_SOURCE_TOKEN`
in `mentraos-cloud` is a different value from
`BETTERSTACK_SOURCE_TOKEN` in `mentra-sre`).

## Config

A config is one environment within a project. Think of configs
as the columns of a spreadsheet: same set of secret names,
different values per environment.

Within `mentraos-cloud` we have:

- `dev`
- `staging`
- `prod_central-us`, `prod_us-east`, `prod_us-west`,
  `prod_france`, `prod_east-asia` (per-region prod)

A config can also "branch" or "inherit" from another config:
`prod_us-east` may inherit common secrets from a parent and
override only what's region-specific. The Doppler UI shows the
inheritance chain.

When you run `doppler run --config <name>`, you are picking
one column of the spreadsheet. The values exported as env vars
are the resolved values for that config (after inheritance).

## Secret name + value

A secret has a name (`MENTRAOS_API_KEY`, `MONGODB_URI`,
`BETTERSTACK_SOURCE_TOKEN`) and a value. Names follow
`UPPER_SNAKE_CASE`. Values are arbitrary strings, including
JSON blobs, certificates with newlines, etc.

The name is what the application reads from `process.env`. The
value is what it gets.

## Tokens

Doppler authenticates clients with tokens. Two kinds matter:

### Personal token

Tied to a Doppler user (you). Created by `doppler login`. Used
by the CLI on your laptop. Has read access to whichever
projects + configs you have been granted via the team
dashboard.

### Service token

Tied to a project + config, not a user. Created in the Doppler
dashboard under a config's Tokens section. Has read access
to ONE config (or read+write if you grant it). Used by long-
running services like Porter pods.

Each Porter regional app has a service token scoped to the
matching config (e.g. `cloud-prod-us-west` reads from
`mentraos-cloud:prod_us-west`). The token is stored in Porter
as the env var `DOPPLER_TOKEN`. See `porter-integration.md`.

Service tokens are revocable. Rotating one means: generate a
new token, update the consumer (Porter), revoke the old token.

## `doppler run --`

The most common pattern. You wrap a command in
`doppler run --`:

```bash
doppler run --project mentra-sre --config dev -- bstack health
```

Doppler does this:

1. Authenticate with the personal token (from `doppler login`)
   or, in non-interactive contexts, a service token.
2. Pull the secrets for `mentra-sre:dev`.
3. Export them as environment variables.
4. `exec` the rest of the command (`bstack health`) with that
   env block.

The `--` separates Doppler's flags from the inner command's
flags. Without it, Doppler would interpret `bstack`'s flags
as its own.

The injected env exists only for the lifetime of that command.
Subsequent commands in the same shell do not inherit Doppler's
env.

## How Porter pods get secrets

Each regional Porter app's `porter.yaml` has a `run` line that
starts with `doppler run`:

```yaml
run: doppler run -- bun run start
```

At pod startup:

1. The container image has the Doppler CLI baked in.
2. The pod has a `DOPPLER_TOKEN` environment variable set by
   Porter (a Kubernetes secret). This is a service token
   scoped to the right project + config.
3. `doppler run --` reads `DOPPLER_TOKEN`, fetches secrets,
   exports them, then `exec`s `bun run start`.
4. The Bun process sees the secrets as ordinary `process.env`
   values.

Doppler updates do not flow into a running pod. The pod read
its env at process start. To pick up a new value: restart the
pod (Porter dashboard or `porter app restart`).

## Web UI vs CLI

Both work. Use whichever fits the task:

- **Web UI** (https://dashboard.doppler.com/): browse,
  diff configs, manage tokens, audit logs. Best for
  exploration and managing access.
- **CLI** (`doppler`): scriptable, fast for repeated tasks,
  used in `doppler run` injection. Best for daily use.

You can use both interchangeably; changes in either show up
immediately in the other.

## Common day-to-day commands

```bash
doppler login                                       # one-time
doppler whoami                                      # confirm logged in
doppler projects                                    # list visible projects
doppler secrets --project foo --config bar          # list secrets
doppler secrets get FOO --plain                     # one value
doppler run --project foo --config bar -- cmd       # inject + exec
```

`daily-use.md` has the full set.

## What this means for the cloud

The cloud's process loads secrets at startup via
`doppler run`. Code reads `process.env.FOO`. Nothing in the
repo references the actual secret values; everything is by
name. Secrets are added or rotated in Doppler; pods restart to
pick them up.

Anything tempted to live in `porter.yaml` because it is "just
a config" should be checked: if it would be embarrassing in a
public repo, it is a secret. Put it in Doppler.
