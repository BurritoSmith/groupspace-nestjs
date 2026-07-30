import { types as mediasoupTypes } from 'mediasoup';
import { ITurnCredentials } from '../turn-credentials.service';

export type StreamSource = 'webcam' | 'screen' | 'mic';

// Metadata for one uploaded/hotlinked piece of chat media — never the file bytes themselves.
// `storagePath` is the GCS object path (null for a Giphy-hotlinked gif, which has nothing of ours
// to point at) — kept alongside `url` specifically so a future switch from public-read objects to
// signed URLs is a server-only change, without needing to touch anything already persisted.
// width/height/durationMs/sizeBytes are untrusted layout hints supplied by the uploading client —
// see isAllowedAttachmentUrl's clamping in room.gateway.ts before any of this reaches other peers.
export interface IChatAttachment {
    id: string;
    kind: 'image' | 'video' | 'gif';
    url: string;
    storagePath: string | null;
    thumbnailUrl: string | null;
    mimeType: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    sizeBytes: number | null;
    name: string | null;
}

// Resolved asynchronously after a message containing a URL is already broadcast — see
// LinkPreviewService and the 'chat-message-updated' event. `url` is the final URL after
// redirects, which can differ from whatever substring the sender's text actually contained.
export interface ILinkPreview {
    url: string;
    title: string | null;
    description: string | null;
    imageUrl: string | null;
    siteName: string | null;
}

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
    attachments?: IChatAttachment[];
    linkPreview?: ILinkPreview | null;
}

// A late patch to an already-broadcast message — currently only ever carries linkPreview (the
// scrape is too slow to sit on the send path, see LinkPreviewService), but shaped as a general
// partial so a future server-side addition (e.g. a delayed video thumbnail) can reuse it instead
// of inventing another single-purpose event.
export interface IChatMessageUpdate {
    id: string;
    linkPreview?: ILinkPreview | null;
    attachments?: IChatAttachment[];
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
    // Every saved setting for this user, regardless of room — settings are per-user, not
    // per-room, so this doesn't vary by roomName. See UserSettingsService/ISaveUserSettingPayload.
    userSettings: IUserSettingRecord[];
}

export interface IUserSettingRecord {
    key: string;
    deviceId: string;
    value: unknown;
}

export interface ISaveUserSettingPayload {
    key: string;
    // '' for a setting that isn't scoped to a specific hardware device — see UserSetting.deviceId's
    // schema comment for why this is a non-null default rather than an optional/nullable field.
    deviceId: string;
    value: unknown;
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
    // Untrusted client input — room.gateway.ts's isAllowedAttachmentUrl filters this down to only
    // URLs that actually point at our own chat-media storage (or the Giphy CDN, for gif kind)
    // before anything here is persisted or broadcast to other peers.
    attachments?: IChatAttachment[];
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
