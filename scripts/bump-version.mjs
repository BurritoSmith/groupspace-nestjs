/**
 * Moves this repo to its next version and writes down what changed.
 *
 * Run by .github/workflows/deploy.yml before it builds, so that the artifact it ships and the tag
 * it later pushes are the same commit. Safe to run by hand — it only touches the working tree, and
 * never commits, tags or pushes; the workflow owns all of that.
 *
 *   node scripts/bump-version.mjs <patch|minor|major|none>
 *
 * Prints the resulting version as its last line, which is what the workflow captures.
 *
 * The CHANGELOG section is derived from `git log --first-parent` since the previous tag rather
 * than from a hand-maintained "Unreleased" list. Same source of truth the backfill used, and it
 * cannot silently go stale because nobody remembered to edit it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const level = process.argv[2] ?? 'patch';
if (!['patch', 'minor', 'major', 'none'].includes(level)) {
    console.error(`unknown bump level: ${level}`);
    process.exit(1);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

const currentVersion = readJson('package.json').version;

if (level === 'none') {
    console.log(`No bump requested — staying on ${currentVersion}.`);
    console.log(currentVersion);
    process.exit(0);
}

function next(version, by) {
    const [major, minor, patch] = version.split('.').map(Number);
    if (by === 'major') return `${major + 1}.0.0`;
    if (by === 'minor') return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

const version = next(currentVersion, level);

/*
 * The manifest AND its lockfile, which is what `npm version` would have done for us.
 *
 * Shelling out to npm is not an option: Node 22 on Windows refuses to spawn `npm.cmd` without a
 * shell, so the script would only have worked on the CI runner and not on the machine of anyone
 * checking what it does before pressing deploy. These are the only three fields npm touches for a
 * version change, and a lockfile left behind fails `npm ci` on the very next run.
 */
function setVersion(directory) {
    const manifest = `${directory}package.json`;
    const lockfile = `${directory}package-lock.json`;
    writeJson(manifest, { ...readJson(manifest), version });
    if (existsSync(lockfile)) {
        const lock = readJson(lockfile);
        lock.version = version;
        if (lock.packages?.['']) {
            lock.packages[''].version = version;
        }
        writeJson(lockfile, lock);
    }
}

setVersion('');
// The desktop shell ships from this repo and wraps this exact build, so a Converge 0.56.0 installer
// and a Converge 0.56.0 web build must be the same code. electron-builder reads this field for both
// the installer filename and app.getVersion().
if (existsSync('electron/package.json')) {
    setVersion('electron/');
}

// ---------------------------------------------------------------- version constant

const VERSION_FILE = existsSync('src/app/core/app-version.ts') ? 'src/app/core/app-version.ts' : 'src/app-version.ts';
const today = new Date().toISOString().slice(0, 10);
const constants = readFileSync(VERSION_FILE, 'utf8')
    .replace(/APP_VERSION = '[^']*'/, `APP_VERSION = '${version}'`)
    .replace(/BUILD_DATE = '[^']*'/, `BUILD_DATE = '${today}'`);
writeFileSync(VERSION_FILE, constants, 'utf8');

// ---------------------------------------------------------------- changelog

const MERGE = /^Merge pull request #(\d+) from [^/]+\/([^/]+)\/(.+)$/;
const SECTION = { feature: 'Added', fix: 'Fixed', perf: 'Changed', chore: 'Changed' };

/** Same rules as the historical backfill, so the whole file reads consistently. */
function classify(subject) {
    const match = MERGE.exec(subject);
    if (!match) {
        const prefix = /^add(ed)?\b/i.test(subject) ? 'feature' : /^fix\b/i.test(subject) ? 'fix' : 'chore';
        return { prefix, pr: null };
    }
    return { prefix: match[2], pr: Number(match[1]) };
}

const previousTag = git('describe', '--tags', '--abbrev=0');
const remote = git('remote', 'get-url', 'origin')
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');

const landed = git('log', '--first-parent', '--format=%H%x1f%s', `${previousTag}..HEAD`)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
        const [sha, subject] = line.split('\x1f');
        const { prefix, pr } = classify(subject);
        // "Merge pull request #N from …" says nothing; the branch's own commits say what changed.
        const changes = MERGE.test(subject)
            ? git('log', '--format=%s', `${sha}^1..${sha}^2`).split('\n').filter(Boolean).reverse()
            : [subject];
        return { section: SECTION[prefix] ?? 'Changed', pr, changes };
    })
    .reverse(); // newest first, matching how the file reads

const grouped = new Map();
for (const entry of landed) {
    const bullets = grouped.get(entry.section) ?? [];
    for (const change of entry.changes) {
        bullets.push(`- ${change}${entry.pr ? ` ([#${entry.pr}](${remote}/pull/${entry.pr}))` : ''}`);
    }
    grouped.set(entry.section, bullets);
}

const body = ['Added', 'Fixed', 'Changed']
    .filter((section) => grouped.has(section))
    .flatMap((section) => [`### ${section}`, '', ...grouped.get(section), ''])
    .join('\n');

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const release = [`## [${version}] - ${today}`, '', body || '_No changes recorded._\n'].join('\n');

const withRelease = changelog.replace(
    /## \[Unreleased\]\n\n_Nothing yet\._\n/,
    `## [Unreleased]\n\n_Nothing yet._\n\n${release}`,
);
if (withRelease === changelog) {
    console.error('Could not find the Unreleased placeholder in CHANGELOG.md — refusing to guess where the release goes.');
    process.exit(1);
}

writeFileSync(
    'CHANGELOG.md',
    withRelease
        .replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${remote}/compare/v${version}...HEAD`)
        .replace(/^(\[Unreleased\]: .*)$/m, `$1\n[${version}]: ${remote}/compare/${previousTag}...v${version}`),
    'utf8',
);

console.log(`${currentVersion} -> ${version} (${landed.length} change${landed.length === 1 ? '' : 's'} since ${previousTag})`);
console.log(version);
