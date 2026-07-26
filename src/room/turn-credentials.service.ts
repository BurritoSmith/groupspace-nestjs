import { Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';

export interface ITurnCredentials {
    urls: string[];
    username: string;
    credential: string;
}

const TTL_SECONDS = 4 * 60 * 60; // long enough to cover one call, short enough that a leaked credential expires quickly

/**
 * Generates coturn REST-API-style time-limited credentials
 * (https://github.com/coturn/coturn/blob/master/docs/turn-rest-api.md):
 * username = "<expiryUnixSeconds>:<peerId>", password = base64(HMAC-SHA1(secret, username)).
 */
@Injectable()
export class TurnCredentialsService {
    generateFor(peerId: string): ITurnCredentials | null {
        const secret = process.env.TURN_SECRET;
        const host = process.env.TURN_HOST;
        if (!secret || !host) {
            return null; // no TURN configured (e.g. local dev) — client falls back to host/srflx candidates only
        }
        const port = process.env.TURN_PORT ?? '3478';
        const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
        const username = `${expiry}:${peerId}`;
        const credential = createHmac('sha1', secret).update(username).digest('base64');
        return {
            urls: [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`],
            username,
            credential,
        };
    }
}
