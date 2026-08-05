import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';

/**
 * Guards the handful of operator-only endpoints against a shared secret in `X-Admin-Token`, checked
 * against `APP_ADMIN_TOKEN`.
 *
 * A shared secret rather than a role on User, deliberately: the caller is the release workflow, not
 * a person, so there is no account to hang a role off and no sign-in for it to perform. Adding an
 * admin concept to the user model to serve one CI step would be the bigger change, and one this app
 * has no other use for yet.
 *
 * Refuses outright when APP_ADMIN_TOKEN is unset, rather than falling open — the opposite of how
 * VAPID/FCM degrade to a no-op when unconfigured, because "push quietly does nothing" is a
 * missing feature while "anyone can broadcast to every install" is an open door.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const expected = process.env.APP_ADMIN_TOKEN ?? '';
        const request = context.switchToHttp().getRequest<Request>();
        const header = request.headers['x-admin-token'];
        const provided = typeof header === 'string' ? header : '';
        if (!expected || !provided || !constantTimeEquals(provided, expected)) {
            throw new UnauthorizedException('Missing or invalid admin token');
        }
        return true;
    }
}

/** `timingSafeEqual` throws on a length mismatch, which would leak the secret's length through the
 *  difference between a 401 and a 500 — so lengths are compared first and the buffers are only
 *  handed over when they already match. */
function constantTimeEquals(provided: string, expected: string): boolean {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}
