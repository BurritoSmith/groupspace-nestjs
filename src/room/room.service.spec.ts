import { RoomService } from './room.service';
import { IPeerState } from './interfaces/room.interfaces';

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
});
