# Record the avatar tile as video when a participant's camera is off

Status: implemented. (See `spaces-angular-claude/docs/plans/2026-08-04-avatar-video-recording.md` for the identical plan/outcome — this change spans both repos.)

## Context

Recordings are audio-only for any participant who never turns their camera on — the playback page
synthesizes an avatar-image "tile" purely client-side at playback time (`participant-avatar-tile.ts`),
but nothing visual is ever actually recorded. The ask: whenever a participant's mic is on but their
camera is off, and the room is actively being recorded, synthesize a video of their avatar image and
record it muxed with their mic audio — so every recording has some visual.

Two decisions already made (confirmed with the user):
- **Recording-only.** The live call is completely unchanged for every other viewer — no new video
  tile appears for anyone during the call itself, only in the resulting recorded file.
- **Static avatar image**, not a speaking-reactive animation — a single rendered frame, not a
  continuously redrawn one.

This turns out to fit the mic+webcam combined-recording architecture already in place
(`RecordingService.startCombinedCameraSession`, `IRecordingProducerInfo.source: 'webcam'`) almost for
free: `RecordingService` already combines ANY `'webcam'`-source producer with a peer's mic into one
file — it has no idea (and doesn't need to know) whether that producer's frames come from a real
camera or a canvas. So the entire feature is a **frontend-only mediasoup producer whose track is a
canvas-drawn image instead of `getUserMedia()`**, published with a flag so remote peers' clients know
to ignore it for live rendering (the one piece that does need a small, mechanical backend passthrough).

**Also fixed alongside this (not part of the plan, a separate bug report from the same conversation):**
recorded files weren't reachable from the playback page at all (tested from Electron, a local browser,
and a phone on the LAN) — `RecordingService.publicBaseUrl()` hardcoded `http://localhost:${PORT}`
regardless of which host/protocol a client actually reached the server on, which broke outright once
local dev started terminating TLS (`DEV_HTTPS_CERT`/`DEV_HTTPS_KEY`) and was never going to work for a
LAN IP or Electron's separate origin anyway. Fixed by making `buildLocalFileUrl`/`buildLocalThumbnailUrl`
return root-relative paths (mirroring `ChatMediaService.publicBase`'s identical `/chat-media/`
convention) and having the frontend resolve them via the already-existing `resolveMediaUrl()` helper
(same one chat attachments use) in `playback-video-tile.ts`/`participant-avatar-tile.ts`.

## Design

### 1. New utility: canvas → `MediaStreamTrack` from the avatar picture

**New file** `spaces-angular-claude/src/app/room/services/avatar-video-track.ts` (+ `.spec.ts`),
mirroring the existing DI-wrapped-for-testability pattern (`PosterFrameGenerator` in `poster-frame.ts`)
and the image-loading style already used in `album-cover.ts`'s `loadImage()` (cross-origin `Image()`
load with a timeout guard, since avatar URLs are cross-origin Google profile pictures and an untainted
canvas is required for `captureStream()` to actually carry real pixel data).

`AvatarVideoTrackFactory.create(pictureUrl, displayName)` draws a fixed 640×360 frame once (dark
background, the avatar image cropped into a centered circle; falls back to a plain initial-on-a-circle
when there's no picture URL or the image fails to load, so the recording still gets *something*), then
calls `canvas.captureStream(1)` — 1 fps, not 0/on-demand, since the validation spike from the
mic+webcam combined-recording work already showed WebM/RTP is picky about sparse video, and 1 fps is
trivially cheap for a static image. Two `protected` seams for testability: `loadImage()` (mirrors
`PosterFrameGenerator`'s convention) and `captureTrack()` (needed because jsdom implements no
`captureStream()` at all, unlike `getContext()`, which tests can spy on directly). Never throws —
resolves `null` on any failure, same contract as `PosterFrameGenerator`.

### 2. `MediaRoom` — mechanics for producing/closing the avatar-video producer

**File:** `media-room.ts`. New `startAvatarVideoProducer(track)`/`stopAvatarVideoProducer()`, tracked
via a dedicated `avatarVideoProducerId` field — deliberately **never sharing a producerId with the
real webcam** (no replaceTrack/pause-resume between them). Single low-bitrate encoding, no simulcast
(nobody ever views this live), `appData: { source: 'webcam', synthetic: true }`.

### 3. Backend passthrough: a `synthetic` flag — `RecordingService` needs zero changes

`synthetic?: boolean` threaded through `IProducePayload`/`IProducerSummary` (backend) and
`IProducerSummaryPayload` (frontend) purely as a passthrough — the server has no opinion on it at all.
The frontend's `'new-producer'` handler gets one early-return: skip `consumeRemoteProducer()` entirely
when `summary.synthetic` is true. That one line is the entire "recording-only, not live-visible"
guarantee. `RecordingService` already combines any `'webcam'`-source producer with a peer's mic
regardless of why it exists, so it needed no changes at all.

### 4. Handing off between "real camera" and "avatar video" without fragmenting the recording

`Room.shouldShowAvatarVideo` computed (`isRecording() && isSessionJoined() && !isWebcamOn()`) plus a
single constructor `effect()` are the sole owner of the avatar producer's lifecycle, chained through a
serializing `avatarVideoTransition` promise so a rapid toggle can't start two overlapping producers.
Two companion changes in `media-room.ts` make the handoff work without ever creating two simultaneous
`'webcam'`-source producers or fragmenting the recorded file:

- `startWebcam()` closes an active avatar producer *before* its existing
  `findProducerEntryBySource('webcam')` lookup — otherwise that lookup would find the synthetic
  producer and `replaceTrack()` the real camera onto it, which never re-broadcasts `new-producer` (only
  a fresh `produce()` does), leaving remote peers stuck never learning the camera came on.
- `stopWebcam()` now closes (rather than pauses) the real producer specifically when
  `isRecording() && isSessionJoined()` — freeing the combined recording session's video slot so the
  reactive effect's subsequent `startAvatarVideoProducer()` call can attach into the SAME still-open
  file via `RecordingService`'s pre-existing (already-shipped) "attach a fresh webcam producer into a
  session whose video slot is empty" logic. Live viewers see no difference either way — both a pause
  and a close make `Room.videoFeeds` fall back to the avatar tile.

No other transition needs special-casing — recording stop/mic stop are plain `shouldShowAvatarVideo`
flips the same effect already handles.

## Outcome

Implemented exactly as planned — no design deviations. Notes from implementation:

- `enableAvatarVideo()` (the effect's async half, in `room.ts`) re-checks `shouldShowAvatarVideo()`
  after the (possibly slow) image load completes, discarding the freshly-created track instead of
  publishing it if the condition flipped back off while loading (e.g. the real camera came on
  mid-load) — covered by its own test.
- `create()`'s `await this.loadImage(...)` is additionally wrapped in `.catch(() => null)` even though
  `loadImage()`'s own contract already never rejects — cheap belt-and-suspenders for the class's own
  stated "never throws" contract.
- Backend (336 tests) and frontend (1828 tests) full suites pass; `npx tsc --noEmit` clean on both.
- **Not verified in this environment** (needs a real two-browser session with a real recording): the
  actual end-to-end handoff — joining with mic on/camera off, confirming the avatar shows in the
  recorded file, turning the camera on/off mid-recording and confirming the SAME file continues rather
  than fragmenting, and confirming a second live viewer never sees anything different from today.
