import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { FcmTokenController } from './fcm-token.controller';

function fakeRequest(userId?: string) {
    return { userId } as Request & { userId?: string };
}

function createController() {
    const fcmTokens = { register: jest.fn().mockResolvedValue(undefined), unregister: jest.fn().mockResolvedValue(undefined) };
    const controller = new FcmTokenController(fcmTokens as never);
    return { controller, fcmTokens };
}

describe('FcmTokenController', () => {
    describe('register', () => {
        it('registers the token for the authenticated user', async () => {
            const { controller, fcmTokens } = createController();

            const result = await controller.register(fakeRequest('user-1'), { deviceId: 'device-1', token: 'fcm-token-1', platform: 'android' });

            expect(fcmTokens.register).toHaveBeenCalledWith('user-1', 'device-1', 'fcm-token-1', 'android');
            expect(result).toEqual({ ok: true });
        });

        it('rejects a request missing any required field', async () => {
            const { controller, fcmTokens } = createController();

            await expect(controller.register(fakeRequest('user-1'), { deviceId: 'device-1' })).rejects.toThrow(BadRequestException);
            expect(fcmTokens.register).not.toHaveBeenCalled();
        });
    });

    describe('unregister', () => {
        it('unregisters the given device for the authenticated user', async () => {
            const { controller, fcmTokens } = createController();

            const result = await controller.unregister(fakeRequest('user-1'), 'device-1');

            expect(fcmTokens.unregister).toHaveBeenCalledWith('user-1', 'device-1');
            expect(result).toEqual({ ok: true });
        });
    });
});
