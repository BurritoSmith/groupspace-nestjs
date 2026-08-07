/*
 * Starts a Postgres for local development, from node_modules.
 *
 * This exists because a development machine may have no Postgres and no way to install one: the Mac
 * checkout has no Homebrew and no Docker, and installing either needs an admin password. This runs a
 * real Postgres binary as an ordinary user process, so `npm ci` is the whole setup.
 *
 * It is deliberately inert unless you run it. Adding embedded-postgres to devDependencies starts
 * nothing, installs no service, and does not touch a Postgres that is already on the machine — a
 * checkout with its own working Postgres just keeps pointing DATABASE_URL at it and never runs this.
 *
 * The port is 55432, not 5432, for the same reason: a machine already running Postgres on the
 * default port must not have this fail — or worse, appear to succeed against the wrong cluster.
 *
 *   node scripts/local-db.mjs start     # initialise if needed, then run until Ctrl-C
 *   node scripts/local-db.mjs stop
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseDir = resolve(repoRoot, '.local-db');

export const PORT = 55432;
export const USER = 'postgres';
export const PASSWORD = 'postgres';
export const DATABASE = 'converge';

const postgres = new EmbeddedPostgres({
    databaseDir,
    user: USER,
    password: PASSWORD,
    port: PORT,
    // Survives a restart. A throwaway cluster would mean re-running migrations and losing every
    // room and message on every boot, which makes it useless for the thing it is here for.
    persistent: true,
});

async function start() {
    // initialise() lays down a fresh cluster and fails on one that already exists, so this is the
    // difference between "first run" and "every run after".
    if (!existsSync(databaseDir)) {
        console.info('[local-db] Initialising a new cluster in .local-db …');
        await postgres.initialise();
    }

    await postgres.start();
    console.info(`[local-db] Postgres listening on ${PORT}.`);

    try {
        await postgres.createDatabase(DATABASE);
        console.info(`[local-db] Created database "${DATABASE}".`);
    } catch {
        // Already there, which is the normal case on every run but the first.
    }

    console.info(`[local-db] DATABASE_URL="postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}"`);
    console.info('[local-db] Ctrl-C to stop.');

    // The cluster is a separate process; keeping this one alive is what gives Ctrl-C something to
    // catch, so the database is shut down cleanly rather than left running headless.
    const shutDown = async () => {
        console.info('\n[local-db] Stopping …');
        await postgres.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutDown);
    process.on('SIGTERM', shutDown);
}

const command = process.argv[2] ?? 'start';
if (command === 'start') {
    await start();
} else if (command === 'stop') {
    await postgres.stop();
    console.info('[local-db] Stopped.');
} else {
    console.error(`[local-db] Unknown command "${command}". Use start or stop.`);
    process.exit(1);
}
