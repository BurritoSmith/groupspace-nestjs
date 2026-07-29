import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface IUserSettingRecord {
    key: string;
    deviceId: string;
    value: Prisma.JsonValue;
}

/** Generic per-user preference storage — every user setting (starting with the microphone
 *  threshold) is one row here, keyed by an app-defined `key` plus an optional `deviceId` for
 *  hardware-scoped settings. A new setting needs no schema/service change, just a new key. */
@Injectable()
export class UserSettingsService {
    constructor(private readonly prisma: PrismaService) {}

    async save(userId: string, key: string, deviceId: string, value: Prisma.InputJsonValue): Promise<void> {
        await this.prisma.userSetting.upsert({
            where: { userId_key_deviceId: { userId, key, deviceId } },
            create: { userId, key, deviceId, value },
            update: { value },
        });
    }

    async getAll(userId: string): Promise<IUserSettingRecord[]> {
        return this.prisma.userSetting.findMany({
            where: { userId },
            select: { key: true, deviceId: true, value: true },
        });
    }
}
