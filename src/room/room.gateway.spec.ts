import { RoomGateway } from './room.gateway';

describe('RoomGateway', () => {
    let gateway: RoomGateway;
    let emitSpy: jest.Mock;
    let toSpy: jest.Mock;

    beforeEach(() => {
        const fakeEventEmitter = { events: { on: jest.fn() } };
        gateway = new RoomGateway(
            fakeEventEmitter as never, // roomService
            {} as never, // turnCredentialsService
            {} as never, // googleAuthService
            fakeEventEmitter as never, // recordingService
            {} as never, // usersService
            {} as never, // chatService
            {} as never, // sessionService
        );
        emitSpy = jest.fn();
        toSpy = jest.fn().mockReturnValue({ emit: emitSpy });
    });

    function fakeSocket(data: Record<string, unknown>) {
        return { id: 'peer-1', data, to: toSpy } as never;
    }

    describe('onUserTyping', () => {
        it('broadcasts to the room via socket.to (excluding the sender), not this.server.to', () => {
            gateway.onUserTyping(fakeSocket({ roomName: 'lobby', displayName: 'Clay Crosland' }));

            expect(toSpy).toHaveBeenCalledWith('lobby');
            expect(emitSpy).toHaveBeenCalledWith('user-typing', { peerId: 'peer-1', displayName: 'Clay Crosland' });
        });

        it('falls back to "Anonymous" when displayName is missing', () => {
            gateway.onUserTyping(fakeSocket({ roomName: 'lobby' }));

            expect(emitSpy).toHaveBeenCalledWith('user-typing', { peerId: 'peer-1', displayName: 'Anonymous' });
        });

        it('does nothing when the socket has no roomName (not in a room)', () => {
            gateway.onUserTyping(fakeSocket({}));

            expect(toSpy).not.toHaveBeenCalled();
        });
    });

    describe('onUserStoppedTyping', () => {
        it('broadcasts to the room via socket.to', () => {
            gateway.onUserStoppedTyping(fakeSocket({ roomName: 'lobby' }));

            expect(toSpy).toHaveBeenCalledWith('lobby');
            expect(emitSpy).toHaveBeenCalledWith('user-stopped-typing', { peerId: 'peer-1' });
        });

        it('does nothing when the socket has no roomName', () => {
            gateway.onUserStoppedTyping(fakeSocket({}));

            expect(toSpy).not.toHaveBeenCalled();
        });
    });
});
