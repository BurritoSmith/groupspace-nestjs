import { Body, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { ChatMediaService } from './chat-media.service';
import { SessionAuthGuard } from './session-auth.guard';
import { IChatAttachment } from './interfaces/room.interfaces';

/** This app's first REST controller besides the default Nest starter one — everything else is
 *  WebSocket-driven (see room.gateway.ts). A REST endpoint (not a socket emit) is deliberate here:
 *  it keeps a large upload's bytes off the same connection mediasoup signaling/chat text share
 *  (avoiding head-of-line blocking on that latency-sensitive traffic), gets multipart parsing,
 *  per-request size limits, and upload-progress events for free via HttpClient, and needs no
 *  change to Socket.io's own maxHttpBufferSize. */
@Controller('chat/media')
export class ChatMediaController {
    constructor(private readonly chatMediaService: ChatMediaService) {}

    @Post()
    @UseGuards(SessionAuthGuard)
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ChatMediaService.MAX_UPLOAD_BYTES } }))
    async upload(
        @UploadedFile() file: Express.Multer.File,
        @Body('roomName') roomName: string,
        @Body('width') width: string | undefined,
        @Body('height') height: string | undefined,
        @Body('durationMs') durationMs: string | undefined,
    ): Promise<{ attachment: IChatAttachment }> {
        const uploaded = await this.chatMediaService.uploadAttachment(file.buffer, roomName ?? '', file.mimetype ?? '');
        const kind: IChatAttachment['kind'] = uploaded.mimeType.startsWith('video/')
            ? 'video'
            : uploaded.mimeType === 'image/gif'
              ? 'gif'
              : uploaded.mimeType === 'application/pdf'
                ? 'pdf'
                : 'image';

        // Unlike image/video, a pdf's thumbnail is generated HERE, not by the client — client-side
        // rendering (pdfjs-dist in the browser, mirroring how a video's poster frame is generated
        // on-device) turned out not to work reliably in practice, so ChatMediaService renders it
        // server-side instead. It's also the only source of a pdf's width/height, since there is no
        // client-side render to have measured them from.
        const pdfThumbnail = kind === 'pdf' ? await this.chatMediaService.generatePdfThumbnail(file.buffer, roomName ?? '') : null;

        const attachment: IChatAttachment = {
            id: randomUUID(),
            kind,
            url: uploaded.url,
            storagePath: uploaded.storagePath,
            // client fills this in separately with a client-generated poster frame, when it has one
            // — except a pdf, whose thumbnail (if generation succeeded) is already uploaded above.
            thumbnailUrl: pdfThumbnail?.url ?? null,
            mimeType: uploaded.mimeType,
            width: pdfThumbnail?.width ?? parseOptionalPositiveInt(width),
            height: pdfThumbnail?.height ?? parseOptionalPositiveInt(height),
            durationMs: parseOptionalPositiveInt(durationMs),
            sizeBytes: file.buffer.length,
            name: file.originalname ? file.originalname.slice(0, 255) : null,
        };
        return { attachment };
    }
}

function parseOptionalPositiveInt(value: string | undefined): number | null {
    if (!value) {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}
