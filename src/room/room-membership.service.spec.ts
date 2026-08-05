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
                update: {},
            });
        });
    });

    describe('listForUser', () => {
        it('returns rooms ordered most-recent-first, projected to name/lastJoinedAt', async () => {
            const fakePrisma = createFakePrisma();
            const lastJoinedAt = new Date('2026-08-01T00:00:00Z');
            fakePrisma.roomMember.findMany.mockResolvedValue([{ roomName: 'demo-room', lastJoinedAt }]);
            const service = new RoomMembershipService(fakePrisma as never);

            const result = await service.listForUser('user-1');

            expect(fakePrisma.roomMember.findMany).toHaveBeenCalledWith({
                where: { userId: 'user-1' },
                orderBy: { lastJoinedAt: 'desc' },
                take: 20,
                select: { roomName: true, lastJoinedAt: true },
            });
            expect(result).toEqual([{ name: 'demo-room', lastJoinedAt }]);
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
