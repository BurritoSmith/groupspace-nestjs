import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpException, HttpStatus, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ROOM_CONFIGURE, ROOM_ENABLE_MODULE, ROOM_INVITE } from './capabilities';
import { PasscodeAttempts } from './passcode-attempts';
import { RequireCapability } from './require-capability.decorator';
import { RoomCapabilityGuard } from './room-capability.guard';
import { RoomInvitationService } from './room-invitation.service';
// `import type` because these appear in decorated method signatures: with isolatedModules and
// emitDecoratorMetadata both on, TypeScript emits a runtime reference for a parameter's type, and
// an interface has none to emit (TS1272).
import type { IIssueInvitationInput, IIssuedInvitation } from './room-invitation.service';
import { RoomMembershipService, IMyRoom } from './room-membership.service';
import { canonicalRoomName } from './room-name';
import { RoomProvisioningService } from './room-provisioning.service';
import type { ICreateRoomInput, IRoomSummary, RoomVisibility } from './room-provisioning.service';
import { SessionAuthGuard } from './session-auth.guard';

type AuthedRequest = Request & { userId?: string };

/** What a non-member is told about a private room: that it is there, and how one gets in. Not its
 *  module list, not who made it. Enough to render "this room needs a passcode" and nothing that
 *  describes a meeting they are not part of. */
export interface IRoomDoorway {
    name: string;
    visibility: RoomVisibility;
    hasPasscode: boolean;
    isMember: boolean;
}

/**
 * Rooms: the ones you have been in, and now the ones you make.
 *
 * REST rather than socket messages for the same reason `GET /rooms/mine` already was — all of this
 * happens BEFORE joining a room, which is the only point at which the gateway learns who you are.
 */
@Controller('rooms')
@UseGuards(SessionAuthGuard, RoomCapabilityGuard)
export class RoomsController {
    constructor(
        private readonly roomMembership: RoomMembershipService,
        private readonly provisioning: RoomProvisioningService,
        private readonly invitations: RoomInvitationService,
        private readonly attempts: PasscodeAttempts,
    ) {}

    @Get('mine')
    async mine(@Req() request: AuthedRequest): Promise<{ rooms: IMyRoom[] }> {
        return { rooms: await this.roomMembership.listForUser(request.userId ?? '') };
    }

    @Post()
    async create(@Req() request: AuthedRequest, @Body() body: ICreateRoomInput): Promise<IRoomSummary> {
        return this.provisioning.create(request.userId ?? '', body ?? { name: '' });
    }

    /** Redeeming an invitation. Static path, declared before `:roomName` so it is not swallowed by
     *  it, and unguarded by capability because the whole point is that the caller is not a member
     *  of that room yet. */
    @Post('invitations/accept')
    async acceptInvitation(@Req() request: AuthedRequest, @Body() body: { token?: string }): Promise<{ roomName: string }> {
        if (!body?.token) {
            throw new BadRequestException('An invitation token is required.');
        }
        return this.invitations.accept(body.token, request.userId ?? '');
    }

    /**
     * What this room is — or that it is not there, which is what the join screen needs to decide
     * between joining and offering to create it.
     *
     * A private room a caller is not in reveals only that it exists and how to get in. That much is
     * unavoidable: the create step has to know whether the name is taken.
     */
    @Get(':roomName')
    async describe(@Req() request: AuthedRequest, @Param('roomName') roomName: string): Promise<IRoomSummary | IRoomDoorway | null> {
        const summary = await this.provisioning.describe(roomName);
        if (!summary) {
            return null;
        }

        const context = await this.provisioning.contextFor(roomName, request.userId ?? '');
        if (summary.visibility === 'private' && !context) {
            return { name: summary.name, visibility: summary.visibility, hasPasscode: summary.hasPasscode, isMember: false };
        }
        return summary;
    }

    @Patch(':roomName')
    @RequireCapability(ROOM_CONFIGURE)
    async configure(@Param('roomName') roomName: string, @Body() body: { visibility?: RoomVisibility; passcode?: string | null }): Promise<IRoomSummary | null> {
        if (body?.visibility) {
            await this.provisioning.setVisibility(roomName, body.visibility);
        }
        // `undefined` means "leave it alone"; `null` means "remove it". They are different requests
        // and conflating them would make clearing a passcode impossible.
        if (body?.passcode !== undefined) {
            await this.provisioning.setPasscode(roomName, body.passcode);
        }
        return this.provisioning.describe(roomName);
    }

    @Post(':roomName/modules')
    @RequireCapability(ROOM_ENABLE_MODULE)
    async enableModule(@Req() request: AuthedRequest, @Param('roomName') roomName: string, @Body() body: { moduleId?: string }): Promise<IRoomSummary | null> {
        if (!body?.moduleId) {
            throw new BadRequestException('A moduleId is required.');
        }
        await this.provisioning.enableModule(roomName, body.moduleId, request.userId ?? '');
        return this.provisioning.describe(roomName);
    }

    @Delete(':roomName/modules/:moduleId')
    @RequireCapability(ROOM_ENABLE_MODULE)
    async disableModule(@Param('roomName') roomName: string, @Param('moduleId') moduleId: string): Promise<IRoomSummary | null> {
        await this.provisioning.disableModule(roomName, moduleId);
        return this.provisioning.describe(roomName);
    }

    @Post(':roomName/invitations')
    @RequireCapability(ROOM_INVITE)
    async invite(@Req() request: AuthedRequest, @Param('roomName') roomName: string, @Body() body: IIssueInvitationInput): Promise<IIssuedInvitation> {
        if (!body?.email) {
            throw new BadRequestException('An email address is required.');
        }
        return this.invitations.issue(roomName, request.userId ?? '', body);
    }

    @Get(':roomName/invitations')
    @RequireCapability(ROOM_INVITE)
    async listInvitations(@Param('roomName') roomName: string) {
        return { invitations: await this.invitations.listPending(roomName) };
    }

    @Delete(':roomName/invitations/:invitationId')
    @RequireCapability(ROOM_INVITE)
    async revokeInvitation(@Param('roomName') roomName: string, @Param('invitationId') invitationId: string): Promise<void> {
        await this.invitations.revoke(roomName, invitationId);
    }

    /**
     * Getting into a private room with its passcode.
     *
     * Rate limited per (room, user), and the lockout is reported as such rather than as another
     * wrong answer — somebody who has been locked out needs to know that waiting is the fix, not
     * keep typing. A correct passcode clears the run, so two fumbles then success costs nothing.
     */
    @Post(':roomName/join')
    async joinWithPasscode(@Req() request: AuthedRequest, @Param('roomName') roomName: string, @Body() body: { passcode?: string }): Promise<{ joined: true }> {
        const userId = request.userId ?? '';
        const name = canonicalRoomName(roomName);

        if (this.attempts.isLocked(name, userId)) {
            // @nestjs/common has no TooManyRequestsException, so the status is named explicitly.
            throw new HttpException('Too many attempts. Try again in a few minutes.', HttpStatus.TOO_MANY_REQUESTS);
        }
        if (!body?.passcode) {
            throw new BadRequestException('A passcode is required.');
        }

        if (!(await this.provisioning.checkPasscode(name, body.passcode))) {
            this.attempts.recordFailure(name, userId);
            this.attempts.prune();
            throw new ForbiddenException('That passcode is not right.');
        }

        this.attempts.clear(name, userId);
        await this.roomMembership.recordVisit(userId, name);
        return { joined: true };
    }
}
