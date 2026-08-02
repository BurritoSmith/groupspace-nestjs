import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatMediaController } from './chat-media.controller';
import { ChatMediaService } from './chat-media.service';
import { ChatReactionService } from './chat-reaction.service';
import { ChatService } from './chat.service';
import { GifsController } from './gifs.controller';
import { GiphyService } from './giphy.service';
import { GoogleAuthService } from './google-auth.service';
import { LinkPreviewService } from './link-preview.service';
import { RecordingService } from './recording.service';
import { RoomGateway } from './room.gateway';
import { RoomService } from './room.service';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';
import { TurnCredentialsService } from './turn-credentials.service';
import { UsersService } from './users.service';
import { UserSettingsController } from './user-settings.controller';
import { UserSettingsService } from './user-settings.service';

@Module({
    imports: [
        // registerAsync's factory defers reading process.env until actual instantiation
        // (after dotenv has definitely loaded), rather than register()'s eager read at
        // module-decorator-evaluation time, which could race ahead of main.ts's env loading.
        // Throws rather than degrading gracefully (unlike e.g. TURN_SECRET, which is genuinely
        // optional) — signing session tokens with an undefined secret would silently produce
        // forgeable credentials instead of a clean startup failure.
        JwtModule.registerAsync({
            useFactory: () => {
                const secret = process.env.SESSION_JWT_SECRET;
                if (!secret) {
                    throw new Error('SESSION_JWT_SECRET must be set — refusing to start with session tokens unsigned/forgeable.');
                }
                return { secret, signOptions: { expiresIn: '30d' } };
            },
        }),
    ],
    controllers: [ChatMediaController, GifsController, UserSettingsController],
    providers: [
        RoomGateway,
        RoomService,
        TurnCredentialsService,
        GoogleAuthService,
        RecordingService,
        UsersService,
        UserSettingsService,
        ChatService,
        ChatReactionService,
        SessionService,
        ChatMediaService,
        LinkPreviewService,
        GiphyService,
        SessionAuthGuard,
    ],
})
export class RoomModule {}
