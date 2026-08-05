import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface IFcmTokenRow {
    id: string;
    token: string;
    /** 'android' | 'ios'. Read by PushNotificationService to decide which of the same user's
     *  web-push subscriptions this native install has taken over. */
    platform: string;
}

/** A token plus its owner — only the account-wide announcement path needs the userId, since it
 *  fans out across users rather than within one. */
export interface IFcmTokenWithUserRow extends IFcmTokenRow {
    userId: string;
}

/** One registered FCM token per (userId, deviceId) — same upsert-on-reregister shape as
 *  PushSubscriptionService, for the same reason: a token can rotate under the hood, and
 *  re-registering the same install should replace it in place rather than accumulate rows. */
@Injectable()
export class FcmTokenService {
    constructor(private readonly prisma: PrismaService) {}

    async register(userId: string, deviceId: string, token: string, platform: string): Promise<void> {
        await this.prisma.fcmToken.upsert({
            where: { userId_deviceId: { userId, deviceId } },
            create: { userId, deviceId, token, platform },
            update: { token, platform },
        });
    }

    async unregister(userId: string, deviceId: string): Promise<void> {
        await this.prisma.fcmToken.deleteMany({ where: { userId, deviceId } });
    }

    async listForUser(userId: string, excludeDeviceId?: string): Promise<IFcmTokenRow[]> {
        return this.prisma.fcmToken.findMany({
            where: excludeDeviceId ? { userId, deviceId: { not: excludeDeviceId } } : { userId },
            select: { id: true, token: true, platform: true },
        });
    }

    /** Every install of the native app on one platform, across all users — the audience for an
     *  app-update announcement, which is about the app itself rather than about any one room. */
    async listAllForPlatform(platform: string): Promise<IFcmTokenWithUserRow[]> {
        return this.prisma.fcmToken.findMany({
            where: { platform },
            select: { id: true, token: true, platform: true, userId: true },
        });
    }

    /** Cleanup when FcmService.send() reports the token gone — mirrors
     *  PushSubscriptionService.deleteById. No-op if already gone. */
    async deleteById(id: string): Promise<void> {
        await this.prisma.fcmToken.deleteMany({ where: { id } });
    }
}
