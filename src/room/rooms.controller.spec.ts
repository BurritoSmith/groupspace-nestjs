import { Request } from 'express';
import { RoomsController } from './rooms.controller';

function fakeRequest(userId?: string) {
    return { userId } as Request & { userId?: string };
}

describe('RoomsController', () => {
    describe('GET /rooms/mine', () => {
        it("returns the caller's own visited rooms", async () => {
            const rooms = [{ name: 'lobby', lastJoinedAt: new Date('2026-08-01T00:00:00Z') }];
            const service = { listForUser: jest.fn().mockResolvedValue(rooms) };
            const controller = new RoomsController(service as never);

            const result = await controller.mine(fakeRequest('user-1'));

            expect(result).toEqual({ rooms });
        });

        // The userId comes from the session guard's stamp, never from the caller — same rationale
        // as UserSettingsController.
        it('reads the user id from the guard, not from anything the caller sent', async () => {
            const service = { listForUser: jest.fn().mockResolvedValue([]) };
            const controller = new RoomsController(service as never);

            await controller.mine(fakeRequest('user-1'));

            expect(service.listForUser).toHaveBeenCalledWith('user-1');
        });
    });
});
