import { fcmNotificationFor } from './fcm-notification';

describe('fcmNotificationFor', () => {
    it('titles a chat message with the room and bodies it the way push-sw.js does', () => {
        expect(
            fcmNotificationFor({
                type: 'chat-message',
                roomName: 'lobby',
                senderDisplayName: 'Clay',
                messageText: 'hello there',
                messageId: 'msg-1',
                tag: 'chat:lobby',
            }),
        ).toEqual({ title: 'lobby', body: 'Clay: hello there', tag: 'chat:lobby' });
    });

    it("carries an attachment's image through for the OS to render big", () => {
        const content = fcmNotificationFor({
            type: 'chat-message',
            roomName: 'lobby',
            senderDisplayName: 'Clay',
            messageText: 'look',
            messageId: 'msg-1',
            tag: 'chat:lobby',
            imageUrl: 'https://storage.example/pic.jpg',
        });

        expect(content?.imageUrl).toBe('https://storage.example/pic.jpg');
    });

    // Absent rather than undefined-valued, matching how the payload builders themselves guard
    // optional keys — an explicit `imageUrl: undefined` would be sent to FCM as a real field.
    it('omits imageUrl entirely when the message had no attachment', () => {
        const content = fcmNotificationFor({
            type: 'chat-message',
            roomName: 'lobby',
            senderDisplayName: 'Clay',
            messageText: 'hi',
            messageId: 'msg-1',
            tag: 'chat:lobby',
        });

        expect(content && 'imageUrl' in content).toBe(false);
    });

    it('renders a peer-joined notification', () => {
        expect(fcmNotificationFor({ type: 'peer-joined', roomName: 'lobby', joinerDisplayName: 'Burr', tag: 'peer-joined:lobby' })).toEqual({
            title: 'lobby',
            body: 'Burr joined',
            tag: 'peer-joined:lobby',
        });
    });

    it('renders an app-update announcement naming the version', () => {
        const content = fcmNotificationFor({
            type: 'app-update',
            platform: 'android',
            versionName: '0.56.0',
            versionCode: 560000,
            apkUrl: 'https://releases.example/a.apk',
        });

        expect(content?.body).toContain('0.56.0');
        expect(content?.tag).toBe('app-update');
    });

    // Giving this one a notification block would have it DRAW the very thing it exists to clear.
    it('returns null for dismiss-all, so it stays a silent data message', () => {
        expect(fcmNotificationFor({ type: 'dismiss-all' })).toBeNull();
    });
});
