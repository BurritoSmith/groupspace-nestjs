import { RoomGateway } from './room.gateway';

describe('RoomGateway', () => {
    let gateway: RoomGateway;
    let emitSpy: jest.Mock;
    let toSpy: jest.Mock;
    let fakeRoomService: { events: { on: jest.Mock }; setMicSelfMuted: jest.Mock; setConsumerQuality: jest.Mock; closePeer: jest.Mock };
    let fakeChatService: { saveMessage: jest.Mock; updateLinkPreview: jest.Mock; softDelete: jest.Mock };
    let fakeUserSettingsService: { save: jest.Mock; getAll: jest.Mock };
    let fakeChatMediaService: { publicBase: string };
    let fakeLinkPreviewService: { fetchPreview: jest.Mock };
    let fakeChatReactionService: { toggle: jest.Mock; listGrouped: jest.Mock };

    beforeEach(() => {
        const fakeEventEmitter = { events: { on: jest.fn() } };
        fakeRoomService = { events: { on: jest.fn() }, setMicSelfMuted: jest.fn(), setConsumerQuality: jest.fn(), closePeer: jest.fn() };
        fakeChatService = { saveMessage: jest.fn(), updateLinkPreview: jest.fn().mockResolvedValue(undefined), softDelete: jest.fn().mockResolvedValue(true) };
        fakeUserSettingsService = { save: jest.fn().mockResolvedValue(undefined), getAll: jest.fn().mockResolvedValue([]) };
        fakeChatMediaService = { publicBase: 'https://storage.googleapis.com/test-chat-media-bucket/' };
        // Defaults to "no preview" so every existing message test is unaffected by the scrape that
        // now fires alongside them.
        fakeLinkPreviewService = { fetchPreview: jest.fn().mockResolvedValue(null) };
        fakeChatReactionService = { toggle: jest.fn().mockResolvedValue(undefined), listGrouped: jest.fn().mockResolvedValue([]) };
        gateway = new RoomGateway(
            fakeRoomService as never, // roomService
            {} as never, // turnCredentialsService
            {} as never, // googleAuthService
            fakeEventEmitter as never, // recordingService
            {} as never, // usersService
            fakeUserSettingsService as never, // userSettingsService
            fakeChatService as never, // chatService
            {} as never, // sessionService
            fakeChatMediaService as never, // chatMediaService
            fakeLinkPreviewService as never, // linkPreviewService
            fakeChatReactionService as never, // chatReactionService
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
                [],
            );
        });

        it('falls back to an empty string when socket.data has no pictureUrl', () => {
            gateway.onChatMessage(fakeSocket({ roomName: 'lobby', userId: 'user-1', displayName: 'Clay' }), { text: 'hello' });

            expect(emitSpy).toHaveBeenCalledWith('chat-message', expect.objectContaining({ pictureUrl: '' }));
        });

        it('does nothing when text is blank and there are no attachments', () => {
            gateway.onChatMessage(fakeSocket({ roomName: 'lobby', userId: 'user-1' }), { text: '   ' });

            expect(toSpy).not.toHaveBeenCalled();
            expect(fakeChatService.saveMessage).not.toHaveBeenCalled();
        });

        it('sends an attachment-only message (blank text) as long as at least one attachment survives sanitization', () => {
            gateway.onChatMessage(fakeSocket({ roomName: 'lobby', userId: 'user-1', displayName: 'Clay' }), {
                text: '',
                attachments: [
                    {
                        id: 'att-1',
                        kind: 'image',
                        url: 'https://storage.googleapis.com/test-chat-media-bucket/lobby/2026/07/photo.jpg',
                        storagePath: 'lobby/2026/07/photo.jpg',
                        thumbnailUrl: null,
                        mimeType: 'image/jpeg',
                        width: 800,
                        height: 600,
                        durationMs: null,
                        sizeBytes: 12345,
                        name: 'photo.jpg',
                    },
                ],
            });

            expect(emitSpy).toHaveBeenCalledWith(
                'chat-message',
                expect.objectContaining({ text: '', attachments: [expect.objectContaining({ id: 'att-1' })] }),
            );
        });

        it("drops an attachment whose URL doesn't resolve to our own chat-media storage or the Giphy CDN", () => {
            gateway.onChatMessage(fakeSocket({ roomName: 'lobby', userId: 'user-1', displayName: 'Clay' }), {
                text: 'look at this',
                attachments: [
                    {
                        id: 'att-1',
                        kind: 'image',
                        url: 'https://evil.example.com/tracker.png',
                        storagePath: null,
                        thumbnailUrl: null,
                        mimeType: 'image/png',
                        width: null,
                        height: null,
                        durationMs: null,
                        sizeBytes: null,
                        name: null,
                    },
                ],
            });

            const broadcast = emitSpy.mock.calls.find((call) => call[0] === 'chat-message')?.[1];
            expect(broadcast.attachments).toBeUndefined();
            expect(broadcast.text).toBe('look at this');
        });

        it('allows a gif attachment hotlinked from the Giphy CDN even though it never touched our own storage', () => {
            gateway.onChatMessage(fakeSocket({ roomName: 'lobby', userId: 'user-1', displayName: 'Clay' }), {
                text: '',
                attachments: [
                    {
                        id: 'att-1',
                        kind: 'gif',
                        url: 'https://media3.giphy.com/media/abc123/giphy.gif',
                        storagePath: null,
                        thumbnailUrl: null,
                        mimeType: 'image/gif',
                        width: 200,
                        height: 200,
                        durationMs: null,
                        sizeBytes: null,
                        name: null,
                    },
                ],
            });

            const broadcast = emitSpy.mock.calls.find((call) => call[0] === 'chat-message')?.[1];
            expect(broadcast.attachments).toHaveLength(1);
        });

        it('clamps an absurd client-supplied width/height rather than passing them through unchecked', () => {
            gateway.onChatMessage(fakeSocket({ roomName: 'lobby', userId: 'user-1', displayName: 'Clay' }), {
                text: '',
                attachments: [
                    {
                        id: 'att-1',
                        kind: 'image',
                        url: 'https://storage.googleapis.com/test-chat-media-bucket/lobby/2026/07/photo.jpg',
                        storagePath: 'lobby/2026/07/photo.jpg',
                        thumbnailUrl: null,
                        mimeType: 'image/jpeg',
                        width: 99999999,
                        height: -5,
                        durationMs: null,
                        sizeBytes: null,
                        name: null,
                    },
                ],
            });

            const broadcast = emitSpy.mock.calls.find((call) => call[0] === 'chat-message')?.[1];
            expect(broadcast.attachments[0].width).toBeLessThanOrEqual(8000);
            expect(broadcast.attachments[0].height).toBeNull();
        });

        // Asserts on the BROADCAST rather than on the object the sender handed us: sanitizeAttachment
        // rebuilds each attachment field-by-field, so a field it doesn't know about vanishes on the
        // way out with nothing logged. The sender's own optimistic copy still shows the album, so
        // this only ever breaks for everyone else — exactly the kind of thing no one notices locally.
        it('carries albumId through to the broadcast so an album groups for every peer, not just the sender', () => {
            const albumAttachment = (id: string) => ({
                id,
                kind: 'image' as const,
                url: `https://storage.googleapis.com/test-chat-media-bucket/lobby/2026/08/${id}.jpg`,
                storagePath: `lobby/2026/08/${id}.jpg`,
                thumbnailUrl: null,
                mimeType: 'image/jpeg',
                width: 800,
                height: 600,
                durationMs: null,
                sizeBytes: 1234,
                name: `${id}.jpg`,
                albumId: 'album-xyz',
                albumCoverUrl: 'https://storage.googleapis.com/test-chat-media-bucket/lobby/2026/08/cover.jpg',
            });
            gateway.onChatMessage(fakeSocket({ roomName: 'lobby', userId: 'user-1', displayName: 'Clay' }), {
                text: '',
                attachments: [albumAttachment('att-1'), albumAttachment('att-2'), albumAttachment('att-3')],
            });

            const broadcast = emitSpy.mock.calls.find((call) => call[0] === 'chat-message')?.[1];
            expect(broadcast.attachments.map((attachment: { albumId: string | null }) => attachment.albumId)).toEqual([
                'album-xyz',
                'album-xyz',
                'album-xyz',
            ]);
            // The cover rides the same allowlist and has the same failure mode — dropped silently,
            // and the album falls back to compositing three images per render for everyone but the
            // sender, whose optimistic copy still has it.
            expect(broadcast.attachments[0].albumCoverUrl).toBe('https://storage.googleapis.com/test-chat-media-bucket/lobby/2026/08/cover.jpg');
        });
    });

    describe('onChatReaction', () => {
        const THUMBS_UP = '\u{1F44D}';
        const joinedSocket = () => fakeSocket({ roomName: 'lobby', userId: 'user-1', displayName: 'Clay Crosland' });

        it('toggles, then broadcasts the whole reaction state to the room', async () => {
            fakeChatReactionService.listGrouped.mockResolvedValue([
                { emoji: THUMBS_UP, reactors: [{ userId: 'user-1', displayName: 'Clay Crosland' }] },
            ]);

            const result = await gateway.onChatReaction(joinedSocket(), { messageId: 'msg-1', emoji: THUMBS_UP });

            expect(fakeChatReactionService.toggle).toHaveBeenCalledWith('msg-1', 'user-1', 'Clay Crosland', THUMBS_UP);
            expect(toSpy).toHaveBeenCalledWith('lobby');
            expect(emitSpy).toHaveBeenCalledWith('chat-message-updated', {
                id: 'msg-1',
                reactions: [{ emoji: THUMBS_UP, reactors: [{ userId: 'user-1', displayName: 'Clay Crosland' }] }],
            });
            expect(result).toEqual({ ok: true });
        });

        it('broadcasts via this.server.to, so the reactor also receives the confirmed state', async () => {
            // The sender's own UI updated optimistically; the broadcast is what corrects it. Using
            // socket.to() here (as the typing handlers do) would leave the reactor's own client the
            // only one never told the truth.
            const socket = joinedSocket();
            await gateway.onChatReaction(socket, { messageId: 'msg-1', emoji: THUMBS_UP });

            expect((socket as unknown as { to: jest.Mock }).to).toBe(toSpy);
            expect(emitSpy).toHaveBeenCalledWith('chat-message-updated', expect.objectContaining({ id: 'msg-1' }));
        });

        it('persists before broadcasting', async () => {
            const order: string[] = [];
            fakeChatReactionService.toggle.mockImplementation(async () => {
                order.push('toggle');
            });
            emitSpy.mockImplementation(() => order.push('emit'));

            await gateway.onChatReaction(joinedSocket(), { messageId: 'msg-1', emoji: THUMBS_UP });

            expect(order).toEqual(['toggle', 'emit']);
        });

        it('rejects a socket that has not joined a room', async () => {
            const result = await gateway.onChatReaction(fakeSocket({ userId: 'user-1' }), { messageId: 'msg-1', emoji: THUMBS_UP });

            expect(result).toEqual({ ok: false });
            expect(fakeChatReactionService.toggle).not.toHaveBeenCalled();
            expect(toSpy).not.toHaveBeenCalled();
        });

        it('rejects a socket with no signed-in user', async () => {
            const result = await gateway.onChatReaction(fakeSocket({ roomName: 'lobby' }), { messageId: 'msg-1', emoji: THUMBS_UP });

            expect(result).toEqual({ ok: false });
            expect(fakeChatReactionService.toggle).not.toHaveBeenCalled();
        });

        it('rejects an emoji that is not one, without touching the database', async () => {
            const result = await gateway.onChatReaction(joinedSocket(), { messageId: 'msg-1', emoji: '<script>alert(1)</script>' });

            expect(result).toEqual({ ok: false });
            expect(fakeChatReactionService.toggle).not.toHaveBeenCalled();
            expect(toSpy).not.toHaveBeenCalled();
        });

        it('rejects a missing messageId', async () => {
            const result = await gateway.onChatReaction(joinedSocket(), { emoji: THUMBS_UP });

            expect(result).toEqual({ ok: false });
            expect(fakeChatReactionService.toggle).not.toHaveBeenCalled();
        });

        it('acks false and broadcasts nothing when the write fails', async () => {
            // The realistic cause is a foreign-key violation against a ChatMessage row that isn't
            // there — saveMessage is fire-and-forget, so that ordering is possible in principle.
            // Nothing may be broadcast, or every other client shows a reaction the database doesn't
            // have; the false ack is what makes the reactor's optimistic badge disappear again.
            fakeChatReactionService.toggle.mockRejectedValue(new Error('FK violation'));

            const result = await gateway.onChatReaction(joinedSocket(), { messageId: 'ghost', emoji: THUMBS_UP });

            expect(result).toEqual({ ok: false });
            expect(emitSpy).not.toHaveBeenCalled();
        });

        it('falls back to "Anonymous" when the socket carries no displayName', async () => {
            await gateway.onChatReaction(fakeSocket({ roomName: 'lobby', userId: 'user-1' }), {
                messageId: 'msg-1',
                emoji: THUMBS_UP,
            });

            expect(fakeChatReactionService.toggle).toHaveBeenCalledWith('msg-1', 'user-1', 'Anonymous', THUMBS_UP);
        });
    });

    describe('onChatMessageDelete', () => {
        const joinedSocket = () => fakeSocket({ roomName: 'lobby', userId: 'user-1', displayName: 'Clay Crosland' });

        it('soft-deletes, then broadcasts deleted: true to the room', async () => {
            const result = await gateway.onChatMessageDelete(joinedSocket(), { messageId: 'msg-1' });

            expect(fakeChatService.softDelete).toHaveBeenCalledWith('msg-1', 'user-1');
            expect(toSpy).toHaveBeenCalledWith('lobby');
            expect(emitSpy).toHaveBeenCalledWith('chat-message-updated', { id: 'msg-1', deleted: true });
            expect(result).toEqual({ ok: true });
        });

        it('broadcasts via this.server.to, so the deleter also receives the confirmed state', async () => {
            const socket = joinedSocket();
            await gateway.onChatMessageDelete(socket, { messageId: 'msg-1' });

            expect((socket as unknown as { to: jest.Mock }).to).toBe(toSpy);
        });

        it('persists before broadcasting', async () => {
            const order: string[] = [];
            fakeChatService.softDelete.mockImplementation(async () => {
                order.push('softDelete');
                return true;
            });
            emitSpy.mockImplementation(() => order.push('emit'));

            await gateway.onChatMessageDelete(joinedSocket(), { messageId: 'msg-1' });

            expect(order).toEqual(['softDelete', 'emit']);
        });

        it('rejects a socket that has not joined a room', async () => {
            const result = await gateway.onChatMessageDelete(fakeSocket({ userId: 'user-1' }), { messageId: 'msg-1' });

            expect(result).toEqual({ ok: false });
            expect(fakeChatService.softDelete).not.toHaveBeenCalled();
            expect(toSpy).not.toHaveBeenCalled();
        });

        it('rejects a socket with no signed-in user', async () => {
            const result = await gateway.onChatMessageDelete(fakeSocket({ roomName: 'lobby' }), { messageId: 'msg-1' });

            expect(result).toEqual({ ok: false });
            expect(fakeChatService.softDelete).not.toHaveBeenCalled();
        });

        it('rejects a missing messageId', async () => {
            const result = await gateway.onChatMessageDelete(joinedSocket(), {});

            expect(result).toEqual({ ok: false });
            expect(fakeChatService.softDelete).not.toHaveBeenCalled();
        });

        // Not found, or someone else's message — ChatService.softDelete's updateMany({ where: { id,
        // userId } }) can't tell the two apart, and the gateway doesn't need to: either way, this
        // socket didn't just delete a message, and nothing should be broadcast.
        it('acks false and broadcasts nothing when softDelete reports no row matched', async () => {
            fakeChatService.softDelete.mockResolvedValue(false);

            const result = await gateway.onChatMessageDelete(joinedSocket(), { messageId: 'someone-elses-msg' });

            expect(result).toEqual({ ok: false });
            expect(emitSpy).not.toHaveBeenCalled();
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
                {} as never, // sessionService
                {} as never, // chatMediaService
                {} as never, // linkPreviewService
                {} as never, // chatReactionService
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
                {} as never, // sessionService
                {} as never, // chatMediaService
                {} as never, // linkPreviewService
                {} as never, // chatReactionService
            );

            const result = await localGateway.onGetRecordingSession({ id: 'missing' });

            expect(localChatService.getHistoryForSession).not.toHaveBeenCalled();
            expect(result).toEqual({ session: null });
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
