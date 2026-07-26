import { types as mediasoupTypes } from 'mediasoup';
import { ChildProcess } from 'node:child_process';
import { StreamSource } from './room.interfaces';

export interface IRecordingProducerInfo {
    producerId: string;
    peerId: string;
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
}

export interface IRoomRecordingState {
    roomName: string;
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
