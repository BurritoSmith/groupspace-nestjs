import { RoomMembershipService } from './room-membership.service';

function createFakePrisma() {
    return {
        roomMember: {
            upsert: jest.fn().mockResolvedValue({}),
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
}

describe('RoomMembershipService', () => {
    describe('recordVisit', () => {
        it('upserts on the compound (userId, roomName) key, connecting or creating the room', async () => {
            const fakePrisma = createFakePrisma();
            const service = new RoomMembershipService(fakePrisma as never);

            await service.recordVisit('user-1', 'demo-room');

            expect(fakePrisma.roomMember.upsert).toHaveBeenCalledWith({
                where: { userId_roomName: { userId: 'user-1', roomName: 'demo-room' } },
                create: {
                    user: { connect: { id: 'user-1' } },
                    room: { connectOrCreate: { where: { name: 'demo-room' }, create: { name: 'demo-room' } } },
                },
                // Was `{}`, which is what broke recency — see the test below.
                update: { lastJoinedAt: expect.any(Date) },
            });
        });

        /*
         * The bug this replaced. `update: {}` reads as "the row exists, just touch it", and Prisma
         * skips the UPDATE entirely when there is nothing to set — so @updatedAt never fired and
         * lastJoinedAt held the moment the membership was CREATED for the rest of its life. Every
         * feature ranking rooms by recency was silently ranking them by first visit. Measured
         * against the dev database: a room joined minutes ago still reported a fortnight-old
         * timestamp.
         */
        it('writes lastJoinedAt explicitly, so a revisit actually counts as recent', async () => {
            const fakePrisma = createFakePrisma();
            const service = new RoomMembershipService(fakePrisma as never);

            await service.recordVisit('user-1', 'lobby');

            expect(fakePrisma.roomMember.upsert.mock.calls[0][0].update.lastJoinedAt).toBeInstanceOf(Date);
        });
    });

    describe('listForUser', () => {
        it('returns rooms ordered most-recent-first, projected to name/displayName/lastJoinedAt', async () => {
            const fakePrisma = createFakePrisma();
            const lastJoinedAt = new Date('2026-08-01T00:00:00Z');
            fakePrisma.roomMember.findMany.mockResolvedValue([{ roomName: 'demo-room', lastJoinedAt, room: { displayName: null } }]);
            const service = new RoomMembershipService(fakePrisma as never);

            const result = await service.listForUser('user-1');

            expect(fakePrisma.roomMember.findMany).toHaveBeenCalledWith({
                where: { userId: 'user-1' },
                orderBy: { lastJoinedAt: 'desc' },
                take: 20,
                select: { roomName: true, lastJoinedAt: true, room: { select: { displayName: true } } },
            });
            expect(result).toEqual([{ name: 'demo-room', displayName: null, lastJoinedAt }]);
        });

        /* The whole reason displayName is fetched: a room whose name is a generated identifier has
         * nothing readable about it, and the join screen would list sixteen random characters. */
        it('carries the display name for a room whose own name says nothing', async () => {
            const fakePrisma = createFakePrisma();
            const lastJoinedAt = new Date('2026-08-01T00:00:00Z');
            fakePrisma.roomMember.findMany.mockResolvedValue([{ roomName: 'e3k7mq20xbvr8h5a', lastJoinedAt, room: { displayName: 'fonky' } }]);
            const service = new RoomMembershipService(fakePrisma as never);

            const result = await service.listForUser('user-1');

            expect(result).toEqual([{ name: 'e3k7mq20xbvr8h5a', displayName: 'fonky', lastJoinedAt }]);
        });
    });

    describe('listMembersWithProfile', () => {
        it("returns each member's live profile fields, projected from the user relation", async () => {
            const fakePrisma = createFakePrisma();
            fakePrisma.roomMember.findMany.mockResolvedValue([
                { user: { id: 'user-1', displayName: 'Alice', pictureUrl: 'https://alice.pic' } },
            ]);
            const service = new RoomMembershipService(fakePrisma as never);

            const result = await service.listMembersWithProfile('demo-room');

            expect(fakePrisma.roomMember.findMany).toHaveBeenCalledWith({
                where: { roomName: 'demo-room' },
                select: { user: { select: { id: true, displayName: true, pictureUrl: true } } },
            });
            expect(result).toEqual([{ userId: 'user-1', displayName: 'Alice', pictureUrl: 'https://alice.pic' }]);
        });
    });
});
