/**
 * Validation for the one piece of a reaction that comes from the client: the emoji itself.
 *
 * Same shape as sanitizeAttachment in chat-attachment-url.ts — a hand-written narrowing function
 * that returns the cleaned value or null, rather than a class-validator DTO (this repo has none).
 * The string is about to be persisted and broadcast to everyone in the room, so "it's only an
 * emoji" is exactly the assumption worth not making: nothing stops a hand-written socket client
 * from sending a paragraph, or markup, and having it render inside every participant's chat.
 */

/**
 * Long enough for the longest thing anyone actually reacts with — a four-person family ZWJ sequence
 * is 11 UTF-16 units, and a flag is 4 — and far short of anything that could be a payload.
 */
const MAX_EMOJI_LENGTH = 16;

/**
 * Every code point allowed anywhere in the string.
 *
 * Emoji_Component covers the pieces that are not themselves pictographic but legitimately appear
 * inside a sequence: skin-tone modifiers, regional indicators (the two letters that make a flag),
 * and the digits/`#`/`*` that carry a keycap. Because that set includes plain ASCII digits, this
 * test alone would accept "123" — hence the separate requirement below.
 *
 * \u200d is the zero-width joiner and \ufe0f the emoji variation selector; both are written as
 * escapes rather than pasted literally, since neither renders as anything in an editor.
 */
const ALLOWED_CHARS = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f)+$/u;

/**
 * At least one code point that carries actual emoji meaning, so an Emoji_Component-only string like
 * "123" can't pass the character test above on the strength of its digits alone.
 *
 * Three things qualify, and all three are needed:
 *   - Extended_Pictographic, which is nearly everything (👍, ❤, 😂 …)
 *   - a regional indicator, because a flag is TWO of them and no pictograph at all — a
 *     pictograph-only requirement rejects every flag in the picker
 *   - U+20E3, the combining enclosing keycap, for the same reason: a keycap emoji is a plain ASCII
 *     digit followed by VS16 and that mark, with nothing pictographic anywhere in it.
 */
const HAS_EMOJI_MEANING = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{20E3}]/u;

/**
 * The cleaned emoji, or null to reject the reaction outright.
 *
 * Rejects rather than trims/truncates: unlike an attachment's display hints, there is no partially
 * usable version of a bad emoji, and silently storing a truncated sequence would render as mojibake
 * for everyone. The caller turns null into an `{ ok: false }` ack.
 */
export function sanitizeReactionEmoji(raw: unknown): string | null {
    if (typeof raw !== 'string') {
        return null;
    }
    // No trim() first — whitespace inside or around a reaction means the client sent something
    // other than a single emoji, and guessing which part was meant is worse than refusing.
    if (raw.length === 0 || raw.length > MAX_EMOJI_LENGTH) {
        return null;
    }
    if (!ALLOWED_CHARS.test(raw) || !HAS_EMOJI_MEANING.test(raw)) {
        return null;
    }
    return raw;
}
