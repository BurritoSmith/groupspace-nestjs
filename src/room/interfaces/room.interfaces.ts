import { types as mediasoupTypes } from 'mediasoup';
import { ITurnCredentials } from '../turn-credentials.service';

export type StreamSource = 'webcam' | 'screen' | 'mic';

export interface IChatMessage {
    id: string;
    userId: string;
    displayName: string;
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
