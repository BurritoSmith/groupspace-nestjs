import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AdminTokenGuard } from './admin-token.guard';

function contextWith(headers: Record<string, unknown>): ExecutionContext {
    return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as unknown as ExecutionContext;
}

describe('AdminTokenGuard', () => {
    const guard = new AdminTokenGuard();

    afterEach(() => {
        delete process.env.APP_ADMIN_TOKEN;
    });

    it('allows a request whose X-Admin-Token matches', () => {
        process.env.APP_ADMIN_TOKEN = 'super-secret';

        expect(guard.canActivate(contextWith({ 'x-admin-token': 'super-secret' }))).toBe(true);
    });

    it('rejects a wrong token', () => {
        process.env.APP_ADMIN_TOKEN = 'super-secret';

        expect(() => guard.canActivate(contextWith({ 'x-admin-token': 'wrong-secret' }))).toThrow(UnauthorizedException);
    });

    // timingSafeEqual throws outright on a length mismatch, so this would be a 500 rather than a
    // 401 if the lengths were not compared first.
    it('rejects a token of a different length without throwing anything but Unauthorized', () => {
        process.env.APP_ADMIN_TOKEN = 'super-secret';

        expect(() => guard.canActivate(contextWith({ 'x-admin-token': 'short' }))).toThrow(UnauthorizedException);
    });

    it('rejects a missing header', () => {
        process.env.APP_ADMIN_TOKEN = 'super-secret';

        expect(() => guard.canActivate(contextWith({}))).toThrow(UnauthorizedException);
    });

    // Fails CLOSED, unlike VAPID/FCM which degrade to a silent no-op when unconfigured: "push does
    // nothing" is a missing feature, "anyone can broadcast to every install" is an open door.
    it('rejects everything when APP_ADMIN_TOKEN is unset', () => {
        expect(() => guard.canActivate(contextWith({ 'x-admin-token': 'anything' }))).toThrow(UnauthorizedException);
        expect(() => guard.canActivate(contextWith({ 'x-admin-token': '' }))).toThrow(UnauthorizedException);
    });
});
