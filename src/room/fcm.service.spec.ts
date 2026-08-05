import { cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { FcmService } from './fcm.service';
import { PushPayload } from './push-payload.interface';

const sendMock = jest.fn();

jest.mock('firebase-admin/app', () => ({
    initializeApp: jest.fn(),
    cert: jest.fn().mockReturnValue('fake-credential'),
}));

jest.mock('firebase-admin/messaging', () => ({
    getMessaging: jest.fn(() => ({ send: sendMock })),
}));

function configure(service: FcmService) {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ projectId: 'test-project' });
    service.onModuleInit();
}

const chatMessagePayload: PushPayload = {
    type: 'chat-message',
    roomName: 'lobby',
    senderDisplayName: 'Sender',
    messageText: 'hello there',
    messageId: 'msg-1',
    tag: 'chat:lobby',
};

describe('FcmService', () => {
    afterEach(() => {
        jest.clearAllMocks();
        delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    });

    describe('onModuleInit', () => {
        it('does not initialize firebase-admin when the service account env var is missing', () => {
            delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
            const service = new FcmService();

            service.onModuleInit();

            expect(initializeApp).not.toHaveBeenCalled();
            expect(service.isConfigured()).toBe(false);
        });

        it('does not initialize firebase-admin when the service account JSON is invalid', () => {
            process.env.FIREBASE_SERVICE_ACCOUNT_JSON = 'not json';
            const service = new FcmService();

            service.onModuleInit();

            expect(initializeApp).not.toHaveBeenCalled();
            expect(service.isConfigured()).toBe(false);
        });

        it('initializes firebase-admin with the parsed service account', () => {
            const service = new FcmService();

            configure(service);

            expect(cert).toHaveBeenCalledWith({ projectId: 'test-project' });
            expect(initializeApp).toHaveBeenCalledWith({ credential: 'fake-credential' });
            expect(service.isConfigured()).toBe(true);
        });
    });

    describe('send', () => {
        it('returns "error" without calling firebase-admin when not configured', async () => {
            const service = new FcmService();

            const result = await service.send('token-1', chatMessagePayload);

            expect(result).toBe('error');
            expect(sendMock).not.toHaveBeenCalled();
        });

        it('always carries the raw payload as data, so the tap handler has the full typed shape', async () => {
            const service = new FcmService();
            configure(service);
            sendMock.mockResolvedValue('message-id');

            const result = await service.send('token-1', chatMessagePayload);

            expect(result).toBe('ok');
            expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-1', data: { payload: JSON.stringify(chatMessagePayload) } }));
        });

        // Without a `notification` block FCM renders nothing at all while the app is backgrounded
        // or killed — which is the case native push exists to cover.
        it('adds a notification block so the OS can render it with no app code running', async () => {
            const service = new FcmService();
            configure(service);
            sendMock.mockResolvedValue('message-id');

            await service.send('token-1', chatMessagePayload);

            expect(sendMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    notification: { title: 'lobby', body: 'Sender: hello there' },
                    android: { notification: { tag: 'chat:lobby' } },
                    apns: { headers: { 'apns-collapse-id': 'chat:lobby' } },
                }),
            );
        });

        // It asks other devices to CLOSE notifications — a notification block would have it draw
        // the very thing it exists to clean up.
        it('leaves dismiss-all as a silent data-only message', async () => {
            const service = new FcmService();
            configure(service);
            sendMock.mockResolvedValue('message-id');

            await service.send('token-1', { type: 'dismiss-all' });

            expect(sendMock).toHaveBeenCalledWith({ token: 'token-1', data: { payload: JSON.stringify({ type: 'dismiss-all' }) } });
        });

        // APNs rejects the whole send if this header exceeds 64 bytes, which a long enough room name
        // would otherwise do.
        it('truncates a long collapse id to the 64 bytes APNs allows', async () => {
            const service = new FcmService();
            configure(service);
            sendMock.mockResolvedValue('message-id');
            const roomName = 'r'.repeat(200);

            await service.send('token-1', { ...chatMessagePayload, roomName, tag: `chat:${roomName}` });

            const sent = sendMock.mock.calls[0][0] as { apns: { headers: Record<string, string> } };
            expect(sent.apns.headers['apns-collapse-id']).toHaveLength(64);
        });

        it('reports "gone" when the token is no longer registered', async () => {
            const service = new FcmService();
            configure(service);
            sendMock.mockRejectedValue({ code: 'messaging/registration-token-not-registered' });

            const result = await service.send('token-1', { type: 'dismiss-all' });

            expect(result).toBe('gone');
        });

        it('reports "gone" for an invalid registration token', async () => {
            const service = new FcmService();
            configure(service);
            sendMock.mockRejectedValue({ code: 'messaging/invalid-registration-token' });

            const result = await service.send('token-1', { type: 'dismiss-all' });

            expect(result).toBe('gone');
        });

        it('reports "error" on any other failure, without treating it as gone', async () => {
            const service = new FcmService();
            configure(service);
            sendMock.mockRejectedValue({ code: 'messaging/internal-error' });

            const result = await service.send('token-1', { type: 'dismiss-all' });

            expect(result).toBe('error');
        });
    });
});
