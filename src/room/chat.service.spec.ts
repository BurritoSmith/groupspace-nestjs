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
});
