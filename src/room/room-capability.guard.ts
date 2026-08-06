import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Capability, IRoomContext, can } from './capabilities';
import { IModuleManifest, MODULE_CATALOG, capabilityResolvers } from './module-manifest';
import { REQUIRED_CAPABILITY } from './require-capability.decorator';
import { RoomProvisioningService } from './room-provisioning.service';

export type RequestWithRoom = Request & { userId?: string; roomContext?: IRoomContext };

/**
 * Turns `@RequireCapability(...)` into an answer, for the room named in the route.
 *
 * Runs after SessionAuthGuard, which is what stamps `req.userId`. Reads the room from `:roomName`,
 * so every guarded route has to carry it there — a capability is meaningless without knowing which
 * room it is about, and taking it from the body instead would let a request name one room in the
 * path and another in the payload.
 *
 * The context it builds is stashed on the request, so a handler that needs to know more than
 * yes/no — which module roles somebody holds, say — does not go and load it a second time.
 */
@Injectable()
export class RoomCapabilityGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly provisioning: RoomProvisioningService,
        @Inject(MODULE_CATALOG) private readonly catalog: IModuleManifest[],
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const required = this.reflector.getAllAndOverride<Capability | undefined>(REQUIRED_CAPABILITY, [context.getHandler(), context.getClass()]);
        // An unannotated route is not implicitly public — it is simply not this guard's business.
        // SessionAuthGuard has already established who is asking.
        if (!required) {
            return true;
        }

        const request = context.switchToHttp().getRequest<RequestWithRoom>();
        const userId = request.userId;
        const roomName = (request.params as Record<string, string> | undefined)?.roomName;
        if (!userId || !roomName) {
            throw new ForbiddenException('Not allowed.');
        }

        const roomContext = await this.provisioning.contextFor(roomName, userId);
        // Deliberately indistinguishable from "you lack the capability". Telling a stranger that a
        // room exists but they are not in it is a membership oracle, and for a room named after a
        // child that is worth more than it sounds.
        if (!roomContext || !can(roomContext, required, capabilityResolvers(this.catalog))) {
            throw new ForbiddenException('Not allowed.');
        }

        request.roomContext = roomContext;
        return true;
    }
}
