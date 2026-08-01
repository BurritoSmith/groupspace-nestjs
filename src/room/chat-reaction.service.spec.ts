import { ChatReactionService, MAX_REACTIONS_PER_USER_PER_MESSAGE } from './chat-reaction.service';

function createFakePrisma(overrides: Partial<Record<'deleteMany' | 'count' | 'create' | 'findMany', jest.Mock>> = {}) {
    return {
        chatMessageReaction: {
            deleteMany: overrides.deleteMany ?? jest.fn().mockResolvedValue({ count: 0 }),
            count: overrides.count ?? jest.fn().mockResolvedValue(0),
            create: overrides.create ?? jest.fn().mockResolvedValue({}),
            findMany: overrides.findMany ?? jest.fn().mockResolvedValue([]),
        },
    };
}

const THUMBS_UP = '\u{1F44D}';
const JOY = '\u{1F602}';
const HEART = '\u{2764}\u{FE0F}';

describe('ChatReactionService', () => {
    describe('toggle', () => {
        it('adds the reaction when the user does not already hold it', async () => {
            const fakePrisma = createFakePrisma();
            const service = new ChatReactionService(fakePrisma as never);

            await service.toggle('msg-1', 'user-1', 'Clay', THUMBS_UP);

            expect(fakePrisma.chatMessageReaction.create).toHaveBeenCalledWith({
                data: { messageId: 'msg-1', userId: 'user-1', displayName: 'Clay', emoji: THUMBS_UP },
            });
        });

        it('removes the reaction when the user already holds it, and does not re-add it', async () => {
            const fakePrisma = createFakePrisma({ deleteMany: jest.fn().mockResolvedValue({ count: 1 }) });
            const service = new ChatReactionService(fakePrisma as never);

            await service.toggle('msg-1', 'user-1', 'Clay', THUMBS_UP);

            expect(fakePrisma.chatMessageReaction.deleteMany).toHaveBeenCalledWith({
                where: { messageId: 'msg-1', userId: 'user-1', emoji: THUMBS_UP },
            });
            expect(fakePrisma.chatMessageReaction.create).not.toHaveBeenCalled();
        });

        // The stacking model, and the reason the unique key includes `emoji`. A one-reaction-per-user
        // implementation would clear the existing row before inserting the new one; this asserts on
        // the delete's WHERE, which is what would have to change.
        it('leaves a user other reactions alone when they add a different emoji', async () => {
            const fakePrisma = createFakePrisma();
            const service = new ChatReactionService(fakePrisma as never);

            await service.toggle('msg-1', 'user-1', 'Clay', JOY);

            expect(fakePrisma.chatMessageReaction.deleteMany).toHaveBeenCalledTimes(1);
            expect(fakePrisma.chatMessageReaction.deleteMany).toHaveBeenCalledWith({
                where: { messageId: 'msg-1', userId: 'user-1', emoji: JOY },
            });
            // Specifically NOT a delete scoped to just (messageId, userId) — that would wipe the
            // user's other emoji on this message and turn stacking into replacement.
            expect(fakePrisma.chatMessageReaction.deleteMany).not.toHaveBeenCalledWith({
                where: { messageId: 'msg-1', userId: 'user-1' },
            });
            expect(fakePrisma.chatMessageReaction.create).toHaveBeenCalled();
        });

        it('refuses to add past the per-user cap', async () => {
            const fakePrisma = createFakePrisma({ count: jest.fn().mockResolvedValue(MAX_REACTIONS_PER_USER_PER_MESSAGE) });
            const service = new ChatReactionService(fakePrisma as never);

            await service.toggle('msg-1', 'user-1', 'Clay', HEART);

            expect(fakePrisma.chatMessageReaction.create).not.toHaveBeenCalled();
        });

        it('still lets a capped-out user remove one of the reactions they hold', async () => {
            const fakePrisma = createFakePrisma({
                deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
                count: jest.fn().mockResolvedValue(MAX_REACTIONS_PER_USER_PER_MESSAGE),
            });
            const service = new ChatReactionService(fakePrisma as never);

            await service.toggle('msg-1', 'user-1', 'Clay', HEART);

            expect(fakePrisma.chatMessageReaction.deleteMany).toHaveBeenCalled();
            // The cap is checked only on the add path, so being at it can't strand someone.
            expect(fakePrisma.chatMessageReaction.count).not.toHaveBeenCalled();
        });
    });

    describe('listGrouped', () => {
        it('folds rows into per-emoji groups', async () => {
            const fakePrisma = createFakePrisma({
                findMany: jest.fn().mockResolvedValue([
                    { userId: 'user-1', displayName: 'Clay', emoji: THUMBS_UP, createdAt: new Date('2026-08-01T10:00:00Z') },
                    { userId: 'user-2', displayName: 'Kristin', emoji: JOY, createdAt: new Date('2026-08-01T10:00:01Z') },
                    { userId: 'user-3', displayName: 'Iffy', emoji: THUMBS_UP, createdAt: new Date('2026-08-01T10:00:02Z') },
                ]),
            });
            const service = new ChatReactionService(fakePrisma as never);

            const groups = await service.listGrouped('msg-1');

            expect(groups).toEqual([
                {
                    emoji: THUMBS_UP,
                    reactors: [
                        { userId: 'user-1', displayName: 'Clay' },
                        { userId: 'user-3', displayName: 'Iffy' },
                    ],
                },
                { emoji: JOY, reactors: [{ userId: 'user-2', displayName: 'Kristin' }] },
            ]);
        });

        it('returns an empty list for a message nobody has reacted to', async () => {
            const service = new ChatReactionService(createFakePrisma() as never);
            expect(await service.listGrouped('msg-1')).toEqual([]);
        });
    });
});
