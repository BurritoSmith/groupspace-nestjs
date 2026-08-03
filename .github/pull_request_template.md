<!--
Branch prefix decides the version bump and the CHANGELOG section this lands in:

  feature/  -> minor, Added        fix/  -> patch, Fixed        perf/ chore/  -> patch, Changed

The CHANGELOG is generated from commit subjects at deploy time, so write them as the line you
would want a reader to see. See docs/versioning.md.
-->

## What and why

<!-- The problem, then the change. If it fixes a bug, say how it happened, not just where. -->

## Verification

<!-- Commands run and their result. For behaviour that a test can hold, name the test. -->

- [ ] `npx tsc --noEmit`
- [ ] `npm test`
- [ ] `npx nest build`
- [ ] Any new migration has been applied locally with `npx prisma migrate deploy`, not just added
- [ ] Any change to the socket contract is mirrored in the web client
