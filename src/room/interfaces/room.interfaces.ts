import { types as mediasoupTypes } from 'mediasoup';
import { ITurnCredentials } from '../turn-credentials.service';

export type StreamSource = 'webcam' | 'screen' | 'mic';

export interface IChatMessage {
    id: string;
    userId: string;
    displayName: string;
    // Snapshotted at send-time, same as displayName — see ChatMessage.pictureUrl's schema
    // comment. Empty string (not null) here: the frontend falls back to a generic person icon
    // either way, so callers don't need to special-case null vs. missing.
    pictureUrl: string;
    text: string;
    at: string;
}

export interface IPeerSummary {
    peerId: string;
    userId: string;
    displayName: string;
    pictureUrl: string;
    micSelfMuted: boolean;
}

export interface IProducerSummary {
    producerId: string;
    peerId: string;
    displayName: string;
    source: StreamSource;
    kind: mediasoupTypes.MediaKind;
}

export interface IJoinRoomPayload {
    roomName: string;
    // Exactly one of these is expected: googleIdToken for a fresh Google sign-in (the very
    // first join, or whenever no still-valid session token exists yet), sessionToken for every
    // subsequent join — see SessionService and room.gateway.ts's onJoinRoom.
    googleIdToken?: string;
    sessionToken?: string;
}

export interface IJoinRoomResult {
    peerId: string;
    userId: string;
    routerRtpCapabilities: mediasoupTypes.RtpCapabilities;
    peers: IPeerSummary[];
    existingProducers: IProducerSummary[];
    chatHistory: IChatMessage[];
    hasMoreChatHistory: boolean;
    iceServers: ITurnCredentials[];
    // Whether the room is currently being recorded — included directly here (rather than relying
    // solely on the 'recording-state' broadcast) so a client joining after recording has already
    // started reflects reality immediately instead of defaulting to "not recording" until/unless
    // a broadcast it could never have received happens to arrive. Mirrors how micSelfMuted is
    // included per-peer for the same reason.
    isRecording: boolean;
    // When the current recording session started, or null if not recording — lets a joining
    // client compute the true elapsed time instead of starting its timer at 00:00. Mirrors the
    // same 'recording-state' broadcast field (see RecordingService.getRecordingStartedAt()).
    recordingStartedAt: string | null;
}

export interface ICreateTransportPayload {
    direction: 'send' | 'recv';
}

export interface ITransportParams {
    id: string;
    iceParameters: mediasoupTypes.IceParameters;
    iceCandidates: mediasoupTypes.IceCandidate[];
    dtlsParameters: mediasoupTypes.DtlsParameters;
}

export interface IConnectTransportPayload {
    direction: 'send' | 'recv';
    dtlsParameters: mediasoupTypes.DtlsParameters;
}

export interface IProducePayload {
    kind: mediasoupTypes.MediaKind;
    rtpParameters: mediasoupTypes.RtpParameters;
    source: StreamSource;
}

export interface IConsumePayload {
    producerId: string;
    rtpCapabilities: mediasoupTypes.RtpCapabilities;
}

export interface IConsumerParams {
    id: string;
    producerId: string;
    kind: mediasoupTypes.MediaKind;
    rtpParameters: mediasoupTypes.RtpParameters;
    source: StreamSource;
    peerId: string;
    displayName: string;
}

export interface IResumeConsumerPayload {
    consumerId: string;
}

// 'low'/'high' rather than a raw spatial-layer index — the client doesn't need to know each
// producer's actual simulcast layer count (webcam and screen share differ), the server resolves
// the semantic tier to the right index against the producer's own negotiated encodings. See
// RoomService.setConsumerQuality().
export type ConsumerQuality = 'low' | 'high';

export interface ISetConsumerQualityPayload {
    consumerId: string;
    quality: ConsumerQuality;
}

export interface ICloseProducerPayload {
    producerId: string;
}

export interface IChatMessagePayload {
    text: string;
}

export interface IPeerProducerRecord {
    producer: mediasoupTypes.Producer;
    source: StreamSource;
}

/** Per-connected-socket server-side state. */
export interface IPeerState {
    peerId: string;
    userId: string;
    displayName: string;
    pictureUrl: string;
    // Client-side "keep the mic producer alive but silence the track" mute (MediaStreamTrack.enabled
    // = false) — invisible to the server otherwise, so this flag exists purely to let a late joiner's
    // join-room ack reflect the current state of everyone already in the room. See setMicSelfMuted.
    micSelfMuted: boolean;
    roomName: string;
    router: mediasoupTypes.Router;
    sendTransport: mediasoupTypes.WebRtcTransport | null;
    recvTransport: mediasoupTypes.WebRtcTransport | null;
    producers: Map<string, IPeerProducerRecord>;
    consumers: Map<string, mediasoupTypes.Consumer>;
}
