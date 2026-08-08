/**
 * The vocabulary shared by `PushSubscription.platform` and `FcmToken.platform`.
 *
 * These two columns are compared directly against each other — PushNotificationService suppresses a
 * web-push subscription when the same user has an FCM token on the SAME platform string — so the
 * two sides have to agree on spelling exactly. A typo would not throw anywhere; it would just
 * silently stop the suppression and hand the user duplicate notifications, which is the whole thing
 * this feature exists to prevent. Hence one allowlist, used by both controllers.
 */
export const PUSH_PLATFORMS = ['android', 'ios', 'desktop', 'web'] as const;

export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/** Platforms a native app can actually register an FCM token from. */
export const NATIVE_PUSH_PLATFORMS = ['android', 'ios'] as const;

export type NativePushPlatform = (typeof NATIVE_PUSH_PLATFORMS)[number];

/**
 * `null` for anything not in the allowlist, so each caller picks its own fallback rather than
 * inheriting one: a web-push subscription degrades to 'web' (unknown — participates in no
 * suppression, which is the safe direction), while an FCM registration rejects outright, since a
 * token whose platform we cannot name can never be matched OR announced to.
 */
export function normalizePushPlatform(value: unknown): PushPlatform | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    return (PUSH_PLATFORMS as readonly string[]).includes(normalized) ? (normalized as PushPlatform) : null;
}

export function normalizeNativePushPlatform(value: unknown): NativePushPlatform | null {
    const platform = normalizePushPlatform(value);
    return platform === 'android' || platform === 'ios' ? platform : null;
}

/**
 * Drops the web-push subscriptions a user's native app has taken over, so one person holding both
 * does not get the same notification twice on the same handset.
 *
 * The match is per-PLATFORM, not per-user: an Android FCM token silences that user's Android
 * browser subscriptions and nothing else, so installing the phone app never costs them the
 * notifications on their desktop browser. There is no way to be more precise than this — a
 * Capacitor WebView and mobile Chrome have separate storage partitions, so the same physical phone
 * mints two unrelated deviceIds and no column anywhere ties them together.
 *
 * The deliberate edge case: someone running the app on one Android phone and a browser on a SECOND
 * Android phone loses push on the second one. Judged the right trade against the alternative of
 * every dual-install user getting doubled notifications on their primary device.
 *
 * 'web' (a subscription registered before the platform column existed) matches nothing and is
 * therefore never suppressed — the safe direction, since the cost of a stale row is at worst the
 * duplicate we already have today, versus silently losing notifications entirely.
 */
export function suppressNativeDuplicates<T extends { platform: string }>(subscriptions: readonly T[], nativeTokens: readonly { platform: string }[]): T[] {
    if (nativeTokens.length === 0) {
        return [...subscriptions];
    }
    const nativePlatforms = new Set(nativeTokens.map((token) => token.platform));
    return subscriptions.filter((subscription) => !nativePlatforms.has(subscription.platform));
}

/**
 * Drops the subscriptions that must never be sent a CONTENT-LESS push — today only `dismiss-all`,
 * the one payload in the union that shows the user nothing.
 *
 * iOS is the whole reason this exists. WebKit enforces the `userVisibleOnly: true` contract that
 * every subscription is created under: if a push event ends without a notification actually on
 * screen, it counts as a silent push, and after a few of them iOS revokes the subscription outright.
 * push-sw.js's dismissAll() shows a throwaway notification and immediately closes it, which is
 * enough to satisfy Chrome but leaves nothing displayed — so on iOS it reads as silent and burns a
 * strike every single time.
 *
 * What makes that especially nasty rather than merely wasteful is what happens next: a revoked
 * subscription answers 404/410, and PushNotificationService.send() treats that as expiry and DELETES
 * the row. The user is never told. Their toggle still says notifications are on, and no notification
 * ever arrives again — the exact "it worked for a bit, then just stopped" shape.
 *
 * Losing cross-device dismissal on iOS is a small, contained cost by comparison: at worst an already
 * read notification sits in Notification Center until it is swiped away. Keeping the subscription
 * alive is worth far more than tidying it up.
 *
 * Only 'ios' is filtered, and that is exhaustive rather than a guess — a legacy row at the 'web'
 * default cannot be a hidden iOS one, because iOS web push could not be subscribed to at all before
 * the frontend shipped a web app manifest (see src/index.html there). Android and desktop Chrome are
 * happy with the show-then-close trick and keep the behaviour unchanged.
 */
export function dropSilentPushIntolerant<T extends { platform: string }>(subscriptions: readonly T[]): T[] {
    return subscriptions.filter((subscription) => subscription.platform !== 'ios');
}
