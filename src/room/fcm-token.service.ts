import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface IFcmTokenRow {
    id: string;
    token: string;
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
            select: { id: true, token: true },
        });
    }

    /** Cleanup when FcmService.send() reports the token gone — mirrors
     *  PushSubscriptionService.deleteById. No-op if already gone. */
    async deleteById(id: string): Promise<void> {
        await this.prisma.fcmToken.deleteMany({ where: { id } });
    }
}
