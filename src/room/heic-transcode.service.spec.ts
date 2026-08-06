import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { HeicTranscodeService } from './heic-transcode.service';

/**
 * A stand-in for the spawned heif-convert, following VideoThumbnailService's own test pattern:
 * override the protected spawn() seam so nothing here launches a real decoder.
 *
 * `onSpawn` receives the working directory the service chose (read back off the args), which is how
 * a test writes the output file the real binary would have produced.
 */
class FakeHeicTranscodeService extends HeicTranscodeService {
    lastArgs: string[] = [];

    constructor(
        private readonly onSpawn: (args: string[]) => Promise<{ code: number }>,
        private readonly spawnError?: Error,
    ) {
        super();
    }

    protected override spawn(args: string[]): ChildProcess {
        this.lastArgs = args;
        const child = new EventEmitter() as ChildProcess;
        (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
        (child as unknown as { kill: () => void }).kill = () => undefined;

        // Deferred so the caller has attached its listeners before anything fires, exactly as a real
        // child process behaves.
        setImmediate(() => {
            if (this.spawnError) {
                child.emit('error', this.spawnError);
                return;
            }
            void this.onSpawn(this.lastArgs).then(({ code }) => child.emit('exit', code, null));
        });
        return child;
    }
}

/** The directory the service is working in, recovered from the input path it passed the binary. */
function workDirOf(args: string[]): string {
    const input = args[args.length - 2];
    return input.slice(0, input.lastIndexOf('in.heic') - 1);
}

const heic = Buffer.from('fake-heic-bytes');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('HeicTranscodeService', () => {
    it('returns the JPEG the decoder wrote', async () => {
        const service = new FakeHeicTranscodeService(async (args) => {
            await fs.writeFile(`${workDirOf(args)}/out.jpg`, jpeg);
            return { code: 0 };
        });

        await expect(service.toJpeg(heic)).resolves.toEqual(jpeg);
    });

    // heif-convert appends an index per top-level image when a file holds more than one — a burst, or
    // a Live Photo — so the exact filename it was given does not exist. The first is the frame the
    // phone itself presents as the photo.
    it('picks up the first image when the decoder indexes its output instead', async () => {
        const service = new FakeHeicTranscodeService(async (args) => {
            const dir = workDirOf(args);
            await fs.writeFile(`${dir}/out-2.jpg`, Buffer.from([0x02]));
            await fs.writeFile(`${dir}/out-1.jpg`, jpeg);
            return { code: 0 };
        });

        await expect(service.toJpeg(heic)).resolves.toEqual(jpeg);
    });

    it('resolves null when the decoder exits non-zero', async () => {
        const service = new FakeHeicTranscodeService(async () => ({ code: 1 }));

        await expect(service.toJpeg(heic)).resolves.toBeNull();
    });

    // The normal state of a Windows dev machine, where the binary is absent exactly as ffmpeg is.
    it('resolves null when the binary is missing entirely', async () => {
        const service = new FakeHeicTranscodeService(async () => ({ code: 0 }), Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

        await expect(service.toJpeg(heic)).resolves.toBeNull();
    });

    it('resolves null when the decoder claims success but writes nothing', async () => {
        const service = new FakeHeicTranscodeService(async () => ({ code: 0 }));

        await expect(service.toJpeg(heic)).resolves.toBeNull();
    });

    it('leaves no temp directory behind, on success or failure', async () => {
        const succeeding = new FakeHeicTranscodeService(async (args) => {
            await fs.writeFile(`${workDirOf(args)}/out.jpg`, jpeg);
            return { code: 0 };
        });
        await succeeding.toJpeg(heic);
        await expect(fs.access(workDirOf(succeeding.lastArgs))).rejects.toThrow();

        const failing = new FakeHeicTranscodeService(async () => ({ code: 1 }));
        await failing.toJpeg(heic);
        await expect(fs.access(workDirOf(failing.lastArgs))).rejects.toThrow();
    });
});
