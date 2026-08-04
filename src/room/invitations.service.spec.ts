import { InvitationsService } from './invitations.service';

function createFakePrisma() {
    return {
        invitation: {
            findFirst: jest.fn().mockResolvedValue(null),
        },
    };
}

describe('InvitationsService', () => {
    describe('isValidCode', () => {
        it('returns true when a matching row exists', async () => {
            const fakePrisma = createFakePrisma();
            fakePrisma.invitation.findFirst.mockResolvedValue({ id: 'inv-1', code: 'mackie' });
            const service = new InvitationsService(fakePrisma as never);

            expect(await service.isValidCode('mackie')).toBe(true);
        });

        it('returns false when nothing matches', async () => {
            const fakePrisma = createFakePrisma();
            const service = new InvitationsService(fakePrisma as never);

            expect(await service.isValidCode('nope')).toBe(false);
        });

        // The whole point of the gate: DBeaver-entered casing shouldn't matter, and neither should
        // the caller's.
        it('matches case-insensitively via Prisma, not by normalizing storage', async () => {
            const fakePrisma = createFakePrisma();
            fakePrisma.invitation.findFirst.mockResolvedValue({ id: 'inv-1', code: 'mackie' });
            const service = new InvitationsService(fakePrisma as never);

            await service.isValidCode('MACKIE');

            expect(fakePrisma.invitation.findFirst).toHaveBeenCalledWith({
                where: { code: { equals: 'MACKIE', mode: 'insensitive' } },
            });
        });

        it('trims surrounding whitespace before matching', async () => {
            const fakePrisma = createFakePrisma();
            const service = new InvitationsService(fakePrisma as never);

            await service.isValidCode('  mackie  ');

            expect(fakePrisma.invitation.findFirst).toHaveBeenCalledWith({
                where: { code: { equals: 'mackie', mode: 'insensitive' } },
            });
        });
    });
});
