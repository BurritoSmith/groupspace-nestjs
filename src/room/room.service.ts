import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import * as mediasoup from 'mediasoup';
import { types as mediasoupTypes } from 'mediasoup';
import {
    IConsumerParams,
    IJoinRoomResult,
    IPeerState,
    IPeerSummary,
    IProducerSummary,
    StreamSource,
} from './interfaces/room.interfaces';
import { IRecordingProducerInfo, IRecordingSnapshot } from './interfaces/recording.interfaces';
import { RecordingService } from './recording.service';

const MEDIA_CODECS: mediasoupTypes.RouterRtpCodecCapability[] = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
            'x-google-start-bitrate': 1500,
            'x-google-max-bitrate': 5000,
            'x-google-min-bitrate': 300,
        },
    },
];

/**
 * Falls back to loopback-only (today's local-dev behavior) when the env vars
 * are unset. In production these are set by deploy/.env on the Compute Engine
 * VM: MEDIASOUP_LISTEN_IP=0.0.0.0, MEDIASOUP_ANNOUNCED_IP=<static IP>,
 * MEDIASOUP_MIN_PORT/MAX_PORT bound the RTP port range (must match the GCE
 * firewall rule opened for it).
 */
const LISTEN_IP = process.env.MEDIASOUP_LISTEN_IP ?? '127.0.0.1';
const ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP;
const MIN_PORT = process.env.MEDIASOUP_MIN_PORT ? Number(process.env.MEDIASOUP_MIN_PORT) : undefined;
const MAX_PORT = process.env.MEDIASOUP_MAX_PORT ? Number(process.env.MEDIASOUP_MAX_PORT) : undefined;
// The Worker's own default port range — used for ANY transport that doesn't specify its own
// explicit port/portRange, which includes RecordingService's PlainTransports (they only pass
// an ip, not a port). Without bounding this, mediasoup falls back to its library-wide default
// (a very wide range) that overlaps RECORDING_PORT_MIN/MAX (45000-45199, reserved exclusively
// for the ffmpeg-facing destination port) — causing ffmpeg's bind() to occasionally lose a race
// against a mediasoup-auto-assigned port and fail with "Address already in use". Reusing the
// same bounds as the WebRTC transports is safe: mediasoup tracks port usage across all of a
// Worker's own transports regardless of type, so they never double-bind within this shared range.
const WORKER_MIN_PORT = MIN_PORT ?? 10000;
const WORKER_MAX_PORT = MAX_PORT ?? 10199;

const TRANSPORT_LISTEN_INFOS: mediasoupTypes.TransportListenInfo[] = (['udp', 'tcp'] as const).map((protocol) => ({
    protocol,
    ip: LISTEN_IP,
    ...(ANNOUNCED_IP ? { announcedAddress: ANNOUNCED_IP } : {}),
    ...(MIN_PORT !== undefined && MAX_PORT !== undefined ? { portRange: { min: MIN_PORT, max: MAX_PORT } } : {}),
}));

@Injectable()
export class RoomService implements OnModuleInit {
    private readonly logger = new Logger(RoomService.name);
    private worker!: mediasoupTypes.Worker;
    private readonly routersByRoom = new Map<string, mediasoupTypes.Router>();
    private readonly audioLevelObserversByRoom = new Map<string, mediasoupTypes.AudioLevelObserver>();
    private readonly peers = new Map<string, IPeerState>();

    /** Notifies RoomGateway of things it needs to broadcast that aren't a direct request/response (e.g. active-speaker changes). */
    readonly events = new EventEmitter();

    constructor(private readonly recordingService: RecordingService) {}

    async onModuleInit(): Promise<void> {
        this.worker = await mediasoup.createWorker({
            logLevel: 'warn',
            rtcMinPort: WORKER_MIN_PORT,
            rtcMaxPort: WORKER_MAX_PORT,
        });
        this.worker.on('died', () => {
            this.logger.error(`mediasoup worker died (pid ${this.worker.pid}) — exiting process`);
            process.exit(1);
        });
        this.logger.log(`mediasoup worker created (pid ${this.worker.pid})`);
    }

    private async getOrCreateRouter(roomName: string): Promise<mediasoupTypes.Router> {
        const existing = this.routersByRoom.get(roomName);
        if (existing) {
            return existing;
        }
        const router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
        this.routersByRoom.set(roomName, router);
        await this.createAudioLevelObserver(roomName, router);
        return router;
    }

    /** Detects who's currently talking in a room, so the gateway can broadcast it as an "active-speakers" event. */
    private async createAudioLevelObserver(roomName: string, router: mediasoupTypes.Router): Promise<void> {
        const observer = await router.createAudioLevelObserver({ maxEntries: 8, threshold: -70, interval: 300 });
        observer.on('volumes', (volumes) => {
            const peerIds = new Set<string>();
            for (const { producer } of volumes) {
                const owner = this.findProducerOwner(producer.id);
                if (owner) {
                    peerIds.add(owner.peerId);
                }
            }
            this.events.emit('active-speakers', { roomName, peerIds: [...peerIds] });
        });
        observer.on('silence', () => {
            this.events.emit('active-speakers', { roomName, peerIds: [] });
        });
        this.audioLevelObserversByRoom.set(roomName, observer);
    }

    async joinRoom(
        peerId: string,
        roomName: string,
        userId: string,
        displayName: string,
        pictureUrl: string,
    ): Promise<Omit<IJoinRoomResult, 'iceServers' | 'userId' | 'chatHistory' | 'hasMoreChatHistory'>> {
        const router = await this.getOrCreateRouter(roomName);
        const peers: IPeerSummary[] = [];
        const existingProducers: IProducerSummary[] = [];

        for (const peer of this.peers.values()) {
            if (peer.roomName !== roomName) {
                continue;
            }
            peers.push({ peerId: peer.peerId, displayName: peer.displayName, pictureUrl: peer.pictureUrl });
            for (const { producer, source } of peer.producers.values()) {
                existingProducers.push({
                    producerId: producer.id,
                    peerId: peer.peerId,
                    displayName: peer.displayName,
                    source,
                    kind: producer.kind,
                });
            }
        }

        this.peers.set(peerId, {
            peerId,
            userId,
            displayName,
            pictureUrl,
            roomName,
            router,
            sendTransport: null,
            recvTransport: null,
            producers: new Map(),
            consumers: new Map(),
        });

        return {
            peerId,
            routerRtpCapabilities: router.rtpCapabilities,
            peers,
            existingProducers,
        };
    }

    async createTransport(peerId: string, direction: 'send' | 'recv') {
        const peer = this.requirePeer(peerId);
        const transport = await peer.router.createWebRtcTransport({
            listenInfos: TRANSPORT_LISTEN_INFOS,
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            // Starting point for WebRTC's own congestion control, which then ramps
            // real outgoing bitrate up or down from here based on measured network
            // conditions — a low start meant screen shares (esp. motion-heavy
            // content) looked poor for a while even on connections that could
            // easily sustain more. Only meaningfully affects the send transport.
            initialAvailableOutgoingBitrate: 2_500_000,
        });
        if (direction === 'send') {
            peer.sendTransport = transport;
        } else {
            peer.recvTransport = transport;
        }
        return {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
        };
    }

    async connectTransport(
        peerId: string,
        direction: 'send' | 'recv',
        dtlsParameters: mediasoupTypes.DtlsParameters,
    ): Promise<void> {
        const peer = this.requirePeer(peerId);
        const transport = direction === 'send' ? peer.sendTransport : peer.recvTransport;
        if (!transport) {
            throw new Error(`No ${direction} transport for peer ${peerId}`);
        }
        await transport.connect({ dtlsParameters });
    }

    async produce(
        peerId: string,
        kind: mediasoupTypes.MediaKind,
        rtpParameters: mediasoupTypes.RtpParameters,
        source: StreamSource,
    ): Promise<IProducerSummary> {
        const peer = this.requirePeer(peerId);
        if (!peer.sendTransport) {
            throw new Error(`No send transport for peer ${peerId}`);
        }
        const producer = await peer.sendTransport.produce({ kind, rtpParameters, appData: { source } });
        peer.producers.set(producer.id, { producer, source });
        if (source === 'mic') {
            await this.audioLevelObserversByRoom.get(peer.roomName)?.addProducer({ producerId: producer.id });
            this.recordingService.notifyMicProducersChanged(peer.roomName, peer.router, this.getActiveMicProducers(peer.roomName));
        } else {
            this.recordingService.notifyProducerCreated(peer.roomName, peer.router, {
                producerId: producer.id,
                peerId: peer.peerId,
                userId: peer.userId,
                displayName: peer.displayName,
                source,
            });
        }
        return {
            producerId: producer.id,
            peerId: peer.peerId,
            displayName: peer.displayName,
            source,
            kind,
        };
    }

    async consume(peerId: string, producerId: string, rtpCapabilities: mediasoupTypes.RtpCapabilities): Promise<IConsumerParams> {
        const peer = this.requirePeer(peerId);
        if (!peer.recvTransport) {
            throw new Error(`No recv transport for peer ${peerId}`);
        }
        if (!peer.router.canConsume({ producerId, rtpCapabilities })) {
            throw new Error(`Peer ${peerId} cannot consume producer ${producerId} (incompatible rtpCapabilities)`);
        }
        const producerOwner = this.findProducerOwner(producerId);
        const consumer = await peer.recvTransport.consume({
            producerId,
            rtpCapabilities,
            paused: true,
        });
        peer.consumers.set(consumer.id, consumer);
        return {
            id: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            source: (producerOwner?.source ?? 'webcam'),
            peerId: producerOwner?.peerId ?? '',
            displayName: producerOwner?.displayName ?? '',
        };
    }

    async resumeConsumer(peerId: string, consumerId: string): Promise<void> {
        const peer = this.requirePeer(peerId);
        const consumer = peer.consumers.get(consumerId);
        if (!consumer) {
            throw new Error(`No consumer ${consumerId} for peer ${peerId}`);
        }
        await consumer.resume();
    }

    /** Closes one producer the peer voluntarily stopped (not a disconnect); returns info the gateway needs to notify the room. */
    closeProducer(peerId: string, producerId: string): { roomName: string } | null {
        const peer = this.peers.get(peerId);
        if (!peer) {
            return null;
        }
        const record = peer.producers.get(producerId);
        if (!record) {
            return null;
        }
        peer.producers.delete(producerId);
        if (record.source === 'mic') {
            this.recordingService.notifyMicProducersChanged(peer.roomName, peer.router, this.getActiveMicProducers(peer.roomName));
        } else {
            this.recordingService.notifyProducerClosing(peer.roomName, producerId);
        }
        record.producer.close();
        return { roomName: peer.roomName };
    }

    /** Tears down everything owned by a disconnecting peer; returns info the gateway needs to notify the room. */
    closePeer(peerId: string): { roomName: string; displayName: string; removedProducerIds: string[] } | null {
        const peer = this.peers.get(peerId);
        if (!peer) {
            return null;
        }
        const removedProducerIds = [...peer.producers.keys()];
        const hadMic = [...peer.producers.values()].some((record) => record.source === 'mic');
        const videoProducerIds = [...peer.producers.values()]
            .filter((record) => record.source !== 'mic')
            .map((record) => record.producer.id);
        this.peers.delete(peerId);
        for (const producerId of videoProducerIds) {
            this.recordingService.notifyProducerClosing(peer.roomName, producerId);
        }
        if (hadMic) {
            this.recordingService.notifyMicProducersChanged(peer.roomName, peer.router, this.getActiveMicProducers(peer.roomName));
        }
        if (![...this.peers.values()].some((p) => p.roomName === peer.roomName)) {
            void this.recordingService.stop(peer.roomName);
        }
        peer.sendTransport?.close();
        peer.recvTransport?.close();
        return { roomName: peer.roomName, displayName: peer.displayName, removedProducerIds };
    }

    /** Snapshot of a room's router + every currently active producer, handed to RecordingService.start(). */
    getRecordingSnapshot(roomName: string): IRecordingSnapshot | null {
        const router = this.routersByRoom.get(roomName);
        if (!router) {
            return null;
        }
        const producers: IRecordingProducerInfo[] = [];
        for (const peer of this.peers.values()) {
            if (peer.roomName !== roomName) {
                continue;
            }
            for (const { producer, source } of peer.producers.values()) {
                producers.push({ producerId: producer.id, peerId: peer.peerId, userId: peer.userId, displayName: peer.displayName, source });
            }
        }
        return { router, producers };
    }

    private getActiveMicProducers(roomName: string): IRecordingProducerInfo[] {
        const result: IRecordingProducerInfo[] = [];
        for (const peer of this.peers.values()) {
            if (peer.roomName !== roomName) {
                continue;
            }
            for (const { producer, source } of peer.producers.values()) {
                if (source === 'mic') {
                    result.push({ producerId: producer.id, peerId: peer.peerId, userId: peer.userId, displayName: peer.displayName, source });
                }
            }
        }
        return result;
    }

    private findProducerOwner(producerId: string): { peerId: string; displayName: string; source: StreamSource } | null {
        for (const peer of this.peers.values()) {
            const record = peer.producers.get(producerId);
            if (record) {
                return { peerId: peer.peerId, displayName: peer.displayName, source: record.source };
            }
        }
        return null;
    }

    private requirePeer(peerId: string): IPeerState {
        const peer = this.peers.get(peerId);
        if (!peer) {
            throw new Error(`Unknown peer ${peerId} — did you join-room first?`);
        }
        return peer;
    }
}
