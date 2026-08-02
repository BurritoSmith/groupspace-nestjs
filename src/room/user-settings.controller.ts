import { BadRequestException, Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { Prisma } from '@prisma/client';
import { UserSettingsService, IUserSettingRecord } from './user-settings.service';
import { SessionAuthGuard } from './session-auth.guard';

/** How long a key/deviceId may be. Generous next to the handful the app actually uses — the point is
 *  a bound, not a schema, since these become part of a composite primary key. */
const MAX_KEY_LENGTH = 128;

interface SaveSettingBody {
    key?: unknown;
    deviceId?: unknown;
    value?: unknown;
}

/**
 * Read and write a signed-in user's preferences over REST.
 *
 * The same `UserSetting` rows the `save-user-setting` socket handler writes (room.gateway.ts) — one
 * store, reachable two ways, so the two paths can't drift apart.
 *
 * REST rather than another socket message because of WHEN it is needed: the gateway only learns who
 * you are at join-room (`socket.data.userId` is set there and nowhere else), so a socket can't
 * answer "what language did this user choose?" before they have entered a room. The frontend needs
 * that answer at boot, to pick a language before the first paint.
 *
 * Guarded by SessionAuthGuard, which stamps `req.userId` from the same session JWT the upload and
 * GIF endpoints already use. Nothing here ever takes a userId from the caller — that would let
 * anyone read anyone's settings by guessing an id.
 */
@Controller('user/settings')
@UseGuards(SessionAuthGuard)
export class UserSettingsController {
    constructor(private readonly userSettings: UserSettingsService) {}

    @Get()
    async getAll(@Req() request: Request & { userId?: string }): Promise<{ settings: IUserSettingRecord[] }> {
        return { settings: await this.userSettings.getAll(request.userId ?? '') };
    }

    @Put()
    async save(@Req() request: Request & { userId?: string }, @Body() body: SaveSettingBody): Promise<{ ok: true }> {
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!key || key.length > MAX_KEY_LENGTH) {
            throw new BadRequestException('A setting needs a key');
        }
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, MAX_KEY_LENGTH) : '';
        if (body.value === undefined) {
            // Distinct from `null`, which is a legitimate stored value ("no preference"). An absent
            // value is a malformed request, and upserting `undefined` would throw inside Prisma with
            // a far less useful message.
            throw new BadRequestException('A setting needs a value');
        }
        await this.userSettings.save(request.userId ?? '', key, deviceId, body.value as Prisma.InputJsonValue);
        return { ok: true };
    }
}
