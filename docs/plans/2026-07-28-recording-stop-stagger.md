# Stagger recording stops, not just starts; trim the stagger delay

## Context

Yesterday's CPU-starvation fix (`fix/recording-cpu-starvation`, deployed today) staggered concurrent recording *starts* per room via `enqueueStart()`/`state.startQueue`, but left `teardownRoom()` finalizing every open session concurrently via `Promise.all`. Confirmed live in room "afcu", session "Checking" (queried directly from the recordings DB after deploying the start-side fix): starts were correctly staggered ~2.3s apart, but stopping the session sent all three ffmpeg processes their graceful-quit signal in the same instant — mic and one screen share finalized fine, the second screen share didn't exit within the 5s SIGKILL grace period, got killed, and came out corrupted (`hasContent: false`). Same underlying CPU-contention problem, just at the other end of the recording's lifecycle.

Also trimmed `START_STAGGER_MS` (2000ms) down to 500ms, renamed to `RECORDING_STAGGER_MS` and shared between starts and stops — 2s was a conservative, unmeasured guess; 500ms is still a judgment call (no live-load-testing setup to nail an exact floor), so it may need bumping back up if staggered stops still fail on the real VM.

## Backend (`spaces-nestjs-api-claude`) — the only repo touched by this branch

### `src/room/interfaces/recording.interfaces.ts`
- `IRoomRecordingState` gains `stopQueue: Promise<void>`, mirroring `startQueue`.

### `src/room/recording.service.ts`
- `START_STAGGER_MS` (2000) → `RECORDING_STAGGER_MS` (500), shared by both queues.
- New `enqueueStop(state, run)`, identical shape to `enqueueStart()` — serializes `finalizeVideoSession()` calls per room with the same settle pause.
- `notifyProducerClosing()` and `teardownRoom()` both route their finalize calls through `enqueueStop()` instead of calling `finalizeVideoSession()` directly / via bare `Promise.all`.
- `start()`'s state constructor initializes `stopQueue: Promise.resolve()`.

### Tests (`src/room/recording.service.spec.ts`)
- New `enqueueStop` describe block mirroring the existing `enqueueStart` tests (staggers, rejection doesn't jam the queue) plus a `teardownRoom()`-specific test confirming it staggers multiple open sessions instead of finalizing them all at once.
- Existing `pendingFinalizations` tests updated for the extra promise-chain hop `enqueueStop()` introduces.
- Stagger-delay assertions in existing `enqueueStart` tests updated from 2000ms to 500ms.

## Verification
- `npm run build` && `npm test`.
- Deploy via the `workflow_dispatch` pipeline, then a manual re-test in room "afcu" with 2+ simultaneous screen shares (the exact scenario that failed) to confirm every stream now comes out with content.

## Workflow
Branch `fix/recording-stop-stagger` off `main`. Implement, test, commit, push, open a PR, and merge — deploy is triggered manually via the Actions "Run workflow" button, not by me.
