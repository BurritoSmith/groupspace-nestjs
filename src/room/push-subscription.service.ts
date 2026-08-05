import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface IPushSubscriptionRow {
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    /** 'android' | 'ios' | 'desktop', or 'web' for a row registered before the client started
     *  reporting it. Only read by PushNotificationService's native-wins suppression. */
    platform: string;
}

/** One registered Web Push endpoint per (userId, deviceId) — `deviceId` is client-minted and
 *  persisted in that browser's localStorage, so re-subscribing the same install (e.g. after the
 *  push service rotates its endpoint) upserts in place instead of accumulating duplicate rows. */
@Injectable()
export class PushSubscriptionService {
    constructor(private readonly prisma: PrismaService) {}

    /** `platform` is on the update branch as well as create, deliberately: the client re-registers
     *  on every boot, and that is what backfills rows written before the column existed (which
     *  default to 'web' and would otherwise never take part in the native-wins suppression). */
    async register(userId: string, deviceId: string, endpoint: string, p256dh: string, auth: string, platform: string): Promise<void> {
        await this.prisma.pushSubscription.upsert({
            where: { userId_deviceId: { userId, deviceId } },
            create: { userId, deviceId, endpoint, p256dh, auth, platform },
            update: { endpoint, p256dh, auth, platform },
        });
    }

    async unregister(userId: string, deviceId: string): Promise<void> {
        await this.prisma.pushSubscription.deleteMany({ where: { userId, deviceId } });
    }

    async listForUser(userId: string, excludeDeviceId?: string): Promise<IPushSubscriptionRow[]> {
        return this.prisma.pushSubscription.findMany({
            where: excludeDeviceId ? { userId, deviceId: { not: excludeDeviceId } } : { userId },
            select: { id: true, endpoint: true, p256dh: true, auth: true, platform: true },
        });
    }

    /** Cleanup for the standard web-push expiry idiom — a 404/410 response means the browser has
     *  dropped the subscription, so the row is now permanently dead. No-op if already gone. */
    async deleteById(id: string): Promise<void> {
        await this.prisma.pushSubscription.deleteMany({ where: { id } });
    }
}
