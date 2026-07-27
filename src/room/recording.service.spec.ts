import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RecordingService } from './recording.service';

describe('RecordingService', () => {
    let service: RecordingService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [RecordingService, { provide: PrismaService, useValue: {} }],
        }).compile();
        service = module.get<RecordingService>(RecordingService);
    });

    describe('buildPlaybackUrls (no RECORDINGS_GCS_BUCKET configured — local dev)', () => {
        const call = (row: Parameters<(typeof service)['buildPlaybackUrls']>[0]) =>
            (service as unknown as { buildPlaybackUrls: typeof service.buildPlaybackUrls }).buildPlaybackUrls(row);

        it('returns a null url before the recording has stopped', async () => {
            const { url } = await call({
                filename: 'a.mp4',
                gcsPath: null,
                gcsUploadedAt: null,
                stoppedAt: null,
                thumbnailStatus: null,
                thumbnailUpdatedAt: null,
            });
            expect(url).toBeNull();
        });

        it('serves the local file URL once stopped, even with a gcsPath assigned but not yet uploaded', async () => {
            const { url } = await call({
                filename: 'a.mp4',
                gcsPath: 'room/session/a.mp4',
                gcsUploadedAt: null,
                stoppedAt: new Date(),
                thumbnailStatus: null,
                thumbnailUpdatedAt: null,
            });
            expect(url).toContain('/recordings/a.mp4');
        });

        it('returns a null thumbnailUrl when thumbnailStatus is null', async () => {
            const { thumbnailUrl } = await call({
                filename: 'a.mp4',
                gcsPath: null,
                gcsUploadedAt: null,
                stoppedAt: new Date(),
                thumbnailStatus: null,
                thumbnailUpdatedAt: null,
            });
            expect(thumbnailUrl).toBeNull();
        });

        it('builds a cache-busted thumbnail URL when a thumbnail exists', async () => {
            const updatedAt = new Date('2026-01-01T00:00:00Z');
            const { thumbnailUrl } = await call({
                filename: 'a.mp4',
                gcsPath: null,
                gcsUploadedAt: null,
                stoppedAt: new Date(),
                thumbnailStatus: 'live',
                thumbnailUpdatedAt: updatedAt,
            });
            expect(thumbnailUrl).toContain('a.thumb.jpg');
            expect(thumbnailUrl).toContain(`?v=${updatedAt.getTime()}`);
        });
    });

    describe('path helpers', () => {
        it('derives the temp recording path via string replace', () => {
            const result = (service as unknown as { tempRecordingPath: (p: string) => string }).tempRecordingPath('/recordings/a.mp4');
            expect(result).toBe('/recordings/a.recording.mp4');
        });

        it('derives the thumbnail path via string replace', () => {
            const result = (service as unknown as { thumbnailPath: (p: string) => string }).thumbnailPath('/recordings/a.mp4');
            expect(result).toBe('/recordings/a.thumb.jpg');
        });
    });
});
