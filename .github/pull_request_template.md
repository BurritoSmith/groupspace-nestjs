<!--
Branch prefix decides the version bump and the CHANGELOG section this lands in:

  feature/  -> minor, Added        fix/  -> patch, Fixed        perf/ chore/  -> patch, Changed

The CHANGELOG is generated from commit subjects at deploy time, so write them as the line you
would want a reader to see. See docs/versioning.md.
-->

## What and why

<!-- The problem, then the change. If it fixes a bug, say how it happened, not just where. -->

## Verification

<!-- Commands run and their result. For behaviour that a test can hold, name the test; for
     behaviour that only a browser can show, say what to do by hand. -->

- [ ] `npx tsc --noEmit -p tsconfig.app.json`
- [ ] `npx ng test --watch=false`
- [ ] `npx ng build`
- [ ] Any new user-facing string is translated in **all nine** locale files
