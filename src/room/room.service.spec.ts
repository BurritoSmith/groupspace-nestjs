import { RoomService } from './room.service';
import { IPeerState } from './interfaces/room.interfaces';

function seedRouter(target: RoomService, roomName: string): void {
    // getOrCreateRouter() returns whatever's already in routersByRoom before touching the
    // mediasoup worker, so pre-seeding it here lets joinRoom() be tested without a real worker.
    const routersByRoom = (target as unknown as { routersByRoom: Map<string, unknown> }).routersByRoom;
    routersByRoom.set(roomName, { rtpCapabilities: {} });
}

describe('RoomService', () => {
    let service: RoomService;

    beforeEach(() => {
        service = new RoomService({} as never); // RecordingService — untouched by the methods under test
    });

    describe('setMicSelfMuted', () => {
        function seedPeer(peerId: string, roomName: string): void {
            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            peers.set(peerId, {
                peerId,
                userId: 'user-1',
                displayName: 'Clay',
                pictureUrl: '',
                micSelfMuted: false,
                roomName,
                router: {} as never,
                sendTransport: null,
                recvTransport: null,
                producers: new Map(),
                consumers: new Map(),
            });
        }

        it('sets the flag and returns the peer\'s roomName when the peer exists', () => {
            seedPeer('peer-1', 'lobby');

            const result = service.setMicSelfMuted('peer-1', true);

            expect(result).toEqual({ roomName: 'lobby' });
            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            expect(peers.get('peer-1')?.micSelfMuted).toBe(true);
        });

        it('can flip the flag back to false', () => {
            seedPeer('peer-1', 'lobby');
            service.setMicSelfMuted('peer-1', true);

            service.setMicSelfMuted('peer-1', false);

            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            expect(peers.get('peer-1')?.micSelfMuted).toBe(false);
        });

        it('returns null and touches nothing when the peer is unknown', () => {
            const result = service.setMicSelfMuted('nonexistent-peer', true);

            expect(result).toBeNull();
        });
    });

    describe('consume', () => {
        function seedConsumingPeer(consumeMock: jest.Mock): void {
            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            peers.set('viewer-1', {
                peerId: 'viewer-1',
                userId: 'user-1',
                displayName: 'Viewer',
                pictureUrl: '',
                micSelfMuted: false,
                roomName: 'lobby',
                router: { canConsume: () => true } as never,
                sendTransport: null,
                recvTransport: { consume: consumeMock } as never,
                producers: new Map(),
                consumers: new Map(),
            });
        }

        it('defaults a freshly-created video consumer to the lowest simulcast layer', async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            const consumeMock = jest.fn().mockResolvedValue({ id: 'consumer-1', kind: 'video', rtpParameters: {}, setPreferredLayers });
            seedConsumingPeer(consumeMock);

            await service.consume('viewer-1', 'producer-1', {} as never);

            expect(setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 0 });
        });

        it('does not touch layers for an audio consumer', async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            const consumeMock = jest.fn().mockResolvedValue({ id: 'consumer-1', kind: 'audio', rtpParameters: {}, setPreferredLayers });
            seedConsumingPeer(consumeMock);

            await service.consume('viewer-1', 'producer-1', {} as never);

            expect(setPreferredLayers).not.toHaveBeenCalled();
        });
    });

    describe('setConsumerQuality', () => {
        function seedPeerWithConsumer(consumer: { kind: 'video' | 'audio'; producerId: string; setPreferredLayers: jest.Mock }): void {
            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            const consumers = new Map([['consumer-1', consumer as never]]);
            peers.set('viewer-1', {
                peerId: 'viewer-1',
                userId: 'user-1',
                displayName: 'Viewer',
                pictureUrl: '',
                micSelfMuted: false,
                roomName: 'lobby',
                router: {} as never,
                sendTransport: null,
                recvTransport: null,
                producers: new Map(),
                consumers,
            });
        }

        /** Seeds the producer-owning peer (a *different* peer than the one consuming it — mirrors
         *  the real topology) so findProducer() inside setConsumerQuality() can resolve its
         *  negotiated encodings. */
        function seedOwningPeer(producerId: string, encodingsLength: number): void {
            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            peers.set('publisher-1', {
                peerId: 'publisher-1',
                userId: 'user-2',
                displayName: 'Publisher',
                pictureUrl: '',
                micSelfMuted: false,
                roomName: 'lobby',
                router: {} as never,
                sendTransport: null,
                recvTransport: null,
                producers: new Map([
                    [
                        producerId,
                        {
                            source: 'screen',
                            producer: { rtpParameters: { encodings: Array.from({ length: encodingsLength }) } } as never,
                        },
                    ],
                ]),
                consumers: new Map(),
            });
        }

        it("resolves 'high' to the producer's own highest negotiated layer index", async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            seedPeerWithConsumer({ kind: 'video', producerId: 'producer-1', setPreferredLayers });
            seedOwningPeer('producer-1', 2); // 2-layer simulcast — highest index is 1

            await service.setConsumerQuality('viewer-1', 'consumer-1', 'high');

            expect(setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 1 });
        });

        it("resolves 'low' to spatial layer 0 regardless of the producer's layer count", async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            seedPeerWithConsumer({ kind: 'video', producerId: 'producer-1', setPreferredLayers });
            seedOwningPeer('producer-1', 2);

            await service.setConsumerQuality('viewer-1', 'consumer-1', 'low');

            expect(setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 0 });
        });

        it('is a no-op for an audio consumer', async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            seedPeerWithConsumer({ kind: 'audio', producerId: 'producer-1', setPreferredLayers });

            await service.setConsumerQuality('viewer-1', 'consumer-1', 'high');

            expect(setPreferredLayers).not.toHaveBeenCalled();
        });

        it('falls back to spatial layer 0 for \'high\' if the owning producer can no longer be found', async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            seedPeerWithConsumer({ kind: 'video', producerId: 'producer-1', setPreferredLayers });
            // No seedOwningPeer() call — producer genuinely gone (e.g. closed moments earlier).

            await service.setConsumerQuality('viewer-1', 'consumer-1', 'high');

            expect(setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 0 });
        });

        it('throws for an unknown consumerId', async () => {
            seedPeerWithConsumer({ kind: 'video', producerId: 'producer-1', setPreferredLayers: jest.fn() });

            await expect(service.setConsumerQuality('viewer-1', 'nonexistent-consumer', 'high')).rejects.toThrow(
                'No consumer nonexistent-consumer for peer viewer-1',
            );
        });
    });

    describe('joinRoom', () => {
        // Regression coverage: chat messages carry userId but not peerId/pictureUrl, and the
        // roster (peers) carried peerId/pictureUrl but not userId — no join key between them for
        // the frontend to look up a message sender's avatar. userId closes that gap.
        it("includes each existing peer's userId in the returned roster", async () => {
            seedRouter(service, 'lobby');
            await service.joinRoom('peer-1', 'lobby', 'user-1', 'Clay', 'https://pic-1');

            const result = await service.joinRoom('peer-2', 'lobby', 'user-2', 'Burr', 'https://pic-2');

            expect(result.peers).toEqual([{ peerId: 'peer-1', userId: 'user-1', displayName: 'Clay', pictureUrl: 'https://pic-1', micSelfMuted: false }]);
        });
    });
});
