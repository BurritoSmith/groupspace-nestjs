import { UserSettingsService } from './user-settings.service';

function createFakePrisma() {
    return {
        userSetting: {
            upsert: jest.fn().mockResolvedValue({}),
            findMany: jest.fn().mockResolvedValue([]),
        },
    };
}

describe('UserSettingsService', () => {
    describe('save', () => {
        it('upserts on the compound (userId, key, deviceId) key', async () => {
            const fakePrisma = createFakePrisma();
            const service = new UserSettingsService(fakePrisma as never);

            await service.save('user-1', 'mic-threshold', 'device-1', 30);

            expect(fakePrisma.userSetting.upsert).toHaveBeenCalledWith({
                where: { userId_key_deviceId: { userId: 'user-1', key: 'mic-threshold', deviceId: 'device-1' } },
                create: { userId: 'user-1', key: 'mic-threshold', deviceId: 'device-1', value: 30 },
                update: { value: 30 },
            });
        });
    });

    describe('getAll', () => {
        it("returns every row for the given user, projected to key/deviceId/value", async () => {
            const fakePrisma = createFakePrisma();
            fakePrisma.userSetting.findMany.mockResolvedValue([
                { key: 'mic-threshold', deviceId: 'device-1', value: 30 },
                { key: 'mic-threshold', deviceId: 'device-2', value: 15 },
            ]);
            const service = new UserSettingsService(fakePrisma as never);

            const result = await service.getAll('user-1');

            expect(fakePrisma.userSetting.findMany).toHaveBeenCalledWith({
                where: { userId: 'user-1' },
                select: { key: true, deviceId: true, value: true },
            });
            expect(result).toEqual([
                { key: 'mic-threshold', deviceId: 'device-1', value: 30 },
                { key: 'mic-threshold', deviceId: 'device-2', value: 15 },
            ]);
        });
    });
});
