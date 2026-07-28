# Fix CPU-starvation empty recordings: cheaper encode preset, deprioritized non-live ffmpeg, throttled starts

## Context

The "hunch"/"hunchimus prime" incident (room `hunch`, 2026-07-27 22:16-22:17) produced two silently empty recordings (Clay's webcam and screen share, both `hasContent: false`). Root cause, confirmed via production Docker logs and DB rows: CPU starvation on the `e2-small` VM's 2 shared/burstable vCPUs when 3 recording ffmpeg processes (mic/webcam/screen) plus 2 live-thumbnail ffmpeg processes all launched within ~3 seconds of each other at session start — the webcam encoder fell thousands of RTP packets behind ("max delay reached", "missed N packets") and never wrote a usable frame. This was NOT the previously-fixed `pendingFinalizations` stop-time race (timestamps clearly separate the two: this failure happened at recording START, well before the stop sequence).

Three complementary mitigations, from cheapest/most-certain to most-structural:
1. Reduce per-encode CPU cost (`ultrafast` preset instead of `veryfast`).
2. Deprioritize non-time-critical ffmpeg work (remux/thumbnail) so it yields to live recording under contention.
3. Serialize/throttle recording starts per room so concurrent ffmpeg spawns don't pile up in the first place (this plan's new work — the other two were already implemented in the prior session).

A VM tier upgrade (`e2-small` → `e2-standard-2`, for dedicated non-burstable vCPUs) is being done separately as an infra action, not part of this branch.

## Backend (`spaces-nestjs-api-claude`) — the only repo touched by this branch

### `src/room/recording.service.ts`

- `buildRecordingFfmpegArgs()`: video `codecArgs` branch, `-preset veryfast` → `-preset ultrafast`.
- `runFfmpegToCompletion()`: spawns now call a new `deprioritize(proc, logLabel)` helper right after `spawn()`, which does `os.setPriority(proc.pid, 19)` in a try/catch (best-effort, non-fatal — logs at `debug` on failure). Never called for the live-RTP `spawnFfmpegAndWaitReady()` process, which must not be starved.
- New: `IRoomRecordingState.startQueue: Promise<void>` (mirrors the existing `pendingFinalizations: Set<Promise<void>>` field/pattern) — a per-room promise chain that serializes `startVideoSession()` calls. Initialized to `Promise.resolve()` in `start()`'s state constructor.
- New private `enqueueStart(state, run)` helper: chains `run` onto `state.startQueue`, holding a fixed stagger delay (`START_STAGGER_MS`, a top-of-file constant) after `run` settles before the chain admits the next queued start — so one producer's encoder gets a moment to stabilize before the next one spawns. A single start's rejection doesn't jam the queue for subsequent starts.
- Both call sites route through it:
  - `start()`'s per-producer loop (already sequential/awaited) — now `await this.enqueueStart(state, () => this.startVideoSession(...))`, adding the settle delay between iterations.
  - `notifyProducerCreated()` (fire-and-forget from the caller's perspective, confirmed as the actual source of concurrent spawns since each webcam/screen/mic negotiates its own independent `produce()` call) — now `void this.enqueueStart(state, () => this.startVideoSession(...)).catch(...)`, still non-blocking for the caller but now serialized against other starts in the same room.
- Scope: per-room only, matching `IRoomRecordingState`'s existing scope. Cross-room contention is addressed by the separate VM upgrade, not this queue.

### Tests (`src/room/recording.service.spec.ts`)
- Confirm the existing `buildRecordingFfmpegArgs` video-branch test still passes with `ultrafast` (it only asserts codec/movflags presence, not the specific preset).
- New test: two `notifyProducerCreated()` calls for the same room don't both invoke `startVideoSession`'s work concurrently — the second doesn't begin until the first's promise (plus stagger) resolves. Use fake timers for the stagger delay.

## Verification
- `npm run build` && `npm test`.
- Manual (after deploy + VM upgrade): start a session with several streams turning on close together, confirm staggered start logs and that all resulting files have content.

## Workflow
Branch `fix/recording-cpu-starvation` off `main`. Implement, test, commit locally. Do not push/PR/merge/deploy until explicitly asked.
