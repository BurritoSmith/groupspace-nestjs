import { ChatService } from './chat.service';

function createFakePrisma() {
    return {
        chatMessage: {
            create: jest.fn().mockResolvedValue({}),
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
}

describe('ChatService', () => {
    describe('saveMessage', () => {
        // Regression coverage: pictureUrl is snapshotted at send-time (same as displayName) so a
        // message from a peer who has since left the room can still show their avatar, instead of
        // only ever resolving it through the live presence roster.
        it('persists the given pictureUrl', () => {
            const fakePrisma = createFakePrisma();
            const service = new ChatService(fakePrisma as never);

            service.saveMessage('msg-1', 'lobby', 'user-1', 'Clay', 'https://pic', 'hello', new Date('2026-07-28T12:00:00.000Z'));

            expect(fakePrisma.chatMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ pictureUrl: 'https://pic' }) }),
            );
        });

        it('persists null (not an empty string) when pictureUrl is empty', () => {
            const fakePrisma = createFakePrisma();
            const service = new ChatService(fakePrisma as never);

            service.saveMessage('msg-1', 'lobby', 'user-1', 'Clay', '', 'hello', new Date('2026-07-28T12:00:00.000Z'));

            expect(fakePrisma.chatMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ pictureUrl: null }) }),
            );
        });

        it('persists attachments when provided', () => {
            const fakePrisma = createFakePrisma();
            const service = new ChatService(fakePrisma as never);
            const attachments = [
                {
                    id: 'att-1',
                    kind: 'image' as const,
                    url: 'https://storage.googleapis.com/bucket/lobby/photo.jpg',
                    storagePath: 'lobby/photo.jpg',
                    thumbnailUrl: null,
                    mimeType: 'image/jpeg',
                    width: 800,
                    height: 600,
                    durationMs: null,
                    sizeBytes: 1234,
                    name: 'photo.jpg',
                },
            ];

            service.saveMessage('msg-1', 'lobby', 'user-1', 'Clay', '', 'look at this', new Date('2026-07-28T12:00:00.000Z'), attachments);

            expect(fakePrisma.chatMessage.create).toHaveBeenCalledWith(
                expect.objectContaining({ data: expect.objectContaining({ attachments }) }),
            );
        });

        it('omits attachments (leaves the column null) for a plain text message', () => {
            const fakePrisma = createFakePrisma();
            const service = new ChatService(fakePrisma as never);

            service.saveMessage('msg-1', 'lobby', 'user-1', 'Clay', '', 'hello', new Date('2026-07-28T12:00:00.000Z'));

            const data = fakePrisma.chatMessage.create.mock.calls[0][0].data;
            expect(data.attachments).toBeUndefined();
        });

        it('omits attachments when given an empty array', () => {
            const fakePrisma = createFakePrisma();
            const service = new ChatService(fakePrisma as never);

            service.saveMessage('msg-1', 'lobby', 'user-1', 'Clay', '', 'hello', new Date('2026-07-28T12:00:00.000Z'), []);

            const data = fakePrisma.chatMessage.create.mock.calls[0][0].data;
            expect(data.attachments).toBeUndefined();
        });
    });

    describe('getRecentHistory', () => {
        it('maps a null pictureUrl (a message sent before this column existed) to an empty string', async () => {
            const fakePrisma = createFakePrisma();
            fakePrisma.chatMessage.findMany.mockResolvedValue([
                { id: 'msg-1', userId: 'user-1', displayName: 'Clay', pictureUrl: null, text: 'hi', sentAt: new Date('2026-07-28T12:00:00.000Z') },
            ]);
            const service = new ChatService(fakePrisma as never);

            const result = await service.getRecentHistory('lobby');

            expect(result).toEqual([
                { id: 'msg-1', userId: 'user-1', displayName: 'Clay', pictureUrl: '', text: 'hi', at: '2026-07-28T12:00:00.000Z' },
            ]);
        });

        it('maps attachments/linkPreview through from the row when present', async () => {
            const fakePrisma = createFakePrisma();
            const attachments = [{ id: 'att-1', kind: 'image', url: 'https://x/y.jpg' }];
            const linkPreview = { url: 'https://example.com', title: 'Example', description: null, imageUrl: null, siteName: null };
            fakePrisma.chatMessage.findMany.mockResolvedValue([
                {
                    id: 'msg-1',
                    userId: 'user-1',
                    displayName: 'Clay',
                    pictureUrl: null,
                    text: 'hi',
                    sentAt: new Date('2026-07-28T12:00:00.000Z'),
                    attachments,
                    linkPreview,
                },
            ]);
            const service = new ChatService(fakePrisma as never);

            const result = await service.getRecentHistory('lobby');

            expect(result[0].attachments).toEqual(attachments);
            expect(result[0].linkPreview).toEqual(linkPreview);
        });

        it('leaves attachments/linkPreview undefined for a plain text row (both columns null)', async () => {
            const fakePrisma = createFakePrisma();
            fakePrisma.chatMessage.findMany.mockResolvedValue([
                {
                    id: 'msg-1',
                    userId: 'user-1',
                    displayName: 'Clay',
                    pictureUrl: null,
                    text: 'hi',
                    sentAt: new Date('2026-07-28T12:00:00.000Z'),
                    attachments: null,
                    linkPreview: null,
                },
            ]);
            const service = new ChatService(fakePrisma as never);

            const result = await service.getRecentHistory('lobby');

            expect(result[0].attachments).toBeUndefined();
            expect(result[0].linkPreview).toBeUndefined();
        });

        it('passes through a real pictureUrl unchanged', async () => {
            const fakePrisma = createFakePrisma();
            fakePrisma.chatMessage.findMany.mockResolvedValue([
                {
                    id: 'msg-1',
                    userId: 'user-1',
                    displayName: 'Clay',
                    pictureUrl: 'https://pic',
                    text: 'hi',
                    sentAt: new Date('2026-07-28T12:00:00.000Z'),
                },
            ]);
            const service = new ChatService(fakePrisma as never);

            const result = await service.getRecentHistory('lobby');

            expect(result[0].pictureUrl).toBe('https://pic');
        });
    });

    describe('getHistoryForSession', () => {
        it('queries messages within [startedAt, stoppedAt], oldest first', async () => {
            const fakePrisma = createFakePrisma();
            const service = new ChatService(fakePrisma as never);
            const startedAt = new Date('2026-07-28T12:00:00.000Z');
            const stoppedAt = new Date('2026-07-28T13:00:00.000Z');

            await service.getHistoryForSession('lobby', startedAt, stoppedAt);

            expect(fakePrisma.chatMessage.findMany).toHaveBeenCalledWith({
                where: { roomName: 'lobby', sentAt: { gte: startedAt, lte: stoppedAt } },
                orderBy: { sentAt: 'asc' },
            });
        });

        it('falls back to now for a still-active session (stoppedAt null)', async () => {
            const fakePrisma = createFakePrisma();
            const service = new ChatService(fakePrisma as never);
            const startedAt = new Date('2026-07-28T12:00:00.000Z');

            await service.getHistoryForSession('lobby', startedAt, null);

            const call = fakePrisma.chatMessage.findMany.mock.calls[0][0];
            expect(call.where.sentAt.lte).toBeInstanceOf(Date);
        });
    });
});
