import { UsersService } from './users.service';
import { IGoogleProfile } from './google-auth.service';

function createFakePrisma() {
    return {
        user: {
            upsert: jest.fn().mockResolvedValue({ id: 'user-1', displayName: 'Clay', pictureUrl: 'https://x/pic.jpg' }),
            findUnique: jest.fn().mockResolvedValue(null),
        },
    };
}

function makeProfile(overrides: Partial<IGoogleProfile> = {}): IGoogleProfile {
    return { googleSub: 'sub-1', email: 'clay@example.test', displayName: 'Clay', pictureUrl: 'https://x/pic.jpg', ...overrides };
}

describe('UsersService', () => {
    describe('upsertFromGoogleProfile', () => {
        it('writes the invitation code on create, keyed by googleSub', async () => {
            const fakePrisma = createFakePrisma();
            const service = new UsersService(fakePrisma as never);

            await service.upsertFromGoogleProfile(makeProfile(), 'mackie');

            expect(fakePrisma.user.upsert).toHaveBeenCalledWith({
                where: { googleSub: 'sub-1' },
                create: {
                    googleSub: 'sub-1',
                    email: 'clay@example.test',
                    displayName: 'Clay',
                    pictureUrl: 'https://x/pic.jpg',
                    invitationCode: 'mackie',
                },
                update: {
                    email: 'clay@example.test',
                    displayName: 'Clay',
                    pictureUrl: 'https://x/pic.jpg',
                },
            });
        });

        // A resumed/returning join carries no code at all (the gate was bypassed via an existing
        // session), and must not blank out whatever was recorded when the row was first created.
        it('never includes invitationCode in the update branch, even when one is supplied', async () => {
            const fakePrisma = createFakePrisma();
            const service = new UsersService(fakePrisma as never);

            await service.upsertFromGoogleProfile(makeProfile(), 'mackie');

            const call = fakePrisma.user.upsert.mock.calls[0][0];
            expect(call.update).not.toHaveProperty('invitationCode');
        });

        it('creates with a null invitationCode when none is supplied', async () => {
            const fakePrisma = createFakePrisma();
            const service = new UsersService(fakePrisma as never);

            await service.upsertFromGoogleProfile(makeProfile());

            const call = fakePrisma.user.upsert.mock.calls[0][0];
            expect(call.create.invitationCode).toBeNull();
        });

        it('returns the upserted id/displayName/pictureUrl', async () => {
            const fakePrisma = createFakePrisma();
            const service = new UsersService(fakePrisma as never);

            const result = await service.upsertFromGoogleProfile(makeProfile());

            expect(result).toEqual({ id: 'user-1', displayName: 'Clay', pictureUrl: 'https://x/pic.jpg' });
        });
    });

    describe('findById', () => {
        it('returns the user projected to id/displayName/pictureUrl', async () => {
            const fakePrisma = createFakePrisma();
            fakePrisma.user.findUnique.mockResolvedValue({ id: 'user-1', displayName: 'Clay', pictureUrl: 'https://x/pic.jpg' });
            const service = new UsersService(fakePrisma as never);

            const result = await service.findById('user-1');

            expect(fakePrisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' } });
            expect(result).toEqual({ id: 'user-1', displayName: 'Clay', pictureUrl: 'https://x/pic.jpg' });
        });

        it('returns null for an unknown id', async () => {
            const fakePrisma = createFakePrisma();
            const service = new UsersService(fakePrisma as never);

            expect(await service.findById('nope')).toBeNull();
        });
    });
});
