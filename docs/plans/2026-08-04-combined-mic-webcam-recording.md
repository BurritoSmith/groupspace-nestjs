# Combined mic+webcam recording for frame-accurate lip sync

Status: implemented. (See `spaces-angular-claude/docs/plans/2026-08-04-combined-mic-webcam-recording.md` for the identical plan/outcome — this change spans both repos.)

## Outcome

Implemented as designed after the validation spike, with the grace-window/speculative-input idea
replaced by the "only combine when both producers are already live" design documented in the
"Validation spike — result" section above (that section already reflects the final, shipped design,
not the original speculative one — no further changes needed there).

Notable deviations/findings during implementation:
- `RoomService.consume()`'s new `'producerresume'` keyframe listener required a test-fixture fix in
  `room.service.spec.ts` (the fake video consumer needed an `on: jest.fn()` stub it didn't have).
- Widened `generateLiveThumbnail`/`generateFinalThumbnail`'s parameter type from the concrete
  `IRecordingVideoSession` to a structural `{ outputPath: string; dbId: string }`, so
  `ICombinedCameraSession` (which doesn't share that type) can reuse them without duplicating two
  near-identical methods.
- `notifyProducerCreated`/`notifyProducerClosing` ended up needing NO new parameters threaded through
  from `RoomService.produce()` — `RecordingService` can determine "does a sibling producer already
  have a session" entirely from its own `state.videoSessions`/`state.cameraSessions`, which turned out
  simpler than the plan's original sketch of passing a `siblingProducerId` through.
- Added an `upgradeToCombinedCameraSession()` path (not explicitly spelled out in the original design
  section, though implied by "order-independent" in the Verification section): a webcam that started
  recording solo BEFORE mic existed gets its short solo file finalized and a fresh combined session
  started, reusing the same webcam producerId. This is what makes "camera on before mic" actually
  combine rather than staying solo forever.
- Backend (336 tests) and frontend (1808 tests) full suites pass; `npx tsc --noEmit` clean on both.
- **Not verified in this environment** (flagged for real-world testing): the actual lip-sync
  improvement and the toggle-boundary behavior (camera off/on a few times mid-recording, then playing
  back) requires a real two-browser mediasoup session with ffmpeg actually installed — the validation
  spike confirmed the ffmpeg/WebM mechanics in isolation, but the full join → toggle → stop → playback
  path per the plan's own Verification section (items 1-7) was not run end-to-end.

## Context

Recorded playback of a participant's webcam video and mic audio drifts enough that mouth movements
visibly don't match the audio. Today mic and webcam are captured as two fully independent
`MediaStream`s, published as two fully independent mediasoup Producers, and recorded server-side as
two fully independent files (own `PlainTransport`, own ffmpeg process, own DB `Recording` row each) —
synced only at PLAYBACK time via wall-clock `startedAt` offsets in `PlaybackSync`, reconciled every
250ms. That's precise enough for general "these clips roughly line up" purposes but not for lip sync.

The user's own framing of the fix: keep the audio stream running the whole session, and plug the
webcam video track into it when the camera is on, unplug it when off, plug it back in when on again —
"one long recorded file that doesn't need any syncing afterward." Screen shares must remain fully
independent and untouched.

**A prior design decision explicitly rejected muxing mic+webcam** (`recording.service.ts:450-452`:
*"Fixes screen-share drift for the same reason, which is why this is preferable to muxing mic and
webcam into a single file — that would only ever sync those two"*) in favor of applying one uniform
wall-clock mechanism to every stream type. This plan knowingly reverses that decision for mic+webcam
specifically, per explicit instruction — screen share stays on the old (still fine for its purposes)
mechanism, unaffected.

**Key finding from investigation**: mediasoup already gives us most of this for free. When a
server-side mediasoup `Producer` pauses, the worker automatically stops forwarding RTP to every
`Consumer` of that producer — and resumes automatically when the producer resumes — with zero
explicit action needed on the recording side. Combined with the existing, already-proven
`producer.replaceTrack()` pattern (`flipCamera()`), this means a webcam Producer can be kept **alive
for the whole session** — paused while the camera's off, resumed with a fresh track when it's back on
— rather than closed and recreated on every toggle. That one architectural move is what makes "one
long file, no after-the-fact syncing" achievable: mic anchors a single ffmpeg process for the whole
session, and webcam video simply flows into (or drops out of) that same process's second input
whenever its Producer is unpaused.

## Design

### 1. Frontend — keep the webcam Producer alive across on/off toggles

**File:** `spaces-angular-claude/src/app/room/services/media-room.ts`

- **`stopWebcam()` (1331-1343):** replace `notifyProducerClosed(producerId)` + `producer.close()` +
  `this.producers.delete(producerId)` with a new `notifyProducerPaused(producerId)` (emits
  `pause-producer`, see §2). Do **not** delete the entry from `this.producers` — a later
  `startWebcam()` needs to find it again via `findProducerEntryBySource('webcam')`. Still
  unconditionally `localWebcamTrack?.stop()` / clear the local signals — hardware is fully released
  either way.
- **`startWebcam()` (1135-1167):** after acquiring the new video track, branch on
  `findProducerEntryBySource('webcam')`:
  - **Entry exists** (a paused Producer from earlier this session) → new `resumeWebcamProducer()`:
    `await producer.replaceTrack({ track: videoTrack })`, `producer.resume()`, then
    `notifyProducerResumed(producer.id)` (emits `resume-producer`) — exactly `flipCamera()`'s
    (1266-1329) already-proven sequencing, paired with the new resume signal.
  - **No entry** (first camera-on this session) → today's `produceWebcamTrack()` (1174-1210),
    unchanged.
- New private helpers mirroring `notifyProducerClosed()` (1058-1065):
  `notifyProducerPaused(producerId)` / `notifyProducerResumed(producerId)` → `emitWithAck` the new
  socket events.
- **`leaveSession()`** needs no change: `closePeer()` on the backend closes the peer's
  `sendTransport`, which cascades a real close of every Producer built on it — including a
  merely-paused webcam Producer — so nothing leaks; it only ever fully closes on a genuine
  disconnect/leave, which is correct.
- Side effect worth noting in the PR (not extra work): `selectWebcamDevice()`'s device-switch
  stop+start round trip becomes a seamless `replaceTrack()` swap once this lands.

### 2. Backend — new pause/resume signaling (load-bearing, not cosmetic)

**Confirmed via `node_modules/mediasoup-client/lib/Producer.js`/`Transport.js`:** client-side
`Producer.pause()`/`.resume()` only calls the local WebRTC handler's `pauseSending`/`resumeSending`
(disables the local track) — it never signals the server. The mediasoup **server**-side
`Producer.pause()`/`.resume()` is the one whose state the worker uses to gate RTP to every Consumer
(recording's and every remote viewer's). A new gateway round-trip is required; there's no free lunch
here.

**Files:**
- `spaces-nestjs-api-claude/src/room/interfaces/room.interfaces.ts` — new
  `IPauseProducerPayload`/`IResumeProducerPayload` (`{ producerId }`, mirrors `ICloseProducerPayload`).
- `spaces-nestjs-api-claude/src/room/room.service.ts` — new `pauseProducer()`/`resumeProducer()`
  mirroring `closeProducer()` (350-364) but calling server-side `producer.pause()`/`.resume()`
  instead of `.close()`, and **not** calling `recordingService.notifyProducerClosing()`. In
  `consume()` (231-295), for video consumers, register
  `consumer.on('producerresume', () => void consumer.requestKeyFrame().catch(() => undefined))` —
  resume does not automatically trigger a keyframe (confirmed via mediasoup `Consumer.js`), so without
  this every remote viewer's tile stays frozen until the sender's next natural keyframe interval.
- `spaces-nestjs-api-claude/src/room/room.gateway.ts` — new `pause-producer`/`resume-producer`
  handlers mirroring `onCloseProducer()` (275-283), broadcasting `producer-paused`/`producer-resumed`.

**Live-call consequence that must be handled (real regression otherwise):** today, camera-off fully
closes the Producer → `producer-closed` broadcasts → `removeRemoteFeed()` drops it from
`remoteFeedsSignal` → the peer falls back to their avatar tile. With pause instead of close, no
`producer-closed` fires for a toggle, so a remote viewer would see a **frozen last frame indefinitely**
instead of falling back to the avatar. Fix:
- `media-room.ts` — add `paused: boolean` to `RemoteFeed` (17-30, default `false`); add
  `'producer-paused'`/`'producer-resumed'` listeners next to the existing `'producer-closed'` one
  (436) that update `remoteFeedsSignal`.
- `room.ts` — `videoFeeds` computed (187): filter also `&& !feed.paused`. This makes a paused feed
  fall out of `videoFeeds` exactly like a closed one does today (confirmed against the existing
  `remoteWebcamPeerIds` dedup logic at 355-358), so the peer falls back to their avatar tile while
  paused and snaps back instantly on resume — no re-`consume()` round trip needed since the
  `Consumer`/`MediaStream` was never torn down.

### 3. Backend — `RecordingService`: one ffmpeg process per (peer, camera) spanning mic+webcam

**File:** `spaces-nestjs-api-claude/src/room/recording.service.ts` (+ `recording.interfaces.ts`)

**Settled via an empirical spike (see "Validation spike — result" below): a video input that's
declared upfront but silent for a while does NOT work.** WebM/Matroska requires a video track's pixel
dimensions in its header at write time, and those are only ever discoverable by actually decoding a
real frame — SDP alone carries codec/payload-type/clock-rate but never resolution. A spike that
pre-declared both SDPs and attached real video 35s after a combined ffmpeg process launched failed
outright (`Could not find codec parameters ... unspecified size` → `Could not write header ...
Invalid argument` → `Conversion failed!`) — not a slow start, a hard failure, and the file never grew
even 1 byte in the meantime. **So the design below only ever starts a combined ffmpeg process once a
real webcam producer already exists (or shows up within a short grace window), never speculatively.**
Once a combined session's video track is successfully opened with real frames, later pause/resume
cycles (camera off/on mid-session) are fine — the header's dimensions are already locked in from real
data, and pausing a Producer just stops RTP momentarily, which WebM tolerates natively; the failure
mode is specific to the very first open, not to a mid-stream gap.

- New interface `ICombinedCameraSession` (`recording.interfaces.ts`): `{ peerId, userId, displayName,
  dbId, audioProducerId, videoProducerId, audioTransport, audioConsumer, videoTransport, videoConsumer,
  audioSdpPath, videoSdpPath, destPortAudio, destPortVideo, outputPath, ffmpeg, streamNumber }`. New
  `IRoomRecordingState.cameraSessions: Map<string, ICombinedCameraSession>` keyed by **peerId** (the
  one map in this file keyed differently, since it groups two producerIds). Also new
  `IRoomRecordingState.pendingMicAnchors: Map<string, { micInfo: IRecordingProducerInfo; timer:
  NodeJS.Timeout }>` — peers whose mic producer just started and are within their grace window,
  waiting to see if a sibling webcam producer shows up before committing to solo audio.
- **`start()` (247-300):** for the initial snapshot, grouping is simple and needs no grace window —
  every producer that exists is already known. For a peer with both a `'mic'` and a `'webcam'`
  producer in the snapshot, route both into `startCombinedCameraSession(state, router, micInfo,
  webcamInfo)` (real video data flows immediately — the safe case). A `'mic'` with no sibling
  `'webcam'`, a `'webcam'` with no sibling `'mic'`, and every `'screen'` producer, all go through
  today's unchanged `startVideoSession()`.
- **`notifyProducerCreated()` (337-348)** (a producer arriving after recording already started) — new
  logic:
  - A `'mic'` producer: check `peer.producers` (already in scope at the `RoomService.produce()` call
    site, threaded through) for an existing `'webcam'` producer for the same peer.
    - **Sibling webcam already exists** → `startCombinedCameraSession()` immediately (real frames
      already flowing — safe, no grace window needed).
    - **No sibling yet** → start today's plain `startVideoSession()` (`streamType: 'mic'`) for the mic
      *immediately* (so audio recording is never delayed), but also register a `GRACE_WINDOW_MS =
      3_000` entry in `pendingMicAnchors` for this peer. This is a **best-effort upgrade window**, not
      a blocking one: if nothing arrives before the timer fires, just clear the pending entry — the
      mic keeps recording solo exactly as already started, no regression.
    - **Grace window race, not currently supported**: because the mic's plain audio session already
      started (to avoid delaying audio), a webcam that arrives inside the grace window can't
      retroactively "upgrade" that already-running single-input ffmpeg process into a combined one
      (same launch-time-inputs constraint as the spike just proved). So in practice `pendingMicAnchors`
      is used the other direction: **only relevant when the webcam arrives before the mic's own
      `startVideoSession()` call has actually completed its `spawnFfmpegAndWaitReady`** — a narrow
      timing window, not a multi-second one. Given that's a race rather than a real grace period,
      simplify: **drop `pendingMicAnchors` entirely.** A `'mic'` producer with no sibling `'webcam'` in
      `peer.producers` at that exact instant always starts a plain solo audio session, full stop. The
      only paths that produce a combined `'camera'` recording are (a) `start()`'s initial-snapshot
      case above, and (b) a `'webcam'` producer created while a `'mic'` producer already has an
      established solo or combined session (see next bullet) — both cases where real video data is
      available immediately, matching what the spike actually validated.
  - A `'webcam'` producer: look up `state.cameraSessions` / the peer's existing plain mic session for
    the same peerId.
    - **Peer has an existing plain solo `'mic'` recording session** (today's `startVideoSession()`
      state) and no `'camera'` session yet → this is the "webcam turned on after mic already
      recording" case. **Do not attempt to retrofit the existing solo audio file** (same reason as
      above — its ffmpeg process was already launched single-input). Simplest, safe choice: give the
      webcam its own independent `'webcam'` recording via today's unchanged `startVideoSession()` —
      the pre-existing, still-correct fallback behavior. Document this plainly as the accepted scope
      limit: **only a webcam that's active at the moment mic starts (join-time, or effectively
      simultaneous) gets the combined/lip-synced file; a camera enabled later in the same session
      degrades gracefully to today's independent-file wall-clock-synced behavior**, exactly matching
      what's actually empirically safe.
    - **Peer has a live `'camera'` session** (a prior combined session where video was later paused,
      not closed, per §1/§2) with `videoConsumer === null` → this is a **resume**, not a fresh start:
      attach a new Consumer to the already-open `videoTransport` for the new webcam producerId, resume
      it, request a keyframe. No new ffmpeg process, no new Recording row.
- **`startCombinedCameraSession(state, router, micInfo, webcamInfo)`** — both producers are always
  known and already producing real data by the time this is called (never speculative):
  1. Audio half: identical to today's audio branch of `startVideoSession()` (396-435) — PlainTransport,
     port, SDP, `consumer.resume()`.
  2. Video half: identical shape, second PlainTransport/port/SDP, `consume(webcamInfo.producerId)`,
     `resume()`, request keyframe.
  3. Spawn **one** ffmpeg process with both SDPs as `-i` inputs and explicit `-map 0:a -map 1:v`
     (`buildRecordingFfmpegArgs` needs a two-input variant; keep the single-input one for
     `startVideoSession`'s callers). **Repeat `-protocol_whitelist file,udp,rtp` before EACH `-i`** —
     confirmed via the spike that ffmpeg's CLI applies it per-next-input, not globally; a shared
     single copy left the second input rejected with "Protocol 'rtp' not on whitelist" before the
     dimensions issue was ever reached.
  4. One `Recording` row, `streamType: 'camera'` (§4), `startedAt` = the instant audio media started
     flowing (same discipline as the existing comment at 441-452).
  5. Register in `state.cameraSessions` keyed by peerId.
- **Pause/resume are automatic at the RTP layer** once §2 exists — `RecordingService` needs no new
  hooks for the RTP path itself. It does need
  `videoConsumer.on('producerresume', () => requestKeyFrame())` (same reasoning as §2) so a
  camera-back-on doesn't wait on the sender's natural keyframe cadence.
- **Finalization anchored on the mic producer closing:** `notifyProducerClosing()` gets a new branch —
  if the closing id matches a `cameraSessions` entry's `audioProducerId`, finalize the whole combined
  session (new `finalizeCombinedCameraSession()`, same shape as today's `finalizeVideoSession()`). If
  it matches `videoProducerId` instead, don't finalize — just detach that slot (`videoConsumer?.close()`,
  null out `videoConsumer`/`videoProducerId`) so a later webcam producer can attach fresh into the same
  still-open video transport. Both branches are genuinely hit on a real disconnect (`closePeer()`
  closes every producer, order between mic/webcam not guaranteed) — guard both for being called on an
  already-detached slot.
- **Class doc comment (31-46):** rewrite — it currently states the design choice this plan reverses.
  Describe the new mic-anchored combined-camera model (only when webcam is already active at the
  moment of combining), screen share's unchanged independent model, and the accepted "camera enabled
  later" fallback.

### 4. DB/schema

`streamType` (`prisma/schema.prisma:154-189`) is already a plain `String`, not a Prisma enum — no
migration needed, just a new accepted value `'camera'` (combined mic+webcam) alongside unchanged
`'webcam'` (legacy/fallback video-only), `'mic'` (fallback audio-only), and `'screen'` (unaffected).
Update the field's comment to list all four accurately. `buildFilename()`/`nextStreamNumber()` already
take plain strings — no signature changes. `IRecordingProducerInfo`'s `source` type stays unchanged —
it describes a live Producer's kind, unaffected by this; `'camera'` only ever appears as a
`Recording.streamType`.

### 5. Frontend playback — verified to need materially less work than expected

- `spaces-angular-claude/src/app/playback/playback.ts` — `streamTiles` (91-94) already maps any
  non-`'mic'`, non-`'screen'` recording to `kind: 'webcam'`, so a `'camera'`-streamType row falls into
  the existing bucket with **zero code change**. Since a combined session never produces a separate
  `'mic'`-streamType row for its duration, `activeWebcamUserIds`'s existing avatar-dedup logic
  (168-174) simply never has a competing avatar tile to suppress — nothing to change there either.
- `playback-video-tile.ts`/`.html` — confirmed the `<video>` element has no `muted` attribute today,
  so a `'camera'` recording's embedded audio plays natively the moment it's used. No change.
- `playback-sync.ts` — no change needed; it already operates generically on any `HTMLMediaElement`,
  and a `'camera'` recording's native A/V sync is the browser's problem now, not `PlaybackSync`'s.
- `recordings.ts` — `RecordingSummary.streamType` is already plain `string`; just update its doc
  comment to mention `'camera'`.
- `participant-avatar-tile.ts` — no change; only instantiated for `'mic'`-streamType rows, which a
  combined session's duration never produces.
- Verify these "no change" conclusions hold once real data exists, but don't pre-emptively touch them.

## Validation spike — result (settled, no longer open)

Ran a standalone ffmpeg-only spike (no mediasoup needed for this part — it's a pure ffmpeg
demuxer/muxer question): pre-wrote both an audio and a video SDP exactly matching
`buildSdp()`'s format, launched a two-input recorder ffmpeg process immediately
(`-protocol_whitelist file,udp,rtp -use_wallclock_as_timestamps 1 -i audio.sdp` × 2,
`-map 0:a -map 1:v -c copy`), fed real Opus RTP to the audio port immediately, and only started
sending real VP8 RTP to the video port 35 seconds later (simulating "webcam turns on well after
mic").

**Result: hard failure, not just delay.** The output file stayed at 0 bytes the entire time — not
because it was buffering, but because the process never successfully opened the output at all:
```
[in#1/sdp] Could not find codec parameters for stream 0 (Video: vp8, yuv420p): unspecified size
[webm] dimensions not set
[out#0/webm] Could not write header (incorrect codec parameters ?): Invalid argument
Conversion failed!
```
WebM/Matroska requires a video track's pixel dimensions in its header at write time. SDP only carries
codec/payload-type/clock-rate (present for both audio and video) — dimensions are only ever knowable
by actually decoding a real frame, which a stream that hasn't sent anything yet can't provide. This
isn't a probe-timeout tuning issue; the muxer fundamentally can't open with an unresolved video track.
(Also found and fixed in the spike itself, not a real finding: `-protocol_whitelist` only applies to
the next `-i`, not globally — needs repeating before each input, carried into §3 above.)

**Consequence for the design:** §3 above no longer pre-allocates a video "slot" speculatively. A
combined `'camera'` recording is only ever started once a real webcam producer already exists (join-
time, or effectively simultaneous with mic) — the only case the spike actually validates as safe,
since real frames are already flowing before the muxer ever needs to write its header. A camera
enabled later in the same session (the common "joined audio-only, turned camera on minutes later"
case) falls back to today's independent `'webcam'` file + wall-clock sync — unchanged from current
behavior, just not upgraded. This is a narrower win than originally scoped but is the actual
ffmpeg-safe boundary, not a guess.

## Files to touch

**`spaces-nestjs-api-claude`**
- `src/room/recording.service.ts` — `start()`, `notifyProducerCreated()`, `notifyProducerClosing()`,
  new `startCombinedCameraSession()`/`finalizeCombinedCameraSession()`, two-input
  `buildRecordingFfmpegArgs()` variant, class doc comment
- `src/room/interfaces/recording.interfaces.ts` — `ICombinedCameraSession`, `IRoomRecordingState.cameraSessions`
- `src/room/room.service.ts` — `produce()` (sibling lookup), `pauseProducer()`/`resumeProducer()`,
  `consume()` (video `'producerresume'` keyframe listener)
- `src/room/room.gateway.ts` — `pause-producer`/`resume-producer` handlers
- `src/room/interfaces/room.interfaces.ts` — `IPauseProducerPayload`/`IResumeProducerPayload`
- `prisma/schema.prisma` — `Recording.streamType` comment update only (no migration)

**`spaces-angular-claude`**
- `src/app/room/services/media-room.ts` — `stopWebcam()`, `startWebcam()`, new
  `resumeWebcamProducer()`/`notifyProducerPaused()`/`notifyProducerResumed()`, `RemoteFeed.paused`,
  new `'producer-paused'`/`'producer-resumed'` listeners
- `src/app/room/room.ts` — `videoFeeds` computed (filter `!feed.paused`)
- `src/app/room/services/recordings.ts` — doc comment only
- Verify (expected unchanged): `playback.ts`, `playback-video-tile.ts`, `playback-sync.ts`,
  `participant-avatar-tile.ts`

## Verification

1. Join with mic AND webcam both already on (or webcam on within a second or two of mic), toggle
   camera off/on 3-4 times over a couple minutes, stop recording. Confirm exactly one `'camera'`-type
   recording exists for that user; it plays with audio in sync across every toggle boundary
   (clap-on-camera sync check); no artifact/freeze/glitch at a toggle point; scrubbing through a
   toggle boundary doesn't desync.
2. During a "camera off, mic still on" stretch: video pauses/freezes appropriately while audio keeps
   flowing uninterrupted, no gap in the audio track.
3. Fallbacks: (a) camera already on before mic starts — still combines, order-independent (both
   producers exist before `startCombinedCameraSession` is invoked). (b) mic-only user who never
   enables camera — plain audio-only recording, no empty video track weirdness. (c) camera enabled
   well after mic (the accepted scope limit) — degrades gracefully to today's independent-file
   wall-clock sync, still watchable, just not natively synced.
5. Live-call regression check: two tabs, tab A toggles webcam off/on, tab B's tile falls back to tab
   A's avatar while off (not a frozen frame) and snaps back promptly with a fresh non-blurry keyframe
   on resume.
6. Screen share unaffected: start one alongside mic+webcam, confirm it's still its own independent
   file/row with unchanged wall-clock sync behavior in playback.
7. Peer disconnect mid-recording (close tab, not "Leave Session") with both mic and webcam live —
   combined session finalizes exactly once (no double-finalize crash from mic/webcam close-order
   race), file is playable, no orphaned ffmpeg process.
