# Versioning

The Converge backend follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html),
currently in `0.x`. **Every deploy moves the version** — that is the whole point of the scheme,
because a version that only sometimes changes cannot answer "what is running?".

## Two versions, not one

This repo and the [web client](https://github.com/BurritoSmith/groupspace-angular) deploy
independently, so they version independently. A tag maps to exactly one deployable commit in one
repo, which is the only arrangement where a version means "this exact code is live". A shared
"Converge X.Y.Z" would have to be bumped in both repos on every deploy of either, so one of the two
tags would routinely point at code that never shipped.

The two versions are therefore expected to differ, and that is not drift.

## What bumps what

While in `0.x`, a breaking change is a minor — that is what `0.x` means. Note that "breaking" here
means the **socket and REST contract the web client depends on**, not internal structure.

| Branch prefix | Bump | CHANGELOG section |
|---|---|---|
| `feature/` | minor | Added |
| `fix/` | patch | Fixed |
| `perf/`, `chore/` | patch | Changed |

`major` and `none` are also available. `none` re-deploys the current commit without moving the
version — for a rollback or an infrastructure-only rerun, where a new version number would be a lie.

## Cutting a release

Actions → **Deploy (development)** → Run workflow → pick a bump. In order, the workflow:

1. Checks out with `fetch-depth: 0`, because the changelog section is derived from the commit range
   since the previous tag.
2. Runs `scripts/bump-version.mjs`, which writes `package.json`, `package-lock.json`,
   `src/app-version.ts` and a new CHANGELOG section, then **commits and tags locally**.
3. Packages, ships and rebuilds the compose stack on the VM.
4. Health-checks, then asks `GET /version` whether the container that came up is actually this
   build.
5. **Only then**, pushes the commit and tag to `main` and creates a GitHub Release.

Two orderings are load-bearing:

- The bump commit must exist **before** `Package the commit`, which ships `git archive HEAD`. A
  bump made after it would never reach the VM.
- The push happens **last**, so a failed deploy leaves `main` untouched and no tag can ever point at
  code that did not ship.

## Where the version shows up

`GET /version` returns:

```json
{ "name": "converge-backend", "version": "0.27.1", "builtOn": "2026-08-03", "startedAt": "..." }
```

`startedAt` is when the process came up, which is what distinguishes "the deploy landed" from "the
container has been sitting there since before it" — a version string alone cannot tell those apart.

`GET /` is deliberately unchanged. Both repos' workflows health-check it and only care that it
returns 200, so version information lives at its own route rather than changing that body.

## History before this scheme

The first 56 releases predate any of this and were reconstructed from
`git log --first-parent --reverse`: one release per merged pull request, classified by the table
above, tagged with the date it actually landed. `v0.0.0` is the initial commit. The 13
direct-to-main commits from before the PR flow existed were classified by their subject's own verb.

The reconstruction script was a one-off and was never committed — `git tag` is additive and touches
no commit, so the backfill rewrote nothing.

Already-merged pull requests were **not** edited retroactively. The mapping from version to PR lives
in `CHANGELOG.md`, where every entry links its PR, and in the release for each tag.
