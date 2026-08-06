import { SetMetadata } from '@nestjs/common';
import { Capability } from './capabilities';

export const REQUIRED_CAPABILITY = 'requiredCapability';

/**
 * Declares what a route needs, in the vocabulary the resolver speaks.
 *
 * A capability rather than a role, everywhere, so that changing who holds something is one line in
 * the resolver instead of a sweep through the controllers. `@RequireCapability(ROOM_INVITE)` also
 * says what the route is FOR in a way `@Roles('owner', 'moderator')` never does.
 */
export const RequireCapability = (capability: Capability) => SetMetadata(REQUIRED_CAPABILITY, capability);
