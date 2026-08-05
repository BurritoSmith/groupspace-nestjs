import * as webpush from 'web-push';
import { PushNotificationService } from './push-notification.service';

jest.mock('web-push', () => ({
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));

function createService() {
    const fakeRoomMembership = {
        recordVisit: jest.fn(),
        listForUser: jest.fn(),
        listMembersWithProfile: jest.fn().mockResolvedValue([]),
    };
    const fakePushSubscriptions = {
        register: jest.fn(),
        unregister: jest.fn(),
        listForUser: jest.fn().mockResolvedValue([]),
        deleteById: jest.fn().mockResolvedValue(undefined),
    };
    const fakeFcmTokens = {
        register: jest.fn(),
        unregister: jest.fn(),
        listForUser: jest.fn().mockResolvedValue([]),
        deleteById: jest.fn().mockResolvedValue(undefined),
    };
    const fakeFcm = { isConfigured: jest.fn().mockReturnValue(false), send: jest.fn().mockResolvedValue('ok') };
    const fakeUserSettings = { save: jest.fn(), getAll: jest.fn().mockResolvedValue([]) };
    const service = new PushNotificationService(fakeRoomMembership as never, fakePushSubscriptions as never, fakeFcmTokens as never, fakeFcm as never, fakeUserSettings as never);
    return { service, fakeRoomMembership, fakePushSubscriptions, fakeFcmTokens, fakeFcm, fakeUserSettings };
}

function configure(service: PushNotificationService) {
    process.env.VAPID_PUBLIC_KEY = 'public-key';
    process.env.VAPID_PRIVATE_KEY = 'private-key';
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    service.onModuleInit();
}

const enabledSettings = [
    { key: 'notifications-master', deviceId: '', value: true },
    { key: 'notifications-new-message', deviceId: '', value: true },
    { key: 'notifications-person-joined', deviceId: '', value: true },
];

describe('PushNotificationService', () => {
    afterEach(() => {
        jest.clearAllMocks();
        delete process.env.VAPID_PUBLIC_KEY;
        delete process.env.VAPID_PRIVATE_KEY;
        delete process.env.VAPID_SUBJECT;
    });

    describe('onModuleInit', () => {
        it('does not configure web-push when VAPID env vars are missing', () => {
            delete process.env.VAPID_PUBLIC_KEY;
            delete process.env.VAPID_PRIVATE_KEY;
            delete process.env.VAPID_SUBJECT;
            const { service } = createService();

            service.onModuleInit();

            expect(webpush.setVapidDetails).not.toHaveBeenCalled();
        });

        it('configures web-push when all three VAPID env vars are present', () => {
            const { service } = createService();

            configure(service);

            expect(webpush.setVapidDetails).toHaveBeenCalledWith('mailto:test@example.com', 'public-key', 'private-key');
        });
    });

    describe('notifyChatMessage', () => {
        it('is a no-op when not configured', async () => {
            const { service, fakeRoomMembership } = createService();

            await service.notifyChatMessage('lobby', 'user-1', 'Clay', 'hello', 'msg-1', new Set());

            expect(fakeRoomMembership.listMembersWithProfile).not.toHaveBeenCalled();
        });

        it('excludes the actor and sends only to members with both master and category preferences on', async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeUserSettings } = createService();
            configure(service);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([
                { userId: 'user-1', displayName: 'Sender', pictureUrl: '' },
                { userId: 'user-2', displayName: 'Enabled', pictureUrl: '' },
                { userId: 'user-3', displayName: 'Disabled', pictureUrl: '' },
            ]);
            fakeUserSettings.getAll.mockImplementation((userId: string) => Promise.resolve(userId === 'user-2' ? enabledSettings : []));
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);

            await service.notifyChatMessage('lobby', 'user-1', 'Sender', 'hello there', 'msg-1', new Set());

            expect(fakePushSubscriptions.listForUser).toHaveBeenCalledTimes(1);
            expect(fakePushSubscriptions.listForUser).toHaveBeenCalledWith('user-2');
            expect(webpush.sendNotification).toHaveBeenCalledWith(
                { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } },
                JSON.stringify({
                    type: 'chat-message',
                    roomName: 'lobby',
                    senderDisplayName: 'Sender',
                    messageText: 'hello there',
                    messageId: 'msg-1',
                    tag: 'chat:lobby',
                }),
            );
        });

        it('includes iconUrl/imageUrl in the payload when given, and omits them when absent', async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeUserSettings } = createService();
            configure(service);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([{ userId: 'user-2', displayName: 'Enabled', pictureUrl: '' }]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);

            await service.notifyChatMessage(
                'lobby',
                'user-1',
                'Sender',
                'look at this',
                'msg-1',
                new Set(),
                'https://cdn.example/thumb.jpg',
                'https://cdn.example/full.jpg',
            );

            const sentPayload = JSON.parse((webpush.sendNotification as jest.Mock).mock.calls[0][1] as string);
            expect(sentPayload.iconUrl).toBe('https://cdn.example/thumb.jpg');
            expect(sentPayload.imageUrl).toBe('https://cdn.example/full.jpg');
        });

        it('omits iconUrl/imageUrl entirely from the payload for a text-only message', async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeUserSettings } = createService();
            configure(service);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([{ userId: 'user-2', displayName: 'Enabled', pictureUrl: '' }]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);

            await service.notifyChatMessage('lobby', 'user-1', 'Sender', 'just text', 'msg-1', new Set());

            const sentPayload = JSON.parse((webpush.sendNotification as jest.Mock).mock.calls[0][1] as string);
            expect(sentPayload).not.toHaveProperty('iconUrl');
            expect(sentPayload).not.toHaveProperty('imageUrl');
        });

        it("includes the sender's picture so a text-only message still has an icon to show", async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeUserSettings } = createService();
            configure(service);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([{ userId: 'user-2', displayName: 'Enabled', pictureUrl: '' }]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);

            await service.notifyChatMessage(
                'lobby',
                'user-1',
                'Sender',
                'just text',
                'msg-1',
                new Set(),
                undefined,
                undefined,
                'https://lh3.googleusercontent.com/avatar',
            );

            const sentPayload = JSON.parse((webpush.sendNotification as jest.Mock).mock.calls[0][1] as string);
            expect(sentPayload.senderPictureUrl).toBe('https://lh3.googleusercontent.com/avatar');
        });

        // '' rather than undefined is what an account Google gave no picture for actually carries,
        // and shipping it would have the client set an icon it can never load rather than falling
        // back to the app's own mark.
        it('omits senderPictureUrl for an account with no picture', async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeUserSettings } = createService();
            configure(service);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([{ userId: 'user-2', displayName: 'Enabled', pictureUrl: '' }]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);

            await service.notifyChatMessage('lobby', 'user-1', 'Sender', 'just text', 'msg-1', new Set(), undefined, undefined, '');

            const sentPayload = JSON.parse((webpush.sendNotification as jest.Mock).mock.calls[0][1] as string);
            expect(sentPayload).not.toHaveProperty('senderPictureUrl');
        });

        it('truncates long message text before sending', async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeUserSettings } = createService();
            configure(service);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([{ userId: 'user-2', displayName: 'Enabled', pictureUrl: '' }]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);
            const longText = 'x'.repeat(400);

            await service.notifyChatMessage('lobby', 'user-1', 'Sender', longText, 'msg-1', new Set());

            const sentPayload = JSON.parse((webpush.sendNotification as jest.Mock).mock.calls[0][1] as string);
            expect(sentPayload.messageText).toHaveLength(300);
        });

        it('deletes the subscription when the push service reports it gone (410)', async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeUserSettings } = createService();
            configure(service);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([{ userId: 'user-2', displayName: 'Enabled', pictureUrl: '' }]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);
            (webpush.sendNotification as jest.Mock).mockRejectedValueOnce({ statusCode: 410 });

            await service.notifyChatMessage('lobby', 'user-1', 'Sender', 'hi', 'msg-1', new Set());

            expect(fakePushSubscriptions.deleteById).toHaveBeenCalledWith('sub-1');
        });

        it('also sends to a member\'s registered FCM tokens, alongside their web push subscriptions', async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeFcmTokens, fakeFcm, fakeUserSettings } = createService();
            configure(service);
            fakeFcm.isConfigured.mockReturnValue(true);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([{ userId: 'user-2', displayName: 'Enabled', pictureUrl: '' }]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);
            fakeFcmTokens.listForUser.mockResolvedValue([{ id: 'token-row-1', token: 'fcm-token-1' }]);

            await service.notifyChatMessage('lobby', 'user-1', 'Sender', 'hello there', 'msg-1', new Set());

            expect(fakeFcm.send).toHaveBeenCalledWith(
                'fcm-token-1',
                expect.objectContaining({ type: 'chat-message', roomName: 'lobby', senderDisplayName: 'Sender', messageText: 'hello there', messageId: 'msg-1' }),
            );
        });

        it('deletes an FCM token when FcmService reports it gone', async () => {
            const { service, fakeRoomMembership, fakeFcmTokens, fakeFcm, fakeUserSettings } = createService();
            configure(service);
            fakeFcm.isConfigured.mockReturnValue(true);
            fakeFcm.send.mockResolvedValue('gone');
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([{ userId: 'user-2', displayName: 'Enabled', pictureUrl: '' }]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakeFcmTokens.listForUser.mockResolvedValue([{ id: 'token-row-1', token: 'fcm-token-1' }]);

            await service.notifyChatMessage('lobby', 'user-1', 'Sender', 'hi', 'msg-1', new Set());

            expect(fakeFcmTokens.deleteById).toHaveBeenCalledWith('token-row-1');
        });

        it('skips a member who has focus on the room on any of their devices, even other idle devices of theirs', async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeUserSettings } = createService();
            configure(service);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([
                { userId: 'user-2', displayName: 'Focused', pictureUrl: '' },
                { userId: 'user-3', displayName: 'NotFocused', pictureUrl: '' },
            ]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);

            await service.notifyChatMessage('lobby', 'user-1', 'Sender', 'hi', 'msg-1', new Set(['user-2']));

            expect(fakePushSubscriptions.listForUser).toHaveBeenCalledTimes(1);
            expect(fakePushSubscriptions.listForUser).toHaveBeenCalledWith('user-3');
        });

        it('leaves the subscription alone on a non-expiry error', async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeUserSettings } = createService();
            configure(service);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([{ userId: 'user-2', displayName: 'Enabled', pictureUrl: '' }]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);
            (webpush.sendNotification as jest.Mock).mockRejectedValueOnce({ statusCode: 500 });

            await service.notifyChatMessage('lobby', 'user-1', 'Sender', 'hi', 'msg-1', new Set());

            expect(fakePushSubscriptions.deleteById).not.toHaveBeenCalled();
        });
    });

    describe('notifyPeerJoined', () => {
        it('sends a peer-joined payload gated on the person-joined category', async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeUserSettings } = createService();
            configure(service);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([
                { userId: 'user-1', displayName: 'Joiner', pictureUrl: '' },
                { userId: 'user-2', displayName: 'Existing', pictureUrl: '' },
            ]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);

            await service.notifyPeerJoined('lobby', 'user-1', 'Joiner', new Set());

            expect(webpush.sendNotification).toHaveBeenCalledWith(
                { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } },
                JSON.stringify({ type: 'peer-joined', roomName: 'lobby', joinerDisplayName: 'Joiner', tag: 'peer-joined:lobby' }),
            );
        });

        // This notification never has an attachment of its own, so the avatar is the only icon it
        // will ever carry — without it Chrome falls back to a letter placeholder from the origin.
        it("includes the joiner's picture when they have one", async () => {
            const { service, fakeRoomMembership, fakePushSubscriptions, fakeUserSettings } = createService();
            configure(service);
            fakeRoomMembership.listMembersWithProfile.mockResolvedValue([
                { userId: 'user-1', displayName: 'Joiner', pictureUrl: '' },
                { userId: 'user-2', displayName: 'Existing', pictureUrl: '' },
            ]);
            fakeUserSettings.getAll.mockResolvedValue(enabledSettings);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' }]);

            await service.notifyPeerJoined('lobby', 'user-1', 'Joiner', new Set(), 'https://lh3.googleusercontent.com/avatar');

            const sentPayload = JSON.parse((webpush.sendNotification as jest.Mock).mock.calls[0][1] as string);
            expect(sentPayload.joinerPictureUrl).toBe('https://lh3.googleusercontent.com/avatar');
        });
    });

    describe('dismissOtherDevices', () => {
        it('sends a dismiss-all payload to every subscription excluding the caller device', async () => {
            const { service, fakePushSubscriptions } = createService();
            configure(service);
            fakePushSubscriptions.listForUser.mockResolvedValue([{ id: 'sub-2', endpoint: 'https://push.example/b', p256dh: 'p', auth: 'a' }]);

            await service.dismissOtherDevices('user-1', 'device-1');

            expect(fakePushSubscriptions.listForUser).toHaveBeenCalledWith('user-1', 'device-1');
            expect(webpush.sendNotification).toHaveBeenCalledWith(
                { endpoint: 'https://push.example/b', keys: { p256dh: 'p', auth: 'a' } },
                JSON.stringify({ type: 'dismiss-all' }),
            );
        });

        it('is a no-op when not configured', async () => {
            const { service, fakePushSubscriptions } = createService();

            await service.dismissOtherDevices('user-1', 'device-1');

            expect(fakePushSubscriptions.listForUser).not.toHaveBeenCalled();
        });

        it('also dismisses every FCM-registered device excluding the caller device', async () => {
            const { service, fakeFcmTokens, fakeFcm } = createService();
            configure(service);
            fakeFcm.isConfigured.mockReturnValue(true);
            fakeFcmTokens.listForUser.mockResolvedValue([{ id: 'token-row-2', token: 'fcm-token-2' }]);

            await service.dismissOtherDevices('user-1', 'device-1');

            expect(fakeFcmTokens.listForUser).toHaveBeenCalledWith('user-1', 'device-1');
            expect(fakeFcm.send).toHaveBeenCalledWith('fcm-token-2', { type: 'dismiss-all' });
        });
    });
});
