import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RoomMembershipService, IMyRoom } from './room-membership.service';
import { SessionAuthGuard } from './session-auth.guard';

/**
 * Rooms a signed-in user has previously visited — feeds the join-room screen's typeahead.
 *
 * REST rather than a socket message for the same reason `UserSettingsController` already is: the
 * gateway only learns who you are at join-room (`socket.data.userId`), but this list is needed
 * BEFORE ever joining a room, while the user is still typing a room name to join.
 */
@Controller('rooms')
@UseGuards(SessionAuthGuard)
export class RoomsController {
    constructor(private readonly roomMembership: RoomMembershipService) {}

    @Get('mine')
    async mine(@Req() request: Request & { userId?: string }): Promise<{ rooms: IMyRoom[] }> {
        return { rooms: await this.roomMembership.listForUser(request.userId ?? '') };
    }
}
