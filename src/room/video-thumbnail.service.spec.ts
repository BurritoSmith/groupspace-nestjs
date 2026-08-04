import { EventEmitter } from 'node:events';
import { VideoThumbnailService } from './video-thumbnail.service';

/** A fake ChildProcess: an EventEmitter with stdout/stderr sub-emitters and a kill() spy — enough
 *  for captureFrame's own listeners (stdout/stderr 'data', 'error', 'exit') without spawning a
 *  real ffmpeg process. */
function fakeFfmpegProcess() {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: jest.Mock };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    return proc;
}

describe('VideoThumbnailService', () => {
    let service: VideoThumbnailService;

    beforeEach(() => {
        jest.useFakeTimers();
        service = new VideoThumbnailService();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    function stubSpawn(): { proc: ReturnType<typeof fakeFfmpegProcess>; spawnSpy: jest.Mock } {
        const proc = fakeFfmpegProcess();
        const spawnSpy = jest.spyOn(service as unknown as { spawn: (args: string[]) => unknown }, 'spawn').mockReturnValue(proc) as unknown as jest.Mock;
        return { proc, spawnSpy };
    }

    function stubLoadImage(dimensions: { width: number; height: number } | Error) {
        const spy = jest.spyOn(service as unknown as { loadImage: (buffer: Buffer) => Promise<unknown> }, 'loadImage');
        if (dimensions instanceof Error) {
            spy.mockRejectedValue(dimensions);
        } else {
            spy.mockResolvedValue(dimensions);
        }
        return spy;
    }

    it('resolves the captured frame and its rendered pixel size on a clean exit', async () => {
        const { proc } = stubSpawn();
        stubLoadImage({ width: 640, height: 360 });

        const resultPromise = service.generate('https://storage.googleapis.com/bucket/room/video.mp4');
        proc.stdout.emit('data', Buffer.from([0xff, 0xd8, 0xff]));
        proc.stdout.emit('data', Buffer.from([0xe0]));
        proc.emit('exit', 0, null);
        const result = await resultPromise;

        expect(result).toEqual({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), width: 640, height: 360 });
    });

    it('passes the resolved input straight through to ffmpeg as the -i argument', async () => {
        const { proc, spawnSpy } = stubSpawn();
        stubLoadImage({ width: 100, height: 100 });

        const resultPromise = service.generate('/local/chat-media/room/video.mp4');
        proc.stdout.emit('data', Buffer.from([1]));
        proc.emit('exit', 0, null);
        await resultPromise;

        expect(spawnSpy.mock.calls[0][0]).toContain('/local/chat-media/room/video.mp4');
    });

    it('resolves null, never rejects, when ffmpeg exits non-zero', async () => {
        const { proc } = stubSpawn();

        const resultPromise = service.generate('https://x/video.mp4');
        proc.stderr.emit('data', Buffer.from('moov atom not found'));
        proc.emit('exit', 1, null);

        await expect(resultPromise).resolves.toBeNull();
    });

    it('resolves null when ffmpeg produces no bytes despite a zero exit code', async () => {
        const { proc } = stubSpawn();

        const resultPromise = service.generate('https://x/video.mp4');
        proc.emit('exit', 0, null);

        await expect(resultPromise).resolves.toBeNull();
    });

    it('resolves null when the ffmpeg binary itself fails to start', async () => {
        const { proc } = stubSpawn();

        const resultPromise = service.generate('https://x/video.mp4');
        proc.emit('error', new Error('ENOENT'));

        await expect(resultPromise).resolves.toBeNull();
    });

    it('kills the process and resolves null after the timeout, rather than hanging forever', async () => {
        const { proc } = stubSpawn();

        const resultPromise = service.generate('https://x/video.mp4');
        jest.advanceTimersByTime(15_000);
        // The kill() itself doesn't resolve anything — production ffmpeg would then emit its own
        // 'exit' (SIGKILL), which is what actually settles the promise.
        proc.emit('exit', null, 'SIGKILL');
        const result = await resultPromise;

        expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
        expect(result).toBeNull();
    });

    it('resolves null when the captured frame fails to decode (a corrupt/truncated frame)', async () => {
        const { proc } = stubSpawn();
        stubLoadImage(new Error('unsupported image format'));

        const resultPromise = service.generate('https://x/video.mp4');
        proc.stdout.emit('data', Buffer.from([1, 2, 3]));
        proc.emit('exit', 0, null);

        await expect(resultPromise).resolves.toBeNull();
    });

    describe('readImageDimensions', () => {
        it('returns the decoded image\'s own width/height', async () => {
            stubLoadImage({ width: 320, height: 240 });

            await expect(service.readImageDimensions(Buffer.from([1]))).resolves.toEqual({ width: 320, height: 240 });
        });

        it('returns null rather than throwing when decoding fails', async () => {
            stubLoadImage(new Error('bad image'));

            await expect(service.readImageDimensions(Buffer.from([1]))).resolves.toBeNull();
        });
    });
});
