# Hung Pham DevOps Take-Home — Stage 2: CI Pipeline

## 0. Pre-Assessment Questionnaire

1. **Which CI platform do you know best?**
   GitHub Actions — used in this exercise and in previous projects.

2. **Which cloud provider are you most fluent in?**
   No cloud provider was used in this exercise. Everything runs on the free GitHub Actions ubuntu-latest runner with kind creating a local Kubernetes cluster inside the VM.

3. **Which IaC tooling do you prefer?**
   Helm for Kubernetes workloads — used here to deploy PostgreSQL and Redis via Bitnami charts. For infrastructure provisioning I prefer plain scripts or Terraform depending on the scope.

4. **Have you used any zero-trust or private-access tools before?**
   Not used in this exercise. I have experience with bastion host setups and am familiar with Tailscale and Cloudflare Tunnel concepts.

5. **Which scripting language are you most comfortable in?**
   Node.js for the integration test CLI; Bash for pipeline glue steps in the workflow.

6. **Will you be using AI coding agents for this exercise?**
   Yes — Claude Code (Claude Sonnet 4.6) for scaffolding and iteration. All design decisions and debugging were done by me; the agent accelerated the typing.

---

## 1. Architecture Overview

```
Push / PR / workflow_dispatch
         │
         ▼
┌─────────────────┐
│   pre-check     │  Hadolint (Dockerfile) + node --check (JS syntax)
│   (no infra)    │  Fails fast before any cloud/cluster cost
└────────┬────────┘
         │ needs: pre-check
         ▼
┌─────────────────┐
│     build       │  Docker Buildx → image.tar.gz artifact
│  (GHA cache)    │  Layer cache: npm ci reused when package*.json unchanged
└────────┬────────┘
         │ needs: build
         ▼
┌──────────────────────────────────────────────────────┐
│              integration-test                         │
│                                                       │
│  1. kind create cluster (fresh every run)             │
│  2. helm install postgres + redis (bitnami charts)    │
│  3. kubectl port-forward → runner localhost           │
│  4. docker run --network host → integration test CLI  │
│  5. Upload test-results.log artifact                  │
│  6. kind delete cluster  ← if: always()               │
└──────────────────────────────────────────────────────┘
```

---

## 2. Key Decisions

### kind over k3d / minikube
kind runs entirely inside Docker (no daemon or VM), which is the simplest setup on GitHub
Actions ubuntu-latest runners. It starts in ~60 s, needs no special kernel modules, and
`kind delete cluster` is instant and complete — no leftover processes.

### Port-forward to runner + `docker run --network host`
The alternative would be loading the test image into the cluster and running it as a pod.
Port-forwarding is simpler: no `imagePullPolicy`, no pod YAML, and the Docker container runs
with the same image that was built and uploaded as the artifact, so the artifact IS what was
tested. `--network host` lets the container reach `localhost:5432` and `localhost:6379`
without any extra bridge configuration.

### `--set primary.persistence.enabled=false` on PostgreSQL
Disables the PVC, which removes ~30 s of StorageClass provisioning from the helm install.
Data survives for the duration of the test (in the pod's ephemeral storage) and we throw the
cluster away anyway, so there is no downside.

### `workflow_dispatch` with `force_fail` input for the deliberate-failure run
A boolean workflow input is the cleanest trigger: no broken branch required, reproducible on
demand, and self-documenting. The test CLI checks `FORCE_FAIL=true` and exits 1 immediately,
proving that the `if: always()` teardown step executes even when the workload fails.

---

## 3. Caching

| What | Mechanism | Rationale |
|------|-----------|-----------|
| Docker image layers | `cache-from/cache-to: type=gha` in `build-push-action` | `npm ci` is skipped on cache hit when `package*.json` is unchanged — the biggest per-run saving. |
| **Not cached** | `kind` and `helm` binaries | Both come pre-installed on `ubuntu-latest` runners; downloading and caching them would add steps with no benefit. |
| **Not cached** | Bitnami Helm chart index + tarballs | Kept fresh so we always pull the latest patch of the pinned chart series. The download is small (<5 s) and staleness risk isn't worth it. |
| **Not cached** | The kind cluster itself | Fresh cluster per run is the core requirement (R3). Cannot and should not be cached. |

---

## 4. Test Evidence

The integration test CLI prints one line per assertion:

```
PostgreSQL: wrote and read back "hello-postgres" (id=1)
Redis: wrote and read back "hello-redis"
All integration tests passed.
```

This output (stdout + stderr merged) is captured into `test-results.log` via `tee` and
uploaded as a GitHub Actions artifact named **test-results** on every run, including failing
ones. The exit code of the `docker run` command is preserved through the pipe via
`${PIPESTATUS[0]}` so that a non-zero exit propagates correctly to the job.

---

## 5. How to Trigger a Failing Run

1. Go to **Actions → CI Pipeline → Run workflow**
2. Set **Force integration test failure** to `true`
3. Click **Run workflow**

The `pre-check` and `build` jobs will pass normally. The `integration-test` job will:
- Create the kind cluster
- Deploy PostgreSQL and Redis
- Start the test container, which exits 1 immediately (`FORCE_FAIL=true`)
- Upload `test-results.log` containing the failure message
- Run `kind delete cluster` and print `==> Cluster destroyed` (teardown confirmed)

The job is marked red; the teardown step is marked green.

---

## 6. Setup Instructions

```bash
# Clone the repo
git clone https://github.com/phamsyhung2110/hungpham_test_r2.git
cd hungpham_test_r2

# Push to GitHub — the pipeline triggers automatically on every push
git push origin main
```

No secrets, credentials, or environment variables need to be configured. Everything runs
on the free GitHub Actions ubuntu-latest runner.

To run the integration test locally (requires Docker, kind, kubectl, helm):

```bash
# Build image
docker build -t integration-test:local .

# Create cluster and deploy deps
kind create cluster --name local-test --config k8s/kind-config.yaml --wait 60s
helm repo add bitnami https://charts.bitnami.com/bitnami && helm repo update
helm install postgres bitnami/postgresql \
  --set auth.postgresPassword=testpass \
  --set auth.database=testdb \
  --set primary.persistence.enabled=false \
  --wait --timeout 5m
helm install redis bitnami/redis \
  --set auth.enabled=false \
  --set master.persistence.enabled=false \
  --wait --timeout 3m

# Port-forward and run test
kubectl port-forward svc/postgres-postgresql 5432:5432 &
kubectl port-forward svc/redis-master 6379:6379 &
sleep 5
docker run --rm --network host \
  -e PGHOST=localhost -e PGPASSWORD=testpass -e PGDATABASE=testdb \
  -e REDIS_HOST=localhost \
  integration-test:local

# Cleanup
kind delete cluster --name local-test
```

---

## 7. Trade-offs & Assumptions

- **No image registry push**: The built image is uploaded as a GitHub Actions artifact
  (`image.tar.gz`). The assessment permits this and it avoids needing registry credentials.
- **Single-node kind cluster**: Sufficient for running two Helm charts for an integration test.
  A multi-node setup would add startup time with no benefit here.
- **No Helm chart version pinning**: The `bitnami/postgresql` and `bitnami/redis` charts are
  installed at their current latest within the `^` range. For production use, versions would
  be pinned in a `Chart.lock` or explicit `--version` flag.
- **PGUSER=postgres**: Using the superuser for the test is fine for ephemeral CI databases.
- **Port-forward reliability**: `kubectl port-forward` is not production-grade but is the
  standard approach for CI test access. The readiness loop (`until nc -z`) prevents the test
  from starting before the tunnel is up.

---

## 8. Time Log

| Duration | Activity |
|----------|----------|
| ~10 min | Pre-clock: GitHub repo creation, empty push (not counted in 4h cap) |
| ~15 min | `src/index.js` + `package.json` + `Dockerfile` + `k8s/kind-config.yaml` |
| ~20 min | `ci.yml` — 3-job pipeline + first push + fix kind conflict on runner |
| ~10 min | 3 CI runs: 2 passing + 1 force-fail `workflow_dispatch` |
| ~15 min | `README.md` |
| **~1h** | **Total engineering time** |
