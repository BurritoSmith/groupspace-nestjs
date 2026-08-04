/**
 * What version of the Converge backend this build is.
 *
 * Written by the deploy workflow at the same moment it bumps package.json, and committed rather
 * than read from disk at runtime — the deploy ships `git archive HEAD`, so a committed constant is
 * guaranteed to be on the VM and to match the tag on that commit.
 *
 * Keep the shape: `docs/versioning.md` and .github/workflows/deploy.yml both depend on these two
 * lines being rewritable by a regex.
 */
export const APP_VERSION = '0.27.7';
export const BUILD_DATE = '2026-08-04';

/** When this process came up. Distinguishes "the deploy landed" from "the container has been
 *  sitting there since before it" — the two look identical from a version string alone. */
export const STARTED_AT = new Date().toISOString();
