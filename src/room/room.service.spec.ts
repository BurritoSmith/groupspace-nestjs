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
