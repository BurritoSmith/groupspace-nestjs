import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IGoogleProfile } from './google-auth.service';

export interface IUserRecord {
    id: string;
    displayName: string;
    pictureUrl: string;
}

@Injectable()
export class UsersService {
    constructor(private readonly prisma: PrismaService) {}

    /** Upserts by Google's stable per-account `sub`; User.lastSeenAt (@updatedAt) bumps automatically. */
    async upsertFromGoogleProfile(profile: IGoogleProfile): Promise<IUserRecord> {
        const user = await this.prisma.user.upsert({
            where: { googleSub: profile.googleSub },
            create: {
                googleSub: profile.googleSub,
                email: profile.email,
                displayName: profile.displayName,
                pictureUrl: profile.pictureUrl,
            },
            update: {
                email: profile.email,
                displayName: profile.displayName,
                pictureUrl: profile.pictureUrl,
            },
        });
        return { id: user.id, displayName: user.displayName, pictureUrl: user.pictureUrl };
    }
}
