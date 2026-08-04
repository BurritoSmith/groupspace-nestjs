import { BadRequestException } from '@nestjs/common';
import { InvitationsController } from './invitations.controller';

describe('InvitationsController', () => {
    describe('POST verify', () => {
        it('returns valid: true for a matching code', async () => {
            const service = { isValidCode: jest.fn().mockResolvedValue(true) };
            const controller = new InvitationsController(service as never);

            const result = await controller.verify({ code: 'mackie' });

            expect(service.isValidCode).toHaveBeenCalledWith('mackie');
            expect(result).toEqual({ valid: true });
        });

        it('returns valid: false for a non-matching code, without throwing', async () => {
            const service = { isValidCode: jest.fn().mockResolvedValue(false) };
            const controller = new InvitationsController(service as never);

            const result = await controller.verify({ code: 'wrong' });

            expect(result).toEqual({ valid: false });
        });

        it('rejects a missing, blank, or non-string code rather than reaching the service', async () => {
            const service = { isValidCode: jest.fn() };
            const controller = new InvitationsController(service as never);

            await expect(controller.verify({})).rejects.toThrow(BadRequestException);
            await expect(controller.verify({ code: '   ' })).rejects.toThrow(BadRequestException);
            await expect(controller.verify({ code: 42 })).rejects.toThrow(BadRequestException);
            expect(service.isValidCode).not.toHaveBeenCalled();
        });
    });
});
