# Self-service deploy pipeline (manual button, both repos)

## Context

Deploys to the GCP dev environment had been done by hand. Wanted a pipeline triggerable without that dependency — explicitly **not** auto-triggered by merging to `main` yet, just a manual button. See the companion PR/doc in `spaces-angular-claude` for the full context and GCP-side setup shared across both repos.

## Approach

GitHub Actions, `workflow_dispatch`-only (`.github/workflows/deploy.yml`), authenticating to GCP via Workload Identity Federation. Steps: checkout → `npm ci` → `npm test` → WIF auth → tar the checkout (no `.git`/`node_modules` — the VM's own Docker build does its own `npm ci`; `.env`/`recordings/` on the VM are real secrets/data never present in this checkout to begin with, so they can't be clobbered) → `gcloud compute scp` to `spaces-vm` → `gcloud compute ssh` to extract over `~/spaces-backend` and `docker compose up -d --build` → log/status check → curl health check against `https://35-238-110-160.sslip.io/`.

## One-time GCP setup (already done, shared with the frontend repo)

Service account `github-deployer@groupspace-tv.iam.gserviceaccount.com`, Workload Identity Pool `github-actions` + provider `github-actions-provider` (attribute-conditioned to just these two `BurritoSmith` repos), impersonation binding per repo. Backend SSH access uses `roles/compute.instanceAdmin.v1` (the same legacy metadata-key mechanism personal `gcloud compute ssh` access already relies on) — OS Login was tried first and reverted, since it broke personal SSH access too (the GCP project isn't attached to a Cloud Identity org, so the external-user role OS Login would've needed isn't grantable here).

## Workflow

Branch `feature/deploy-pipeline` off `main`. New file only, no app code touched. PR opened but **not auto-merged** — held for explicit approval since this introduces new IAM/cloud-credential plumbing.
