import { RoomGateway } from './room.gateway';

describe('RoomGateway', () => {
    let gateway: RoomGateway;
    let emitSpy: jest.Mock;
    let toSpy: jest.Mock;
    let fakeRoomService: { events: { on: jest.Mock }; setMicSelfMuted: jest.Mock; setConsumerQuality: jest.Mock };
    let fakeChatService: { saveMessage: jest.Mock };

    beforeEach(() => {
        const fakeEventEmitter = { events: { on: jest.fn() } };
        fakeRoomService = { events: { on: jest.fn() }, setMicSelfMuted: jest.fn(), setConsumerQuality: jest.fn() };
        fakeChatService = { saveMessage: jest.fn() };
        gateway = new RoomGateway(
            fakeRoomService as never, // roomService
            {} as never, // turnCredentialsService
            {} as never, // googleAuthService
            fakeEventEmitter as never, // recordingService
            {} as never, // usersService
            fakeChatService as never, // chatService
            {} as never, // sessionService
        );
        emitSpy = jest.fn();
        toSpy = jest.fn().mockReturnValue({ emit: emitSpy });
        // onChatMessage broadcasts via this.server.to() (unlike socket.to() used everywhere else
        // in this file) — @WebSocketServer() only wires this up via Nest's DI at runtime, so a
        // plain `new RoomGateway(...)` here needs it set by hand.
        (gateway as unknown as { server: { to: jest.Mock } }).server = { to: toSpy };
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

    describe('onMicMuteChanged', () => {
        it('records the mute state via roomService and broadcasts to the returned roomName', () => {
            fakeRoomService.setMicSelfMuted.mockReturnValue({ roomName: 'lobby' });

            gateway.onMicMuteChanged(fakeSocket({}), { muted: true });

            expect(fakeRoomService.setMicSelfMuted).toHaveBeenCalledWith('peer-1', true);
            expect(toSpy).toHaveBeenCalledWith('lobby');
            expect(emitSpy).toHaveBeenCalledWith('mic-mute-changed', { peerId: 'peer-1', muted: true });
        });

        it('does nothing when roomService reports the peer is unknown', () => {
            fakeRoomService.setMicSelfMuted.mockReturnValue(null);

            gateway.onMicMuteChanged(fakeSocket({}), { muted: true });

            expect(toSpy).not.toHaveBeenCalled();
        });
    });

    describe('onSetConsumerQuality', () => {
        it('resolves with { ok: true } after routing through roomService', async () => {
            fakeRoomService.setConsumerQuality.mockResolvedValue(undefined);

            const result = await gateway.onSetConsumerQuality(fakeSocket({}), { consumerId: 'consumer-1', quality: 'high' });

            expect(fakeRoomService.setConsumerQuality).toHaveBeenCalledWith('peer-1', 'consumer-1', 'high');
            expect(result).toEqual({ ok: true });
        });

        it('resolves with { ok: false, error } instead of throwing when roomService rejects', async () => {
            fakeRoomService.setConsumerQuality.mockRejectedValue(new Error('No consumer consumer-1 for peer peer-1'));

            const result = await gateway.onSetConsumerQuality(fakeSocket({}), { consumerId: 'consumer-1', quality: 'high' });

            expect(result).toEqual({ ok: false, error: 'No consumer consumer-1 for peer peer-1' });
        });
    });

    describe('onChatMessage', () => {
        // Regression coverage: pictureUrl is carried on socket.data (set in onJoinRoom) so a
        // message snapshots the sender's avatar at send-time, the same way displayName already
        // does — see IChatMessage.pictureUrl's comment.
        it('includes the sender\'s pictureUrl (from socket.data) in both the broadcast and the persisted row', () => {
            gateway.onChatMessage(fakeSocket({ roomName: 'lobby', userId: 'user-1', displayName: 'Clay', pictureUrl: 'https://pic' }), {
                text: 'hello',
            });

            expect(toSpy).toHaveBeenCalledWith('lobby');
            expect(emitSpy).toHaveBeenCalledWith('chat-message', expect.objectContaining({ pictureUrl: 'https://pic' }));
            expect(fakeChatService.saveMessage).toHaveBeenCalledWith(
                expect.any(String),
                'lobby',
                'user-1',
                'Clay',
                'https://pic',
                'hello',
                expect.any(Date),
            );
        });

        it('falls back to an empty string when socket.data has no pictureUrl', () => {
            gateway.onChatMessage(fakeSocket({ roomName: 'lobby', userId: 'user-1', displayName: 'Clay' }), { text: 'hello' });

            expect(emitSpy).toHaveBeenCalledWith('chat-message', expect.objectContaining({ pictureUrl: '' }));
        });
    });

    describe('normalizeRoomName', () => {
        const call = (raw: string | undefined) =>
            (gateway as unknown as { normalizeRoomName: (raw: string | undefined) => string }).normalizeRoomName(raw);

        it('lowercases mixed-case input', () => {
            expect(call('MyRoom')).toBe('myroom');
        });

        it('trims surrounding whitespace', () => {
            expect(call('  myroom  ')).toBe('myroom');
        });

        it('throws for undefined input', () => {
            expect(() => call(undefined)).toThrow('A room name is required.');
        });

        it('throws for empty/whitespace-only input', () => {
            expect(() => call('')).toThrow('A room name is required.');
            expect(() => call('   ')).toThrow('A room name is required.');
        });
    });
});
