import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface IPushSubscriptionRow {
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
}

/** One registered Web Push endpoint per (userId, deviceId) — `deviceId` is client-minted and
 *  persisted in that browser's localStorage, so re-subscribing the same install (e.g. after the
 *  push service rotates its endpoint) upserts in place instead of accumulating duplicate rows. */
@Injectable()
export class PushSubscriptionService {
    constructor(private readonly prisma: PrismaService) {}

    async register(userId: string, deviceId: string, endpoint: string, p256dh: string, auth: string): Promise<void> {
        await this.prisma.pushSubscription.upsert({
            where: { userId_deviceId: { userId, deviceId } },
            create: { userId, deviceId, endpoint, p256dh, auth },
            update: { endpoint, p256dh, auth },
        });
    }

    async unregister(userId: string, deviceId: string): Promise<void> {
        await this.prisma.pushSubscription.deleteMany({ where: { userId, deviceId } });
    }

    async listForUser(userId: string, excludeDeviceId?: string): Promise<IPushSubscriptionRow[]> {
        return this.prisma.pushSubscription.findMany({
            where: excludeDeviceId ? { userId, deviceId: { not: excludeDeviceId } } : { userId },
            select: { id: true, endpoint: true, p256dh: true, auth: true },
        });
    }

    /** Cleanup for the standard web-push expiry idiom — a 404/410 response means the browser has
     *  dropped the subscription, so the row is now permanently dead. No-op if already gone. */
    async deleteById(id: string): Promise<void> {
        await this.prisma.pushSubscription.deleteMany({ where: { id } });
    }
}
