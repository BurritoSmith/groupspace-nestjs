import { types as mediasoupTypes } from 'mediasoup';
import { ChildProcess } from 'node:child_process';
import { StreamSource } from './room.interfaces';

export interface IRecordingProducerInfo {
    producerId: string;
    peerId: string;
    userId: string;
    displayName: string;
    source: StreamSource;
}

/** Everything RecordingService.start() needs to seed a fresh recording. */
export interface IRecordingSnapshot {
    router: mediasoupTypes.Router;
    producers: IRecordingProducerInfo[];
}

export interface IRecordingVideoSession {
    producerId: string;
    peerId: string;
    displayName: string;
    // Widened to the full StreamSource (webcam/screen/mic) now that mic producers are recorded
    // through this same one-producer-one-session pipeline instead of a separate mixed track.
    source: StreamSource;
    transport: mediasoupTypes.PlainTransport;
    consumer: mediasoupTypes.Consumer;
    destPort: number;
    sdpPath: string;
    outputPath: string;
    ffmpeg: ChildProcess;
    dbId: string;
}

export interface IRecordingSessionSummary {
    id: string;
    name: string;
    startedAt: string;
    stoppedAt: string | null;
}

export interface IRecordingSummary {
    id: string;
    filename: string;
    streamType: string;
    displayName: string;
    /** The recording's owning participant — null only for legacy rows predating per-user
     *  attribution (the old mixed-audio track never populated this). Every stream (webcam,
     *  screen, and now mic) recorded going forward always has one. */
    userId: string | null;
    /** That participant's avatar image, for the playback page's speaker-avatar row. Null
     *  wherever userId is null, for the same legacy-row reason. */
    pictureUrl: string | null;
    /** Local VM URL until the GCS upload is confirmed complete (gcsUploadedAt), then the signed
     *  Cloud Storage URL — see RecordingService.buildPlaybackUrls. Null until the recording stops
     *  (the file doesn't exist yet) or if GCS isn't configured and the local file is unreachable. */
    url: string | null;
    /** Grayscale while thumbnailStatus is 'live' (mid-recording snapshot), full color once 'final'
     *  (extracted from the finished, remuxed file). Null for audio-only recordings and before the
     *  first extraction attempt has run. Always served from local disk — see RecordingService's
     *  local-only-thumbnails design choice. */
    thumbnailUrl: string | null;
    /** When this specific stream started — recordings in the same session can start at genuinely
     *  different real-world moments (a screen share begun well after the webcam, say), so the
     *  frontend uses this to align every stream on one shared timeline rather than assuming they
     *  all started together. */
    startedAt: string;
    /** When this specific stream stopped, or null while still recording — paired with startedAt
     *  so the frontend can compute each recording's actual duration from our own bookkeeping
     *  instead of trusting the browser's <video>.duration. */
    stoppedAt: string | null;
    /** False when the stream stopped but never actually captured any data (the producer never
     *  emitted a keyframe, or was stopped before any frame arrived) — stoppedAt is still set in
     *  that case, but url stays null forever and the frontend must exclude this recording from
     *  the shared playback timeline entirely, not just leave it with an unplayable link. */
    hasContent: boolean;
}

export interface IRecordingSessionDetail extends IRecordingSessionSummary {
    roomName: string;
    recordings: IRecordingSummary[];
}

export interface IRoomRecordingState {
    roomName: string;
    // The RecordingSession DB row grouping every stream in this start()/stop() lifecycle
    // together, for the future playback component to look up "all streams for session X".
    sessionDbId: string;
    // When this recording session actually started — surfaced via RecordingService.
    // getRecordingStartedAt() so a client joining mid-recording (or the 'recording-state'
    // broadcast) can compute the true elapsed time instead of starting a fresh timer at 0.
    startedAt: Date;
    // Mutable — starts as the failsafe default, updated in stop() BEFORE teardownRoom()
    // runs, so per-stream GCS uploads (which happen during finalize, i.e. during teardown)
    // use the final, possibly user-renamed value for their <roomName>/<sessionName>/ path.
    sessionName: string;
    // Every active producer's recording session — webcam, screen, AND mic all live here now,
    // each with a fully independent lifecycle keyed by producerId (no shared/coupled state
    // between them, unlike the old single shared audio-mix session).
    videoSessions: Map<string, IRecordingVideoSession>; // keyed by producerId
    // Per-(identity, streamType) sequence counter for the trailing filename token — keyed e.g.
    // "<peerId>:webcam", "<peerId>:screen", "<peerId>:mic". Disambiguates a single participant's
    // multiple simultaneous screen-shares (or successive mic on/off cycles) within one recording
    // session — reset each time a fresh start() creates new state.
    streamNumberCounters: Map<string, number>;
    // Finalizations already kicked off fire-and-forget by notifyProducerClosing (an individual
    // stream stopping on its own, ahead of the whole recording stopping) that haven't settled
    // yet. teardownRoom() must wait for these too, not just whatever's still in videoSessions at
    // the moment it runs — a producer closed moments earlier is already removed from
    // videoSessions (see notifyProducerClosing), so without this its still-in-flight ffmpeg
    // stop/remux could lose the race against the recording session being marked stopped.
    pendingFinalizations: Set<Promise<void>>;
    // Serializes startVideoSession() calls for this room so concurrent producer starts (e.g. a
    // user's webcam+screen+mic all negotiating at once, or several users starting near-simultaneously)
    // don't all spawn CPU-heavy ffmpeg encoders in the same instant — see RecordingService.enqueueStart().
    // A promise chain, not a counter/lock, so callers just await their own link and one start's
    // rejection can't jam the queue for the rest.
    startQueue: Promise<void>;
    // Same pattern as startQueue, for finalizeVideoSession() calls — stopping a session with
    // several active streams (or "stop all streams" closing several producers at once) used to
    // finalize every one of them concurrently via Promise.all, which could pile just as much
    // simultaneous CPU-heavy ffmpeg work onto stop as an unstaggered start could. See
    // RecordingService.enqueueStop().
    stopQueue: Promise<void>;
}
