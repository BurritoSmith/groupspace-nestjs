import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminTokenGuard } from './admin-token.guard';
import { AppUpdateController } from './app-update.controller';
import { ChatMediaController } from './chat-media.controller';
import { ChatMediaService } from './chat-media.service';
import { ChatReactionService } from './chat-reaction.service';
import { ChatService } from './chat.service';
import { FcmService } from './fcm.service';
import { FcmTokenController } from './fcm-token.controller';
import { FcmTokenService } from './fcm-token.service';
import { GifsController } from './gifs.controller';
import { GiphyService } from './giphy.service';
import { HeicTranscodeService } from './heic-transcode.service';
import { GoogleAuthService } from './google-auth.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { LinkPreviewService } from './link-preview.service';
import { MODULE_CATALOG } from './module-manifest';
import { MODULE_CATALOG_VALUE } from '../modules/module-registry';
import { PdfThumbnailService } from './pdf-thumbnail.service';
import { RoomProvisioningService } from './room-provisioning.service';
import { PushNotificationService } from './push-notification.service';
import { PushSubscriptionController } from './push-subscription.controller';
import { PushSubscriptionService } from './push-subscription.service';
import { RecordingService } from './recording.service';
import { RoomGateway } from './room.gateway';
import { RoomMembershipService } from './room-membership.service';
import { RoomService } from './room.service';
import { RoomsController } from './rooms.controller';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';
import { TurnCredentialsService } from './turn-credentials.service';
import { UsersService } from './users.service';
import { UserSettingsController } from './user-settings.controller';
import { UserSettingsService } from './user-settings.service';
import { VideoThumbnailService } from './video-thumbnail.service';

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
    controllers: [
        ChatMediaController,
        GifsController,
        InvitationsController,
        UserSettingsController,
        RoomsController,
        PushSubscriptionController,
        FcmTokenController,
        AppUpdateController,
    ],
    providers: [
        // The module catalog, injected rather than imported by anything under src/room — which is
        // what lets the room layer provision an IEP room without ever naming one. src/modules/
        // module-registry.ts is the only file that knows the full list.
        { provide: MODULE_CATALOG, useValue: MODULE_CATALOG_VALUE },
        RoomProvisioningService,
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
        PdfThumbnailService,
        VideoThumbnailService,
        HeicTranscodeService,
        LinkPreviewService,
        GiphyService,
        SessionAuthGuard,
        AdminTokenGuard,
        InvitationsService,
        RoomMembershipService,
        PushSubscriptionService,
        FcmTokenService,
        FcmService,
        PushNotificationService,
    ],
})
export class RoomModule {}
