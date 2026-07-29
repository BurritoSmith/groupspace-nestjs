import { RoomGateway } from './room.gateway';

describe('RoomGateway', () => {
    let gateway: RoomGateway;
    let emitSpy: jest.Mock;
    let toSpy: jest.Mock;
    let fakeRoomService: { events: { on: jest.Mock }; setMicSelfMuted: jest.Mock; setConsumerQuality: jest.Mock; closePeer: jest.Mock };
    let fakeChatService: { saveMessage: jest.Mock };
    let fakeUserSettingsService: { save: jest.Mock; getAll: jest.Mock };

    beforeEach(() => {
        const fakeEventEmitter = { events: { on: jest.fn() } };
        fakeRoomService = { events: { on: jest.fn() }, setMicSelfMuted: jest.fn(), setConsumerQuality: jest.fn(), closePeer: jest.fn() };
        fakeChatService = { saveMessage: jest.fn() };
        fakeUserSettingsService = { save: jest.fn().mockResolvedValue(undefined), getAll: jest.fn().mockResolvedValue([]) };
        gateway = new RoomGateway(
            fakeRoomService as never, // roomService
            {} as never, // turnCredentialsService
            {} as never, // googleAuthService
            fakeEventEmitter as never, // recordingService
            {} as never, // usersService
            fakeUserSettingsService as never, // userSettingsService
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
        return { id: 'peer-1', data, to: toSpy, join: jest.fn().mockResolvedValue(undefined), leave: jest.fn().mockResolvedValue(undefined) } as never;
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

    describe('onSaveUserSetting', () => {
        it("saves via UserSettingsService using the userId from socket.data, and acks {ok: true}", async () => {
            const result = await gateway.onSaveUserSetting(fakeSocket({ userId: 'user-1' }), {
                key: 'mic-threshold',
                deviceId: 'device-1',
                value: 30,
            });

            expect(fakeUserSettingsService.save).toHaveBeenCalledWith('user-1', 'mic-threshold', 'device-1', 30);
            expect(result).toEqual({ ok: true });
        });

        it('acks {ok: false} without touching the service when the socket has no userId (not signed in)', async () => {
            const result = await gateway.onSaveUserSetting(fakeSocket({}), { key: 'mic-threshold', deviceId: 'device-1', value: 30 });

            expect(fakeUserSettingsService.save).not.toHaveBeenCalled();
            expect(result).toEqual({ ok: false, error: 'Not signed in.' });
        });

        it('acks {ok: false, error} instead of throwing when the service rejects', async () => {
            fakeUserSettingsService.save.mockRejectedValue(new Error('DB unavailable'));

            const result = await gateway.onSaveUserSetting(fakeSocket({ userId: 'user-1' }), {
                key: 'mic-threshold',
                deviceId: 'device-1',
                value: 30,
            });

            expect(result).toEqual({ ok: false, error: 'DB unavailable' });
        });
    });

    describe('cleanupPeer (via onLeaveRoom)', () => {
        it("logs a 'leave' RecordingEvent when a recording is active for the peer's room", () => {
            fakeRoomService.closePeer = jest
                .fn()
                .mockReturnValue({ roomName: 'lobby', displayName: 'Alice', userId: 'user-1', removedProducerIds: [] });
            const fakeRecordingService = { events: { on: jest.fn() }, getActiveSessionId: jest.fn().mockReturnValue('session-1'), logEvent: jest.fn() };
            const localGateway = new RoomGateway(
                fakeRoomService as never,
                {} as never,
                {} as never,
                fakeRecordingService as never,
                {} as never,
                fakeUserSettingsService as never,
                fakeChatService as never,
                {} as never,
            );

            localGateway.onLeaveRoom(fakeSocket({}));

            expect(fakeRecordingService.logEvent).toHaveBeenCalledWith('session-1', 'leave', 'peer-1', 'user-1', 'Alice');
        });

        it("does not log an event when no recording is active for the peer's room", () => {
            fakeRoomService.closePeer = jest
                .fn()
                .mockReturnValue({ roomName: 'lobby', displayName: 'Alice', userId: 'user-1', removedProducerIds: [] });
            const fakeRecordingService = { events: { on: jest.fn() }, getActiveSessionId: jest.fn().mockReturnValue(null), logEvent: jest.fn() };
            const localGateway = new RoomGateway(
                fakeRoomService as never,
                {} as never,
                {} as never,
                fakeRecordingService as never,
                {} as never,
                fakeUserSettingsService as never,
                fakeChatService as never,
                {} as never,
            );

            localGateway.onLeaveRoom(fakeSocket({}));

            expect(fakeRecordingService.logEvent).not.toHaveBeenCalled();
        });
    });

    describe('onStartRecording — join-event snapshot', () => {
        function buildGateway() {
            const localRoomService = {
                events: { on: jest.fn() },
                getRecordingSnapshot: jest.fn().mockReturnValue({ router: {}, producers: [] }),
                getPeersInRoom: jest.fn().mockReturnValue([
                    { peerId: 'peer-1', userId: 'user-1', displayName: 'Alice' },
                    { peerId: 'peer-2', userId: 'user-2', displayName: 'Bob' },
                ]),
            };
            const fakeRecordingService = {
                events: { on: jest.fn() },
                start: jest.fn().mockResolvedValue(undefined),
                getActiveSessionId: jest.fn().mockReturnValue('session-1'),
                logEvent: jest.fn(),
            };
            const localGateway = new RoomGateway(
                localRoomService as never,
                {} as never,
                {} as never,
                fakeRecordingService as never,
                {} as never,
                fakeUserSettingsService as never,
                fakeChatService as never,
                {} as never,
            );
            return { localGateway, localRoomService, fakeRecordingService };
        }

        it("logs a 'join' event for every peer already in the room the instant recording starts", async () => {
            const { localGateway, fakeRecordingService } = buildGateway();

            const result = await localGateway.onStartRecording(fakeSocket({ roomName: 'lobby' }));

            expect(result).toEqual({ ok: true });
            expect(fakeRecordingService.logEvent).toHaveBeenCalledWith('session-1', 'join', 'peer-1', 'user-1', 'Alice');
            expect(fakeRecordingService.logEvent).toHaveBeenCalledWith('session-1', 'join', 'peer-2', 'user-2', 'Bob');
            expect(fakeRecordingService.logEvent).toHaveBeenCalledTimes(2);
        });

        it('does not log anything when starting fails (no active session to attribute events to)', async () => {
            const { localGateway, fakeRecordingService } = buildGateway();
            fakeRecordingService.getActiveSessionId.mockReturnValue(null);

            await localGateway.onStartRecording(fakeSocket({ roomName: 'lobby' }));

            expect(fakeRecordingService.logEvent).not.toHaveBeenCalled();
        });
    });

    describe('onGetRecordingSession', () => {
        it('merges chatHistory (fetched via ChatService, scoped to the session window) into the returned session', async () => {
            const session = {
                id: 'session-1',
                name: 'Test Session',
                roomName: 'lobby',
                startedAt: '2026-07-28T12:00:00.000Z',
                stoppedAt: '2026-07-28T13:00:00.000Z',
                recordings: [],
                events: [],
                chatHistory: [],
            };
            const fakeRecordingService = { events: { on: jest.fn() }, getSessionDetail: jest.fn().mockResolvedValue(session) };
            const chatHistory = [{ id: 'msg-1', userId: 'user-1', displayName: 'Alice', pictureUrl: '', text: 'hi', at: '2026-07-28T12:05:00.000Z' }];
            const localChatService = { saveMessage: jest.fn(), getHistoryForSession: jest.fn().mockResolvedValue(chatHistory) };
            const localGateway = new RoomGateway(
                fakeRoomService as never,
                {} as never,
                {} as never,
                fakeRecordingService as never,
                {} as never,
                fakeUserSettingsService as never,
                localChatService as never,
                {} as never,
            );

            const result = await localGateway.onGetRecordingSession({ id: 'session-1' });

            expect(localChatService.getHistoryForSession).toHaveBeenCalledWith(
                'lobby',
                new Date('2026-07-28T12:00:00.000Z'),
                new Date('2026-07-28T13:00:00.000Z'),
            );
            expect(result).toEqual({ session: { ...session, chatHistory } });
        });

        it('returns { session: null } without touching ChatService when the session does not exist', async () => {
            const fakeRecordingService = { events: { on: jest.fn() }, getSessionDetail: jest.fn().mockResolvedValue(null) };
            const localChatService = { saveMessage: jest.fn(), getHistoryForSession: jest.fn() };
            const localGateway = new RoomGateway(
                fakeRoomService as never,
                {} as never,
                {} as never,
                fakeRecordingService as never,
                {} as never,
                fakeUserSettingsService as never,
                localChatService as never,
                {} as never,
            );

            const result = await localGateway.onGetRecordingSession({ id: 'missing' });

            expect(localChatService.getHistoryForSession).not.toHaveBeenCalled();
            expect(result).toEqual({ session: null });
        });
    });

    describe('onJoinRoom — recording-event logging', () => {
        function buildGateway(activeSessionId: string | null) {
            const fakeRecordingService = {
                events: { on: jest.fn() },
                getActiveSessionId: jest.fn().mockReturnValue(activeSessionId),
                logEvent: jest.fn(),
            };
            const fakeSessionService = { verify: jest.fn().mockReturnValue({ userId: 'user-1' }), issue: jest.fn().mockReturnValue('token-1') };
            const fakeUsersService = { findById: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Alice', pictureUrl: 'pic' }) };
            const localRoomService = {
                events: { on: jest.fn() },
                joinRoom: jest.fn().mockResolvedValue({ peerId: 'peer-1', peers: [], existingProducers: [], routerRtpCapabilities: {} }),
            };
            const localChatService = { saveMessage: jest.fn(), getRecentHistory: jest.fn().mockResolvedValue([]) };
            const fakeTurnCredentialsService = { generateFor: jest.fn().mockReturnValue(null) };
            const localUserSettingsService = { save: jest.fn(), getAll: jest.fn().mockResolvedValue([]) };
            const localGateway = new RoomGateway(
                localRoomService as never,
                fakeTurnCredentialsService as never,
                {} as never,
                fakeRecordingService as never,
                fakeUsersService as never,
                localUserSettingsService as never,
                localChatService as never,
                fakeSessionService as never,
            );
            return { localGateway, fakeRecordingService };
        }

        it("logs a 'join' RecordingEvent when a recording is active for the room being joined", async () => {
            const { localGateway, fakeRecordingService } = buildGateway('session-1');

            await localGateway.onJoinRoom(fakeSocket({}), { roomName: 'lobby', sessionToken: 'existing-token' });

            expect(fakeRecordingService.logEvent).toHaveBeenCalledWith('session-1', 'join', 'peer-1', 'user-1', 'Alice');
        });

        it('does not log an event when no recording is active for the room being joined', async () => {
            const { localGateway, fakeRecordingService } = buildGateway(null);

            await localGateway.onJoinRoom(fakeSocket({}), { roomName: 'lobby', sessionToken: 'existing-token' });

            expect(fakeRecordingService.logEvent).not.toHaveBeenCalled();
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
