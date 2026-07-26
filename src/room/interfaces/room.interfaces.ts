import { types as mediasoupTypes } from 'mediasoup';
import { ITurnCredentials } from '../turn-credentials.service';

export type StreamSource = 'webcam' | 'screen' | 'mic';

export interface IChatMessage {
    peerId: string;
    displayName: string;
    text: string;
    at: string;
}

export interface IPeerSummary {
    peerId: string;
    displayName: string;
    pictureUrl: string;
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
    googleIdToken: string;
}

export interface IJoinRoomResult {
    peerId: string;
    routerRtpCapabilities: mediasoupTypes.RtpCapabilities;
    peers: IPeerSummary[];
    existingProducers: IProducerSummary[];
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
    displayName: string;
    pictureUrl: string;
    roomName: string;
    router: mediasoupTypes.Router;
    sendTransport: mediasoupTypes.WebRtcTransport | null;
    recvTransport: mediasoupTypes.WebRtcTransport | null;
    producers: Map<string, IPeerProducerRecord>;
    consumers: Map<string, mediasoupTypes.Consumer>;
}
