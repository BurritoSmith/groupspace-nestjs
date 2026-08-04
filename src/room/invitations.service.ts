import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The invitation-code gate the frontend shows before Google sign-in — a row in the `Invitation`
 *  table (added/removed directly via DBeaver, not an admin UI) is what "invited" means. */
@Injectable()
export class InvitationsService {
    constructor(private readonly prisma: PrismaService) {}

    /** Case-insensitive on purpose — whatever case a code was typed into DBeaver as, or typed into
     *  the gate, shouldn't matter. Prisma's `mode: 'insensitive'` is a native Postgres filter, so
     *  there's no need to normalize how codes are stored. */
    async isValidCode(code: string): Promise<boolean> {
        const match = await this.prisma.invitation.findFirst({
            where: { code: { equals: code.trim(), mode: 'insensitive' } },
        });
        return match !== null;
    }
}
