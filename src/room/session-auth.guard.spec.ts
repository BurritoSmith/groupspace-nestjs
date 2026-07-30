import { UnauthorizedException } from '@nestjs/common';
import { SessionAuthGuard } from './session-auth.guard';

function fakeContext(headers: Record<string, string | undefined>) {
    const request: { headers: Record<string, string | undefined>; userId?: string } = { headers };
    return {
        context: { switchToHttp: () => ({ getRequest: () => request }) } as never,
        request,
    };
}

describe('SessionAuthGuard', () => {
    it('allows the request and stamps req.userId when the bearer token verifies', () => {
        const fakeSessionService = { verify: jest.fn().mockReturnValue({ userId: 'user-1' }) };
        const guard = new SessionAuthGuard(fakeSessionService as never);
        const { context, request } = fakeContext({ authorization: 'Bearer good-token' });

        const allowed = guard.canActivate(context);

        expect(allowed).toBe(true);
        expect(fakeSessionService.verify).toHaveBeenCalledWith('good-token');
        expect(request.userId).toBe('user-1');
    });

    it('throws UnauthorizedException when the Authorization header is missing entirely', () => {
        const fakeSessionService = { verify: jest.fn() };
        const guard = new SessionAuthGuard(fakeSessionService as never);
        const { context } = fakeContext({});

        expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
        expect(fakeSessionService.verify).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException when the header is present but not a Bearer token', () => {
        const fakeSessionService = { verify: jest.fn() };
        const guard = new SessionAuthGuard(fakeSessionService as never);
        const { context } = fakeContext({ authorization: 'Basic abc123' });

        expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
        expect(fakeSessionService.verify).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException when the token fails to verify (expired/forged)', () => {
        const fakeSessionService = { verify: jest.fn().mockReturnValue(null) };
        const guard = new SessionAuthGuard(fakeSessionService as never);
        const { context } = fakeContext({ authorization: 'Bearer bad-token' });

        expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });
});
