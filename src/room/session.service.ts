import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface ISessionPayload {
    userId: string;
}

/** Issues and verifies this app's own long-lived session credential — separate from the Google
 *  ID token, which is only ever used for the very first sign-in. A user who has one of these
 *  stays logged into the app regardless of the Google token's ~1hr lifetime; see room.gateway.ts's
 *  onJoinRoom, which reissues a fresh one on every successful join (sliding expiry). */
@Injectable()
export class SessionService {
    constructor(private readonly jwt: JwtService) {}

    issue(userId: string): string {
        return this.jwt.sign({ userId } satisfies ISessionPayload);
    }

    verify(token: string): ISessionPayload | null {
        try {
            return this.jwt.verify<ISessionPayload>(token);
        } catch {
            return null;
        }
    }
}
