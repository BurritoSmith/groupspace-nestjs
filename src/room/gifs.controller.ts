import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { GiphyService } from './giphy.service';
import { SessionAuthGuard } from './session-auth.guard';
import { IGifSummary } from './interfaces/room.interfaces';

/** GIF search for the chat picker, proxied so the Giphy API key stays server-side — see
 *  GiphyService. Guarded like the media upload endpoint: this spends our provider quota, so it is
 *  for signed-in users of this app, not an open relay for anyone who finds the URL. */
@Controller('chat/gifs')
export class GifsController {
    constructor(private readonly giphy: GiphyService) {}

    /** Reports whether GIFs are usable at all, so the picker can say "not configured" instead of
     *  showing an empty grid that looks broken. Deliberately needs no auth: it exposes nothing but a
     *  boolean about our own deployment, and the picker wants it before the user has done anything. */
    @Get('config')
    config(): { configured: boolean } {
        return { configured: this.giphy.isConfigured() };
    }

    /** An empty `q` returns trending — that's what the tab shows before anything is typed. */
    @Get()
    @UseGuards(SessionAuthGuard)
    async search(@Query('q') q: string | undefined, @Query('offset') offset: string | undefined): Promise<{ gifs: IGifSummary[] }> {
        return { gifs: await this.giphy.search(q ?? '', parseOffset(offset)) };
    }
}

/** Anything unparseable is page one, rather than a 400 — a malformed offset is not worth failing a
 *  search over, and Giphy would reject a NaN anyway. */
function parseOffset(value: string | undefined): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}
