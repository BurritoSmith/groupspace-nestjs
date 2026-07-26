import { Module } from '@nestjs/common';
import { GoogleAuthService } from './google-auth.service';
import { RecordingService } from './recording.service';
import { RoomGateway } from './room.gateway';
import { RoomService } from './room.service';
import { TurnCredentialsService } from './turn-credentials.service';

@Module({
    providers: [RoomGateway, RoomService, TurnCredentialsService, GoogleAuthService, RecordingService],
})
export class RoomModule {}
