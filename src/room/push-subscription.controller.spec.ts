import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { PushSubscriptionController } from './push-subscription.controller';

function fakeRequest(userId?: string) {
    return { userId } as Request & { userId?: string };
}

function createController() {
    const pushSubscriptions = { register: jest.fn().mockResolvedValue(undefined), unregister: jest.fn().mockResolvedValue(undefined) };
    const pushNotifications = { dismissOtherDevices: jest.fn().mockResolvedValue(undefined) };
    const controller = new PushSubscriptionController(pushSubscriptions as never, pushNotifications as never);
    return { controller, pushSubscriptions, pushNotifications };
}

describe('PushSubscriptionController', () => {
    describe('vapidPublicKey', () => {
        it('returns the configured public key, unauthenticated', () => {
            process.env.VAPID_PUBLIC_KEY = 'public-key';
            const { controller } = createController();

            expect(controller.vapidPublicKey()).toEqual({ publicKey: 'public-key' });

            delete process.env.VAPID_PUBLIC_KEY;
        });

        it('returns an empty string when unconfigured, rather than throwing', () => {
            delete process.env.VAPID_PUBLIC_KEY;
            const { controller } = createController();

            expect(controller.vapidPublicKey()).toEqual({ publicKey: '' });
        });
    });

    describe('register', () => {
        it('registers the subscription for the authenticated user', async () => {
            const { controller, pushSubscriptions } = createController();

            const result = await controller.register(fakeRequest('user-1'), {
                deviceId: 'device-1',
                endpoint: 'https://push.example/ep',
                keys: { p256dh: 'p', auth: 'a' },
                platform: 'android',
            });

            expect(pushSubscriptions.register).toHaveBeenCalledWith('user-1', 'device-1', 'https://push.example/ep', 'p', 'a', 'android');
            expect(result).toEqual({ ok: true });
        });

        // Degrades rather than 400s, unlike the FCM token endpoint: failing here would have broken
        // push for every already-deployed browser tab the moment the column shipped. 'web' takes
        // part in no suppression, so the subscription simply behaves as it did before.
        it.each([[undefined], ['windows'], [42]])('falls back to the "web" platform for %p', async (platform) => {
            const { controller, pushSubscriptions } = createController();

            await controller.register(fakeRequest('user-1'), {
                deviceId: 'device-1',
                endpoint: 'https://push.example/ep',
                keys: { p256dh: 'p', auth: 'a' },
                platform,
            });

            expect(pushSubscriptions.register).toHaveBeenCalledWith('user-1', 'device-1', 'https://push.example/ep', 'p', 'a', 'web');
        });

        it('rejects a request missing any required field', async () => {
            const { controller, pushSubscriptions } = createController();

            await expect(controller.register(fakeRequest('user-1'), { deviceId: 'device-1' })).rejects.toThrow(BadRequestException);
            expect(pushSubscriptions.register).not.toHaveBeenCalled();
        });
    });

    describe('unregister', () => {
        it('unregisters the given device for the authenticated user', async () => {
            const { controller, pushSubscriptions } = createController();

            const result = await controller.unregister(fakeRequest('user-1'), 'device-1');

            expect(pushSubscriptions.unregister).toHaveBeenCalledWith('user-1', 'device-1');
            expect(result).toEqual({ ok: true });
        });
    });

    describe('active', () => {
        it('triggers a cross-device dismiss for the authenticated user, excluding the caller device', async () => {
            const { controller, pushNotifications } = createController();

            const result = await controller.active(fakeRequest('user-1'), { deviceId: 'device-1' });

            expect(pushNotifications.dismissOtherDevices).toHaveBeenCalledWith('user-1', 'device-1');
            expect(result).toEqual({ ok: true });
        });
    });
});
