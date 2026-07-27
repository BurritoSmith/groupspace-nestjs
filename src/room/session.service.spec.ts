import { JwtService } from '@nestjs/jwt';
import { SessionService } from './session.service';

describe('SessionService', () => {
    function createService(secret = 'test-secret'): SessionService {
        return new SessionService(new JwtService({ secret, signOptions: { expiresIn: '30d' } }));
    }

    it('issues a token that verify() decodes back to the same userId', () => {
        const service = createService();
        const token = service.issue('user-123');
        // jwt.verify() also returns standard claims (iat, exp) alongside our payload —
        // toMatchObject rather than toEqual since we only care about userId here.
        expect(service.verify(token)).toMatchObject({ userId: 'user-123' });
    });

    it('returns null for a garbage string', () => {
        const service = createService();
        expect(service.verify('not-a-real-token')).toBeNull();
    });

    it('returns null for a token signed with a different secret (a stale/foreign token)', () => {
        const issuer = createService('secret-a');
        const verifier = createService('secret-b');
        const token = issuer.issue('user-123');
        expect(verifier.verify(token)).toBeNull();
    });
});
