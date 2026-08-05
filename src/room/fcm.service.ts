import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { cert, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { PushPayload } from './push-payload.interface';

export type FcmSendResult = 'ok' | 'gone' | 'error';

/** Sends Firebase Cloud Messaging data messages to a single registration token. Nothing calls
 *  `send()` yet — see push-notification.service.ts — this exists ahead of a Capacitor mobile app
 *  (Android push is FCM-only) so the backend send path is ready rather than rebuilt later. */
@Injectable()
export class FcmService implements OnModuleInit {
    private readonly logger = new Logger(FcmService.name);
    private configured = false;

    onModuleInit(): void {
        const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        if (!serviceAccountJson) {
            // Missing in most local dev setups until someone opts in — mirrors VAPID's own stance
            // in PushNotificationService: push just silently no-ops rather than blocking startup.
            this.logger.warn('FIREBASE_SERVICE_ACCOUNT_JSON not configured — FCM push notifications are disabled.');
            return;
        }
        let serviceAccount: ServiceAccount;
        try {
            serviceAccount = JSON.parse(serviceAccountJson) as ServiceAccount;
        } catch (error) {
            this.logger.error(`FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON — FCM push notifications are disabled. ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        initializeApp({ credential: cert(serviceAccount) });
        this.configured = true;
    }

    isConfigured(): boolean {
        return this.configured;
    }

    /** `data`-only (no `notification` field) so every platform's client code decides for itself
     *  whether/how to render — matching how PushNotificationService's web-push payloads carry a
     *  raw PushPayload rather than a pre-rendered notification. */
    async send(token: string, payload: PushPayload): Promise<FcmSendResult> {
        if (!this.configured) {
            return 'error';
        }
        try {
            await getMessaging().send({ token, data: { payload: JSON.stringify(payload) } });
            return 'ok';
        } catch (error: unknown) {
            const code = (error as { code?: string }).code;
            if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
                return 'gone';
            }
            this.logger.warn(`FCM send failed (${code ?? 'unknown'}): ${error instanceof Error ? error.message : String(error)}`);
            return 'error';
        }
    }
}
