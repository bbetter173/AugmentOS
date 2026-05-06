# Porter Environment Variables

Porter pods get their environment from two places:

1. **Static env in `porter.yaml`**: literal values, mostly
   non-sensitive config like `LOG_LEVEL`, `HOST`, `SERVICE_NAME`,
   `RTMP_RELAY_URLS`. Visible in the repo.
2. **Doppler-injected at startup**: secrets (API keys, DB
   passwords, JWT secrets, etc.). The pod's `run` command starts
   with `doppler run --` which loads them at process boot. See
   `../doppler/porter-integration.md` for how this works.

Anything secret belongs in Doppler. Anything that would be safe
to commit goes in `porter.yaml`.

## Static env in porter.yaml

Find the `env:` block under each service in
`cloud/porter*.yaml`:

```yaml
services:
  - name: cloud
    type: web
    env:
      HOST: "0.0.0.0"
      SERVICE_NAME: "cloud"
      LOG_LEVEL: "info"
      LOG_STDOUT_JSON: "true"
```

To change one of these:

1. Edit the YAML.
2. Open a PR, merge to the watched branch.
3. Porter rebuilds and rolls. New pods get the new value; old
   pods keep the old value until they are replaced.

A static env change without a code change still requires a
rebuild. Pushing the YAML edit alone is enough; Porter detects
the change.

## Doppler-injected secrets

The regional Porter apps run with:

```yaml
run: doppler run -- bun run start
```

`doppler run` reads a Doppler service-account token from a
Porter-side secret called `DOPPLER_TOKEN`, fetches the secrets
for the configured project + config, exports them as env vars,
and then execs the rest of the command. The Bun process sees
the secrets as ordinary `process.env` values.

To change a secret, you change it in Doppler, not in
`porter.yaml`. The pod picks up the new value the next time it
starts (rolling restart, redeploy, or autoscaling event).

See `../doppler/adding-secrets.md` for the full procedure.

## Forcing pods to pick up a new secret

Doppler updates do not flow into a running pod. The pod read its
env at process start. To roll the pods so they pick up the new
value:

- **Dashboard**: open the app, click "Restart" or trigger a
  rebuild.
- **CLI**: `porter app restart <APP_NAME> --cluster <CLUSTER_ID>`
  (verify with `porter app --help`; the CLI command set evolves).

A restart is faster than a rebuild because it does not rebuild
the image. Use restart for env/secret changes; use rebuild for
code changes.

## Adding a new env var

For non-secrets:

1. Add to the `env:` block in every relevant `porter*.yaml`.
2. Reference it in code (`process.env.FOO`).
3. Open a PR with both changes together.
4. Merge, Porter rebuilds.

For secrets:

1. Add it to Doppler in each environment that needs it (dev,
   staging, prod, plus per-region prod configs). See
   `../doppler/adding-secrets.md`.
2. Reference it in code (`process.env.FOO`).
3. Open a PR with the code change.
4. Merge, Porter rebuilds. The new secret is loaded on first
   start of each new pod.

If the new secret is required (the process exits when missing),
add it to Doppler before merging the code. Otherwise the new
pods will crashloop until the secret is in place.

## Reading what is currently set

You cannot directly read a running pod's env from the dashboard
without exec-ing into it. Two practical paths:

- **Doppler dashboard / CLI** for secrets:
  `doppler secrets --project <project> --config <config>`
- **Repo** for static values: grep `cloud/porter*.yaml`.

For an exhaustive view, exec into a pod (only when needed):

```bash
porter kubectl --cluster <CLUSTER_ID> -- exec -it -n default \
  <POD_NAME> -- env | sort
```

This prints everything: static + Doppler + Kubernetes-injected.
Use sparingly; pods are production traffic.

## Common mistakes

- **Editing one regional `porter*.yaml` and forgetting the
  others.** Multi-region apps need parallel changes. A grep for
  the var name across `cloud/porter*.yaml` catches this.
- **Putting a secret in `porter.yaml`.** It ends up in git and
  the pod env. Move to Doppler, rotate the value, force-push the
  removal if the leak just happened (and rotate the secret
  externally).
- **Forgetting to restart.** Doppler change without restart means
  pods keep the old value until something else triggers a roll.
- **Mismatched config names across regions.** Each region maps
  to a different Doppler config (`prod_central-us`,
  `prod_us-east`, etc.). Adding a secret to one config does not
  add it to the others. See `../doppler/`.
