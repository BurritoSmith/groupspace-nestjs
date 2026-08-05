import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from './admin-token.guard';
import { PushNotificationService } from './push-notification.service';
import { normalizeNativePushPlatform } from './push-platform';

interface AnnounceUpdateBody {
    platform?: unknown;
    versionName?: unknown;
    versionCode?: unknown;
    apkUrl?: unknown;
}

/**
 * Operator-triggered "a new build of the native app is out" broadcast, called by the Android release
 * workflow after it has uploaded the APK — see .github/workflows/android.yml in the frontend repo.
 *
 * Separate from the push controllers because the audience is different in kind: every install on a
 * platform rather than one room's members, and authorized by a shared secret rather than a user's
 * session (there is no user making this request). The app's own periodic version check is what
 * guarantees delivery; this endpoint only makes it prompt.
 */
@Controller('app')
export class AppUpdateController {
    constructor(private readonly pushNotifications: PushNotificationService) {}

    @Post('announce-update')
    @UseGuards(AdminTokenGuard)
    async announceUpdate(@Body() body: AnnounceUpdateBody): Promise<{ sent: number; skipped: number }> {
        const platform = normalizeNativePushPlatform(body.platform);
        const versionName = typeof body.versionName === 'string' ? body.versionName.trim() : '';
        const versionCode = typeof body.versionCode === 'number' ? body.versionCode : Number.NaN;
        const apkUrl = typeof body.apkUrl === 'string' ? body.apkUrl.trim() : '';
        if (!platform || !versionName || !Number.isInteger(versionCode) || versionCode <= 0 || !apkUrl) {
            throw new BadRequestException('An update announcement needs a platform of "android" or "ios", a versionName, a positive integer versionCode, and an apkUrl');
        }
        // Every install is about to be told to download from this URL, so it has to be one WE
        // publish rather than any string the caller supplies — an announcement pointing somewhere
        // else is a push-button way to hand an APK to the whole user base.
        if (!isAllowedReleaseUrl(apkUrl)) {
            throw new BadRequestException('apkUrl must be an https URL under APP_RELEASE_URL_PREFIX');
        }
        return this.pushNotifications.announceAppUpdate(platform, versionName, versionCode, apkUrl);
    }
}

/** Mirrors chat-attachment-url.ts's stance on attachment URLs: an allowlisted prefix, checked as a
 *  parsed URL rather than a string `startsWith`, so `https://evil.test/?x=https://storage...`
 *  cannot slip past. Unset means no announcement can be made at all — refusing beats defaulting to
 *  a permissive prefix nobody chose. */
export function isAllowedReleaseUrl(candidate: string, prefix = process.env.APP_RELEASE_URL_PREFIX ?? ''): boolean {
    if (!prefix) {
        return false;
    }
    let url: URL;
    let allowed: URL;
    try {
        url = new URL(candidate);
        allowed = new URL(prefix);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:' || allowed.protocol !== 'https:' || url.host !== allowed.host) {
        return false;
    }
    // Path prefix compared on a directory boundary, so an allowlisted `/converge-app-releases/`
    // cannot be satisfied by `/converge-app-releases-evil/`.
    const allowedPath = allowed.pathname.endsWith('/') ? allowed.pathname : `${allowed.pathname}/`;
    return url.pathname.startsWith(allowedPath);
}
