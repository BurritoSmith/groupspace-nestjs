import { BadRequestException } from '@nestjs/common';
import { AppUpdateController, isAllowedReleaseUrl } from './app-update.controller';

const PREFIX = 'https://storage.googleapis.com/converge-app-releases/';
const VALID_URL = `${PREFIX}android/converge-0.56.0.apk`;

function createController() {
    const fakePushNotifications = { announceAppUpdate: jest.fn().mockResolvedValue({ sent: 3, skipped: 1 }) };
    return { controller: new AppUpdateController(fakePushNotifications as never), fakePushNotifications };
}

describe('AppUpdateController', () => {
    beforeEach(() => {
        process.env.APP_RELEASE_URL_PREFIX = PREFIX;
    });

    afterEach(() => {
        jest.clearAllMocks();
        delete process.env.APP_RELEASE_URL_PREFIX;
    });

    it('forwards a well-formed announcement and returns the fan-out counts', async () => {
        const { controller, fakePushNotifications } = createController();

        const result = await controller.announceUpdate({ platform: 'android', versionName: '0.56.0', versionCode: 560000, apkUrl: VALID_URL });

        expect(fakePushNotifications.announceAppUpdate).toHaveBeenCalledWith('android', '0.56.0', 560000, VALID_URL);
        expect(result).toEqual({ sent: 3, skipped: 1 });
    });

    it.each([
        ['a missing platform', { versionName: '0.56.0', versionCode: 560000, apkUrl: VALID_URL }],
        ['a non-native platform', { platform: 'desktop', versionName: '0.56.0', versionCode: 560000, apkUrl: VALID_URL }],
        ['a missing versionName', { platform: 'android', versionCode: 560000, apkUrl: VALID_URL }],
        ['a non-integer versionCode', { platform: 'android', versionName: '0.56.0', versionCode: 1.5, apkUrl: VALID_URL }],
        ['a string versionCode', { platform: 'android', versionName: '0.56.0', versionCode: '560000', apkUrl: VALID_URL }],
        ['a zero versionCode', { platform: 'android', versionName: '0.56.0', versionCode: 0, apkUrl: VALID_URL }],
        ['a missing apkUrl', { platform: 'android', versionName: '0.56.0', versionCode: 560000 }],
    ])('rejects %s', async (_label, body) => {
        const { controller, fakePushNotifications } = createController();

        await expect(controller.announceUpdate(body)).rejects.toBeInstanceOf(BadRequestException);
        expect(fakePushNotifications.announceAppUpdate).not.toHaveBeenCalled();
    });

    // Every install is about to be told to download from this URL, so it has to be one we publish.
    it('rejects an apkUrl outside the release prefix', async () => {
        const { controller, fakePushNotifications } = createController();

        await expect(
            controller.announceUpdate({ platform: 'android', versionName: '0.56.0', versionCode: 560000, apkUrl: 'https://evil.test/converge.apk' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(fakePushNotifications.announceAppUpdate).not.toHaveBeenCalled();
    });
});

describe('isAllowedReleaseUrl', () => {
    it('accepts a URL under the configured prefix', () => {
        expect(isAllowedReleaseUrl(VALID_URL, PREFIX)).toBe(true);
    });

    it('rejects a different host', () => {
        expect(isAllowedReleaseUrl('https://evil.test/converge-app-releases/android/x.apk', PREFIX)).toBe(false);
    });

    // A plain string startsWith would accept this, since the allowed prefix appears in the query.
    it('rejects a URL that only mentions the prefix in its query string', () => {
        expect(isAllowedReleaseUrl(`https://evil.test/x.apk?u=${PREFIX}android/a.apk`, PREFIX)).toBe(false);
    });

    // A plain string startsWith would accept this too, since '/converge-app-releases-evil/' starts
    // with '/converge-app-releases'.
    it('rejects a sibling path that merely starts with the same characters', () => {
        expect(isAllowedReleaseUrl('https://storage.googleapis.com/converge-app-releases-evil/a.apk', PREFIX)).toBe(false);
    });

    it('rejects http, however well the rest matches', () => {
        expect(isAllowedReleaseUrl('http://storage.googleapis.com/converge-app-releases/a.apk', PREFIX)).toBe(false);
    });

    it('rejects garbage that is not a URL at all', () => {
        expect(isAllowedReleaseUrl('not a url', PREFIX)).toBe(false);
    });

    // Refusing beats defaulting to a permissive prefix nobody chose.
    it('rejects everything when no prefix is configured', () => {
        expect(isAllowedReleaseUrl(VALID_URL, '')).toBe(false);
    });
});
