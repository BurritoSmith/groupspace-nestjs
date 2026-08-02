import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { UserSettingsController } from './user-settings.controller';

function fakeRequest(userId?: string) {
    return { userId } as Request & { userId?: string };
}

describe('UserSettingsController', () => {
    describe('GET', () => {
        it("returns the caller's own settings", async () => {
            const service = { getAll: jest.fn().mockResolvedValue([{ key: 'language', deviceId: '', value: 'nl' }]), save: jest.fn() };
            const controller = new UserSettingsController(service as never);

            const result = await controller.getAll(fakeRequest('user-1'));

            expect(result).toEqual({ settings: [{ key: 'language', deviceId: '', value: 'nl' }] });
        });

        /*
         * The userId comes from the guard's stamp on the request, never from the caller. Taking it
         * from a query param or body would let anyone read anyone else's preferences by guessing an
         * id — this asserts the only id that reaches the service is the authenticated one.
         */
        it('reads the user id from the guard, not from anything the caller sent', async () => {
            const service = { getAll: jest.fn().mockResolvedValue([]), save: jest.fn() };
            const controller = new UserSettingsController(service as never);

            await controller.getAll(fakeRequest('user-1'));

            expect(service.getAll).toHaveBeenCalledWith('user-1');
        });
    });

    describe('PUT', () => {
        it('upserts the setting for the authenticated user', async () => {
            const service = { getAll: jest.fn(), save: jest.fn().mockResolvedValue(undefined) };
            const controller = new UserSettingsController(service as never);

            const result = await controller.save(fakeRequest('user-1'), { key: 'theme', deviceId: '', value: 'dark' });

            expect(service.save).toHaveBeenCalledWith('user-1', 'theme', '', 'dark');
            expect(result).toEqual({ ok: true });
        });

        it('defaults deviceId to the global scope when it is absent', async () => {
            const service = { getAll: jest.fn(), save: jest.fn().mockResolvedValue(undefined) };
            const controller = new UserSettingsController(service as never);

            await controller.save(fakeRequest('user-1'), { key: 'language', value: 'pt' });

            expect(service.save).toHaveBeenCalledWith('user-1', 'language', '', 'pt');
        });

        /*
         * `null` is a legitimate stored value — it is how "no preference" is recorded, and the album
         * choice already relies on that. Only a genuinely absent value is a malformed request.
         */
        it('accepts a null value but rejects an absent one', async () => {
            const service = { getAll: jest.fn(), save: jest.fn().mockResolvedValue(undefined) };
            const controller = new UserSettingsController(service as never);

            await controller.save(fakeRequest('user-1'), { key: 'chat-album-choice', value: null });
            expect(service.save).toHaveBeenCalledWith('user-1', 'chat-album-choice', '', null);

            await expect(controller.save(fakeRequest('user-1'), { key: 'language' })).rejects.toThrow(BadRequestException);
        });

        it('rejects a missing or blank key rather than writing an unnamed row', async () => {
            const service = { getAll: jest.fn(), save: jest.fn() };
            const controller = new UserSettingsController(service as never);

            await expect(controller.save(fakeRequest('user-1'), { value: 'nl' })).rejects.toThrow(BadRequestException);
            await expect(controller.save(fakeRequest('user-1'), { key: '   ', value: 'nl' })).rejects.toThrow(BadRequestException);
            expect(service.save).not.toHaveBeenCalled();
        });

        // These become part of a composite primary key, so an unbounded one is a storage problem
        // rather than a cosmetic one.
        it('rejects an over-long key and truncates an over-long deviceId', async () => {
            const service = { getAll: jest.fn(), save: jest.fn().mockResolvedValue(undefined) };
            const controller = new UserSettingsController(service as never);

            await expect(controller.save(fakeRequest('user-1'), { key: 'k'.repeat(129), value: 1 })).rejects.toThrow(BadRequestException);

            await controller.save(fakeRequest('user-1'), { key: 'mic-threshold', deviceId: 'd'.repeat(200), value: 1 });
            expect(service.save).toHaveBeenCalledWith('user-1', 'mic-threshold', 'd'.repeat(128), 1);
        });
    });
});
