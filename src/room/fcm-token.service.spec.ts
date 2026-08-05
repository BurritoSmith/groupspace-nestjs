import { FcmTokenService } from './fcm-token.service';

function createFakePrisma() {
    return {
        fcmToken: {
            upsert: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
}

describe('FcmTokenService', () => {
    describe('register', () => {
        it('upserts on the compound (userId, deviceId) key', async () => {
            const fakePrisma = createFakePrisma();
            const service = new FcmTokenService(fakePrisma as never);

            await service.register('user-1', 'device-1', 'fcm-token-1', 'android');

            expect(fakePrisma.fcmToken.upsert).toHaveBeenCalledWith({
                where: { userId_deviceId: { userId: 'user-1', deviceId: 'device-1' } },
                create: { userId: 'user-1', deviceId: 'device-1', token: 'fcm-token-1', platform: 'android' },
                update: { token: 'fcm-token-1', platform: 'android' },
            });
        });
    });

    describe('unregister', () => {
        it('deletes by (userId, deviceId)', async () => {
            const fakePrisma = createFakePrisma();
            const service = new FcmTokenService(fakePrisma as never);

            await service.unregister('user-1', 'device-1');

            expect(fakePrisma.fcmToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1', deviceId: 'device-1' } });
        });
    });

    describe('listForUser', () => {
        it('returns every token for the user when no exclusion is given', async () => {
            const fakePrisma = createFakePrisma();
            const service = new FcmTokenService(fakePrisma as never);

            await service.listForUser('user-1');

            expect(fakePrisma.fcmToken.findMany).toHaveBeenCalledWith({
                where: { userId: 'user-1' },
                select: { id: true, token: true },
            });
        });

        it('excludes the given deviceId when one is provided', async () => {
            const fakePrisma = createFakePrisma();
            const service = new FcmTokenService(fakePrisma as never);

            await service.listForUser('user-1', 'device-1');

            expect(fakePrisma.fcmToken.findMany).toHaveBeenCalledWith({
                where: { userId: 'user-1', deviceId: { not: 'device-1' } },
                select: { id: true, token: true },
            });
        });
    });

    describe('deleteById', () => {
        it('deletes the token row by id', async () => {
            const fakePrisma = createFakePrisma();
            const service = new FcmTokenService(fakePrisma as never);

            await service.deleteById('token-row-1');

            expect(fakePrisma.fcmToken.deleteMany).toHaveBeenCalledWith({ where: { id: 'token-row-1' } });
        });
    });
});
