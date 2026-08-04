# Server-side video poster fallback for iOS uploads

**Status: implemented.**

## Context

Video messages sent from iOS render in chat as tiny bubbles with just a play button, instead of a
properly-sized poster/thumbnail like videos from other platforms. Client-side poster generation
(`spaces-angular-claude`'s `poster-frame.ts`) draws a `<video>` frame to canvas before upload; this can
silently fail on iOS (HEVC `.mov` decode issues are the suspected common case), leaving a video
attachment with no `thumbnailUrl` and/or no `width`/`height` — the chat tile then has nothing to size
itself against. Fix: have this API detect a missing or implausible poster and generate one
server-side, extending the exact pattern already used for PDF thumbnails (`pdf-thumbnail.service.ts`),
which exists for the identical reason (client-side generation proved unreliable there too).

## Where this hooks in

`POST /chat/media` (`chat-media.controller.ts`) uploads a video and its poster as two **separate**
calls — the client assembles the final attachment object itself and sends it over the `chat-message`
WebSocket event. That event, handled by `room.gateway.ts`'s `onChatMessage`, is therefore the only
point that ever sees the full picture (video URL + claimed `thumbnailUrl`/`width`/`height` together).

`onChatMessage` is deliberately synchronous and non-blocking — it broadcasts immediately and never
awaits `saveMessage` or `scrapeLinkPreview` (both fire-and-forget, patching the message afterward via
a `chat-message-updated` event once their slow work finishes). Video poster regeneration is exactly
this shape of work (a fetch/decode, not a field check) and must follow the same pattern — mirroring
`scrapeLinkPreview` precisely, not blocking the send path.

## Design

### Trigger condition

For each `attachment.kind === 'video'` in the sanitized attachments array, regeneration is needed
when:
- `!attachment.thumbnailUrl`, or `!attachment.width`, or `!attachment.height` — definitely missing, **or**
- the *existing* poster's own real pixel aspect ratio (read by decoding its bytes) disagrees with the
  claimed `width`/`height`'s aspect ratio by more than **12%** — or the poster can't be fetched/decoded
  at all (404, corrupt, zero bytes).

Only the poster image's own bytes are read for this check (cheap — a small JPEG), never the video
itself, unless regeneration is already happening. Deliberately does **not** always probe the source
video's real dimensions for a "true" video-vs-claim comparison — that would touch every video's
(up to 100MB) bytes on every message including the common, already-correct case, for a failure mode
(internally-consistent-but-wrong values) the reported bug doesn't describe. Revisit later if the
poster-only check proves insufficient.

### Generation

New `src/room/video-thumbnail.service.ts`, mirroring `pdf-thumbnail.service.ts`'s shape exactly
(injectable, best-effort, resolves `null` on any failure, never throws):
```ts
export interface VideoThumbnailResult { buffer: Buffer; width: number; height: number; }

@Injectable()
export class VideoThumbnailService {
    private readonly ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'; // same convention as RecordingService

    /** input: an https:// URL ffmpeg can read directly (GCS, public-read), or a local filesystem
     *  path (local-dev). One frame near the 1s mark, scaled to fit THUMBNAIL_MAX_EDGE_PX (reused
     *  from pdf-thumbnail.service.ts, not duplicated) without upscaling. Reports the RENDERED
     *  thumbnail's own pixel size — same convention PDF already uses. Null on any failure. */
    async generate(input: string): Promise<VideoThumbnailResult | null> { ... }

    /** Reads a JPEG/PNG buffer's own real pixel dimensions — used here to measure generate()'s own
     *  output, and by ChatMediaService to measure an EXISTING poster for the mismatch check. */
    async readImageDimensions(buffer: Buffer): Promise<{ width: number; height: number } | null> { ... }

    // Test-substitution seams, same reasoning as PdfThumbnailService.loadPdfjsLib:
    protected spawn(args: string[]): ChildProcess { return spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    protected loadImage(buffer: Buffer) { return loadImage(buffer); } // @napi-rs/canvas — already a dependency
}
```
ffmpeg args (frame piped to stdout — no temp files):
`-y -ss 1 -i <input> -frames:v 1 -vf "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease" -f image2 -vcodec mjpeg -q:v 3 pipe:1`
— bounds output to a 768px box (matching PDF's `THUMBNAIL_MAX_EDGE_PX`) without upscaling, works for
both landscape and portrait without knowing the source dimensions up front. Wrapped in a ~15s timeout
(`kill('SIGKILL')` on expiry); stdout collected into a Buffer, stderr tail kept for the failure log.

### Wiring: `ChatMediaService`

```ts
// constructor(pdfThumbnails: PdfThumbnailService, videoThumbnails: VideoThumbnailService)

/** Resolves an attachment's own url to something ffmpeg/fs can read: the https URL as-is in GCS
 *  mode (public-read — no auth needed), or a real local path (strip publicBase's /chat-media/
 *  prefix, join onto localDir) in local-dev mode, where storagePath is never populated. */
private resolveMediaLocation(url: string): string { ... }

/** Best-effort raw-bytes read of one of OUR OWN attachment URLs (never the video itself — only
 *  used for the small poster-image mismatch check). Plain fetch()/fs.readFile — NOT
 *  link-preview-url.ts's SSRF-hardened fetchWithRedirectGuard, which is for arbitrary
 *  THIRD-PARTY URLs; this only ever reads our own already-validated storage. Null on any failure. */
private async readMediaBytes(url: string): Promise<Buffer | null> { ... }

private async videoThumbnailNeedsRegeneration(attachment: IChatAttachment): Promise<boolean> { ... } // the trigger condition above

/** Regenerates a video's poster/dimensions when they look missing or wrong. Returns a NEW
 *  IChatAttachment with thumbnailUrl/width/height patched, or null when nothing needed to change
 *  or generation failed (both mean: leave the message exactly as sent). */
async ensureVideoThumbnail(attachment: IChatAttachment, roomName: string): Promise<IChatAttachment | null> {
    if (attachment.kind !== 'video' || !(await this.videoThumbnailNeedsRegeneration(attachment))) return null;
    const generated = await this.videoThumbnails.generate(this.resolveMediaLocation(attachment.url));
    if (!generated) return null;
    const uploaded = await this.uploadAttachment(generated.buffer, roomName, 'image/jpeg'); // same path as any file, PDF thumbnails included
    return { ...attachment, thumbnailUrl: uploaded.url, width: generated.width, height: generated.height };
}
```

### Wiring: persist + broadcast

`ChatService.updateAttachments(id, attachments)` — new method, mirrors `updateLinkPreview` exactly
(same try/catch/log-warning shape, same tolerance for the row not existing yet since `saveMessage` is
itself fire-and-forget).

`RoomGateway.ensureVideoPosters(messageId, roomName, attachments)` — new private method, called
fire-and-forget right after the existing `this.scrapeLinkPreview(message.id, roomName, text);` line in
`onChatMessage`. Filters to video attachments, calls `ensureVideoThumbnail` on each, and if any patch
came back, persists the **whole** updated attachments array via `updateAttachments` and emits
`chat-message-updated` with `{id: messageId, attachments: updatedAttachments}` — reusing
`IChatMessageUpdate.attachments`, a field that already exists on the type but nothing sets today.
Mirrors `scrapeLinkPreview`'s `.then()/.catch()` shape and `.debug`-level (not `.warn`/`.error`)
failure logging — a decode/ffmpeg failure here is an ordinary outcome for a bad upload, not a fault.

### Failure isolation

Every layer resolves `null`/no-op rather than throwing: `VideoThumbnailService` (try/catch → `null`),
`ChatMediaService.readMediaBytes`/`ensureVideoThumbnail` (try/catch → `null`), the gateway's
`.catch()`. None of this touches `onChatMessage`'s synchronous body — worst case, nothing happens and
the client-supplied attachment (however imperfect) is exactly what was sent, same as today.

## Files to touch

- New: `src/room/video-thumbnail.service.ts` (+ `.spec.ts`).
- `src/room/pdf-thumbnail.service.ts` — export `THUMBNAIL_MAX_EDGE_PX` (currently private) for reuse.
- `src/room/chat-media.service.ts` — `VideoThumbnailService` added to constructor; `ASPECT_RATIO_TOLERANCE = 0.12` const; `resolveMediaLocation`, `readMediaBytes`, `videoThumbnailNeedsRegeneration` (private), `ensureVideoThumbnail` (public).
- `src/room/chat-media.service.spec.ts` — fake `VideoThumbnailService`; new `ensureVideoThumbnail` describe block covering: non-video skip, missing thumbnailUrl/width/height → regenerate, matching aspect ratio → skip, mismatched → regenerate, unreadable poster → regenerate, generation failure → null, upload failure → null; GCS-mode and local-dev-mode variants of the byte-read path.
- `src/room/chat.service.ts` — `updateAttachments(id, attachments)`.
- `src/room/chat.service.spec.ts` — new tests mirroring `updateLinkPreview`'s.
- `src/room/room.gateway.ts` — `ensureVideoPosters` private method; call site in `onChatMessage`.
- `src/room/room.gateway.spec.ts` — extend `fakeChatMediaService`/`fakeChatService` fixtures with `ensureVideoThumbnail`/`updateAttachments`; new `onChatMessage` cases: patched video → `updateAttachments` + second `chat-message-updated` emit; no-op patch → neither happens; no video attachments → `ensureVideoThumbnail` never called.
- `src/room/room.module.ts` — register `VideoThumbnailService` as a provider.

## Verification

- `npm test` (Jest) after each file group.
- Cannot be verified in this environment — flag for manual/staging testing with a real iOS upload:
  1. Whether the deploy image's `ffmpeg` (plain `apt-get install ffmpeg`, no explicit HEVC flag) actually decodes a real iPhone HEVC `.mov` (stored as `.mp4` per `file-sniff.ts`'s `qt  ` brand handling).
  2. Whether `ffmpeg -i https://storage.googleapis.com/...` reliably reads a GCS-hosted MP4 whose `moov` atom is at the end of the file (common for iOS exports without `-movflags faststart`) — may need more buffering/time than a `moov`-at-front file, or a fallback approach if it fails outright.
  3. Whether `-ss 1` *before* `-i` (fast seek, used here) ever lands before the first keyframe on a real iOS export and produces a black frame — if so, swap to `-ss 1` *after* `-i` (slower, frame-accurate).
  4. Whether `ASPECT_RATIO_TOLERANCE = 0.12` correctly separates real mismatches from encoder rounding noise in practice — tune after seeing real data.

## Outcome

Implemented exactly as designed above: `VideoThumbnailService` (+ spec), `THUMBNAIL_MAX_EDGE_PX` exported from `PdfThumbnailService`, `ChatMediaService.ensureVideoThumbnail`/`resolveMediaLocation`/`readMediaBytes`/`videoThumbnailNeedsRegeneration` (+ spec), `ChatService.updateAttachments` (+ spec), `RoomGateway.ensureVideoPosters` wired into `onChatMessage` (+ spec), `VideoThumbnailService` registered in `room.module.ts`. `npx tsc --noEmit` and the full Jest suite (336 tests, 24 suites) are green. The four real-world unknowns listed above under Verification were NOT resolvable in this environment and still need checking against a real iOS upload on staging/production before this is fully trusted.
