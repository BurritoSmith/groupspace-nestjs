import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { InvitationsService } from './invitations.service';

interface VerifyBody {
    code?: unknown;
}

/**
 * Checks an invitation code for the frontend's gate — deliberately unguarded, unlike every other
 * controller in this module. It exists specifically for people who aren't signed in yet, so
 * SessionAuthGuard (which needs a session that doesn't exist at this point) can't apply here.
 */
@Controller('invitations')
export class InvitationsController {
    constructor(private readonly invitations: InvitationsService) {}

    @Post('verify')
    async verify(@Body() body: VerifyBody): Promise<{ valid: boolean }> {
        if (typeof body?.code !== 'string' || !body.code.trim()) {
            throw new BadRequestException('code is required');
        }
        return { valid: await this.invitations.isValidCode(body.code) };
    }
}
