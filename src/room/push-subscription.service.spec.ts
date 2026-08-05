import { PushSubscriptionService } from './push-subscription.service';

function createFakePrisma() {
    return {
        pushSubscription: {
            upsert: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
}

describe('PushSubscriptionService', () => {
    describe('register', () => {
        it('upserts on the compound (userId, deviceId) key', async () => {
            const fakePrisma = createFakePrisma();
            const service = new PushSubscriptionService(fakePrisma as never);

            await service.register('user-1', 'device-1', 'https://push.example/ep', 'p256dh-key', 'auth-key', 'desktop');

            expect(fakePrisma.pushSubscription.upsert).toHaveBeenCalledWith({
                where: { userId_deviceId: { userId: 'user-1', deviceId: 'device-1' } },
                create: { userId: 'user-1', deviceId: 'device-1', endpoint: 'https://push.example/ep', p256dh: 'p256dh-key', auth: 'auth-key', platform: 'desktop' },
                update: { endpoint: 'https://push.example/ep', p256dh: 'p256dh-key', auth: 'auth-key', platform: 'desktop' },
            });
        });

        // `platform` has to be on the UPDATE branch too, not just create: the client re-registers on
        // every boot, and that is the only thing that backfills rows written before the column
        // existed — which sit at 'web' and take part in no suppression until it happens.
        it('rewrites the platform on re-registration, so an old row gets backfilled', async () => {
            const fakePrisma = createFakePrisma();
            const service = new PushSubscriptionService(fakePrisma as never);

            await service.register('user-1', 'device-1', 'https://push.example/ep', 'p', 'a', 'android');

            expect(fakePrisma.pushSubscription.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ platform: 'android' }) }));
        });
    });

    describe('unregister', () => {
        it('deletes by (userId, deviceId)', async () => {
            const fakePrisma = createFakePrisma();
            const service = new PushSubscriptionService(fakePrisma as never);

            await service.unregister('user-1', 'device-1');

            expect(fakePrisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1', deviceId: 'device-1' } });
        });
    });

    describe('listForUser', () => {
        it('returns every subscription for the user when no exclusion is given', async () => {
            const fakePrisma = createFakePrisma();
            const service = new PushSubscriptionService(fakePrisma as never);

            await service.listForUser('user-1');

            expect(fakePrisma.pushSubscription.findMany).toHaveBeenCalledWith({
                where: { userId: 'user-1' },
                select: { id: true, endpoint: true, p256dh: true, auth: true, platform: true },
            });
        });

        it('excludes the given deviceId when one is provided', async () => {
            const fakePrisma = createFakePrisma();
            const service = new PushSubscriptionService(fakePrisma as never);

            await service.listForUser('user-1', 'device-1');

            expect(fakePrisma.pushSubscription.findMany).toHaveBeenCalledWith({
                where: { userId: 'user-1', deviceId: { not: 'device-1' } },
                select: { id: true, endpoint: true, p256dh: true, auth: true, platform: true },
            });
        });
    });

    describe('deleteById', () => {
        it('deletes the subscription row by id', async () => {
            const fakePrisma = createFakePrisma();
            const service = new PushSubscriptionService(fakePrisma as never);

            await service.deleteById('sub-1');

            expect(fakePrisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
        });
    });
});
