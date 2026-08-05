import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { PushSubscriptionService } from './push-subscription.service';
import { PushNotificationService } from './push-notification.service';
import { normalizePushPlatform } from './push-platform';
import { SessionAuthGuard } from './session-auth.guard';

interface RegisterSubscriptionBody {
    deviceId?: unknown;
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    platform?: unknown;
}

interface ActiveBody {
    deviceId?: unknown;
}

/** Registers/unregisters this browser's Web Push subscription, and signals "I'm active now" so
 *  other devices' not-yet-attended-to notifications can be dismissed (see PushNotificationService).
 *  The VAPID public key is not secret — served unauthenticated so a rotated key never requires a
 *  frontend rebuild. */
@Controller('push')
export class PushSubscriptionController {
    constructor(
        private readonly pushSubscriptions: PushSubscriptionService,
        private readonly pushNotifications: PushNotificationService,
    ) {}

    @Get('vapid-public-key')
    vapidPublicKey(): { publicKey: string } {
        return { publicKey: process.env.VAPID_PUBLIC_KEY ?? '' };
    }

    @Post('subscriptions')
    @UseGuards(SessionAuthGuard)
    async register(@Req() request: Request & { userId?: string }, @Body() body: RegisterSubscriptionBody): Promise<{ ok: true }> {
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
        const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
        const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
        const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : '';
        if (!deviceId || !endpoint || !p256dh || !auth) {
            throw new BadRequestException('A push subscription needs a deviceId, endpoint, and keys');
        }
        // Unrecognized or absent degrades to 'web' rather than 400ing: a client too old to send this
        // field at all still has a working subscription, it just takes no part in the native-wins
        // suppression until it next re-registers. Failing the request instead would break push for
        // every already-deployed browser tab the moment this shipped.
        const platform = normalizePushPlatform(body.platform) ?? 'web';
        await this.pushSubscriptions.register(request.userId ?? '', deviceId, endpoint, p256dh, auth, platform);
        return { ok: true };
    }

    @Delete('subscriptions/:deviceId')
    @UseGuards(SessionAuthGuard)
    async unregister(@Req() request: Request & { userId?: string }, @Param('deviceId') deviceId: string): Promise<{ ok: true }> {
        await this.pushSubscriptions.unregister(request.userId ?? '', deviceId);
        return { ok: true };
    }

    @Post('active')
    @UseGuards(SessionAuthGuard)
    async active(@Req() request: Request & { userId?: string }, @Body() body: ActiveBody): Promise<{ ok: true }> {
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
        void this.pushNotifications.dismissOtherDevices(request.userId ?? '', deviceId);
        return { ok: true };
    }
}
