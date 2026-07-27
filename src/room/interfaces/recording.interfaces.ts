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
    source: 'webcam' | 'screen';
    transport: mediasoupTypes.PlainTransport;
    consumer: mediasoupTypes.Consumer;
    destPort: number;
    sdpPath: string;
    outputPath: string;
    ffmpeg: ChildProcess;
    dbId: string;
}

export interface IRecordingAudioInput {
    producerId: string;
    peerId: string;
    transport: mediasoupTypes.PlainTransport;
    consumer: mediasoupTypes.Consumer;
    destPort: number;
    sdpPath: string;
}

export interface IRecordingAudioMixSession {
    inputs: IRecordingAudioInput[];
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
    // Mutable — starts as the failsafe default, updated in stop() BEFORE teardownRoom()
    // runs, so per-stream GCS uploads (which happen during finalize, i.e. during teardown)
    // use the final, possibly user-renamed value for their <roomName>/<sessionName>/ path.
    sessionName: string;
    videoSessions: Map<string, IRecordingVideoSession>; // keyed by producerId
    audioMix: IRecordingAudioMixSession | null;
    // Serializes every audio-mix start/restart/finalize for this room onto one
    // chain, so a mic changing state while the initial snapshot is still being
    // processed can't run concurrently with it and orphan an untracked ffmpeg
    // process (state.audioMix getting overwritten mid-await is the failure
    // mode this prevents — see RecordingService.withAudioMixLock).
    audioMixLock: Promise<void>;
    // Per-(identity, streamType) sequence counter for the trailing filename
    // token — keyed e.g. "<peerId>:webcam", "<peerId>:screen", or the fixed
    // "mixed-audio:audio" for the audio-mix track. Disambiguates a single
    // participant's multiple simultaneous screen-shares, and doubles as an
    // audio-segment index across amix restarts. Scoped to one recording
    // session — reset each time a fresh start() creates new state.
    streamNumberCounters: Map<string, number>;
}
