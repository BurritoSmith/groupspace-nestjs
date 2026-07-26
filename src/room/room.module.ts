import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { GoogleAuthService } from './google-auth.service';
import { RecordingService } from './recording.service';
import { RoomGateway } from './room.gateway';
import { RoomService } from './room.service';
import { TurnCredentialsService } from './turn-credentials.service';
import { UsersService } from './users.service';

@Module({
    providers: [RoomGateway, RoomService, TurnCredentialsService, GoogleAuthService, RecordingService, UsersService, ChatService],
})
export class RoomModule {}
