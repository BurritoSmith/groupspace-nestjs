import { BadRequestException, Body, Controller, Delete, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { FcmTokenService } from './fcm-token.service';
import { normalizeNativePushPlatform } from './push-platform';
import { SessionAuthGuard } from './session-auth.guard';

interface RegisterFcmTokenBody {
    deviceId?: unknown;
    token?: unknown;
    platform?: unknown;
}

/** Registers/unregisters this device's FCM token. Nothing calls this yet — see fcm.service.ts —
 *  it exists ahead of a Capacitor mobile app, mirroring PushSubscriptionController's shape exactly
 *  so that future caller has nothing new to learn. */
@Controller('push')
export class FcmTokenController {
    constructor(private readonly fcmTokens: FcmTokenService) {}

    @Post('fcm-token')
    @UseGuards(SessionAuthGuard)
    async register(@Req() request: Request & { userId?: string }, @Body() body: RegisterFcmTokenBody): Promise<{ ok: true }> {
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        // Rejected rather than defaulted, unlike PushSubscriptionController's own platform handling:
        // a token whose platform we cannot name can neither be matched by the native-wins suppression
        // nor targeted by an update announcement, so accepting it would store a row that silently
        // does the wrong thing in both features.
        const platform = normalizeNativePushPlatform(body.platform);
        if (!deviceId || !token || !platform) {
            throw new BadRequestException('An FCM token registration needs a deviceId, token, and a platform of "android" or "ios"');
        }
        await this.fcmTokens.register(request.userId ?? '', deviceId, token, platform);
        return { ok: true };
    }

    @Delete('fcm-token/:deviceId')
    @UseGuards(SessionAuthGuard)
    async unregister(@Req() request: Request & { userId?: string }, @Param('deviceId') deviceId: string): Promise<{ ok: true }> {
        await this.fcmTokens.unregister(request.userId ?? '', deviceId);
        return { ok: true };
    }
}
