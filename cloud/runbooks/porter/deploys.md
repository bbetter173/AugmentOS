# Deploying to Porter

Each Porter app has a `porter.yaml` (or `porter-<region>.yaml`)
in the repo. Porter watches the linked branch on GitHub. When
that branch advances, Porter builds the Docker image (using the
Dockerfile referenced in the YAML), pushes it, and rolls the
deployment.

## Quick reference

| App | Watches branch | Config file |
| --- | --- | --- |
| `cloud-prod` (central US) | `main` | `cloud/porter.yaml` |
| `cloud-prod-us-east` | `main` | `cloud/porter-us-east.yaml` |
| `cloud-prod-us-west` | `main` | `cloud/porter-us-west.yaml` |
| `cloud-stress` | `dev` (typically) | `cloud/porter-stress.yaml` |

Confirm the branch each app watches in the Porter dashboard
under Settings -> Source. The branch can change; this table is a
starting point, not authoritative.

## Triggering a deploy

### Push the branch

The normal path. Merge to the watched branch and Porter starts a
build automatically.

```bash
# Stable production: merge through main
git checkout main
git pull
git merge --ff-only origin/dev   # or open a PR, merge via GitHub
git push origin main
```

Porter will pick up the push within ~30s, build, and start the
rollout.

### Manual rebuild

If the branch has not changed but you want to rebuild (e.g. base
image security update, env var change that requires a restart),
trigger from the dashboard:

1. Open the app in https://dashboard.porter.run/
2. Click the Deploy or Rebuild button (top right of the app page)

There is no `porter deploy` CLI command for our setup.

## Watching a deploy

```bash
porter app list --cluster <CLUSTER_ID>
porter app status <APP_NAME> --cluster <CLUSTER_ID>
```

Or in the dashboard: open the app, watch the Activity tab. New
pods start in `ContainerCreating`, transition to `Running`, then
to `Ready` once the readiness probe passes. Old pods are
terminated only after new ones are Ready (rolling deploy).

Tail the build logs:

```bash
porter app logs <APP_NAME> --cluster <CLUSTER_ID> --build
```

## Rolling deploy mechanics

Porter uses a Kubernetes rolling deploy by default:

1. New pod is created with the new image.
2. Liveness probe (`/livez`) and readiness probe (`/health`) run.
3. Only when readiness passes does the new pod start receiving
   traffic from the load balancer.
4. Once the new pod is Ready, an old pod is killed.
5. Repeat until all pods are on the new version.

A failing readiness probe means the new pod is alive but is not
yet receiving REST traffic. Existing WebSocket connections on
old pods stay alive until those pods are killed.

Probe details and the readiness-failure cascade are documented
in `../infra.md`.

## Rollback

Porter keeps prior revisions. To roll back:

1. Open the app in the dashboard.
2. Activity tab -> find the previous successful deploy.
3. Click the three-dot menu -> "Rollback to this version".

CLI equivalent (verify the exact subcommand against
`porter app --help` because the CLI evolves):

```bash
porter app revisions <APP_NAME> --cluster <CLUSTER_ID>
porter app rollback <APP_NAME> <REVISION_ID> --cluster <CLUSTER_ID>
```

If a rollback is urgent and the dashboard is slow, the fastest
recovery is to revert the offending commit on the watched branch
and push. The next deploy uses the reverted code.

## Multi-region coordination

Production runs in three regions (central, east, west). Each
watches `main` independently. A merge to `main` triggers all
three rolling deploys roughly in parallel. They are not
synchronized; one region can be rolling while another is already
done.

If you ship a change that depends on cross-region coordination
(rare), pause the regions you are not actively deploying via the
Porter dashboard before merging.

## Common failures

- **Build fails**: check `porter app logs --build`. Usually a
  Dockerfile issue, a dependency that did not install, or a TS
  compile error.
- **Pod crashloops**: see
  `cloud/tools/bstack/runbooks/pod-crash.md` for diagnostic
  steps. Common causes are bad env vars and missing secrets.
- **Pod stuck in `ContainerCreating`**: usually a node pressure
  issue (no available capacity). Check
  `porter kubectl --cluster <ID> -- get nodes`.
- **Readiness probe failing**: the pod is alive but `/health`
  returns non-200 or times out. Check the pod's logs for what
  happened during startup.

## After a deploy

- Watch BetterStack for ~10 minutes. The `bstack health` command
  is the fastest single-command sanity check.
- If the change touches the wire protocol or DB schema, also
  check `bstack incidents --limit 10` for new errors.
