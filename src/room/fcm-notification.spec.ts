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

/*
 * A private room may exist precisely because its subject is confidential. Its own name must not be
 * what a lock screen shows — moving a child's name out of the address bar and onto a notification,
 * in front of whoever is stood next to the parent, would not be an improvement. The server decides
 * the title; this file renders whatever it is told and knows nothing about privacy.
 */
describe('fcmNotificationFor — a title the server chose', () => {
    it('prefers the supplied title over the room name for a message', () => {
        const content = fcmNotificationFor({
            type: 'chat-message',
            roomName: 'e3k7mq20xbvr8h5a',
            title: 'Converge',
            senderDisplayName: 'Alice',
            messageText: 'hello',
            messageId: 'm1',
            tag: 'chat:e3k7mq20xbvr8h5a',
        });

        expect(content?.title).toBe('Converge');
    });

    it('prefers the supplied title over the room name for a join', () => {
        const content = fcmNotificationFor({
            type: 'peer-joined',
            roomName: 'e3k7mq20xbvr8h5a',
            title: 'Converge',
            joinerDisplayName: 'Alice',
            tag: 'peer-joined:e3k7mq20xbvr8h5a',
        });

        expect(content?.title).toBe('Converge');
    });

    /* Absent is the ordinary public room, and every payload built before this field existed. */
    it('falls back to the room name when the server sent no title', () => {
        const content = fcmNotificationFor({
            type: 'chat-message',
            roomName: 'standup',
            senderDisplayName: 'Alice',
            messageText: 'hello',
            messageId: 'm1',
            tag: 'chat:standup',
        });

        expect(content?.title).toBe('standup');
    });

    /* The generated identifier is meaningless to a human and must never be what they are shown —
     * this is the failure the title field exists to make impossible. */
    it('never shows a generated identifier when a title was supplied', () => {
        const content = fcmNotificationFor({
            type: 'chat-message',
            roomName: 'e3k7mq20xbvr8h5a',
            title: 'Converge',
            senderDisplayName: 'Alice',
            messageText: 'hello',
            messageId: 'm1',
            tag: 'chat:e3k7mq20xbvr8h5a',
        });

        expect(content?.title).not.toContain('e3k7mq');
    });
});
