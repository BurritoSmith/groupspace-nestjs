import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { SessionService } from './session.service';

/** This app's first REST-side auth guard — everything else is a Socket.io gateway that reads
 *  socket.data set at join-room time (see room.gateway.ts). Reuses SessionService.verify() (the
 *  same session JWT already issued at join-room and held by the frontend) against a plain
 *  `Authorization: Bearer <token>` header, and stamps req.userId for the controller to read. */
@Injectable()
export class SessionAuthGuard implements CanActivate {
    constructor(private readonly sessionService: SessionService) {}

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request & { userId?: string }>();
        const header = request.headers.authorization;
        const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
        const payload = token ? this.sessionService.verify(token) : null;
        if (!payload) {
            throw new UnauthorizedException('Missing or invalid session token');
        }
        request.userId = payload.userId;
        return true;
    }
}
