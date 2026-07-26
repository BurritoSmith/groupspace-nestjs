import { Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

// Not sensitive — OAuth client IDs are designed to be public (embedded in every
// frontend that uses them). Only the client secret is sensitive, and this ID-token
// verification flow never needs it.
const GOOGLE_CLIENT_ID = '370019109527-0e02va07coeguv0mj7ohnsd8pfsklda8.apps.googleusercontent.com';

export interface IGoogleProfile {
    displayName: string;
    pictureUrl: string;
}

/** Verifies Google Identity Services ID tokens server-side, so peer identity (name,
 * photo) is never trusted from client-supplied strings — only from a signature- and
 * audience-checked token. */
@Injectable()
export class GoogleAuthService {
    private readonly client = new OAuth2Client(GOOGLE_CLIENT_ID);

    async verify(idToken: string): Promise<IGoogleProfile | null> {
        try {
            const ticket = await this.client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
            const payload = ticket.getPayload();
            if (!payload?.name) {
                return null;
            }
            return { displayName: payload.name, pictureUrl: payload.picture ?? '' };
        } catch {
            return null;
        }
    }
}
