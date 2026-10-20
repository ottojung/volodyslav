/**
 * Canonical bootstrap arbitration on the existing generators Git remote.
 *
 * The slot is a dedicated immutable Git ref, not a hostname/locator stored
 * inside IncrementalGraph. A new ref is installed only with an atomic
 * expected-absent lease; losing concurrent publishers read the winning cut.
 * No extra root capability or independent runtime configuration is introduced.
 */
const fs = require('fs/promises');
const path = require('path');
const {
    encodeJournalRecord,
    isJournalError,
    makeCanonicalBootstrapSnapshot,
    makeCohortBootstrapSource,
    makeJournalAuthor,
    makeJournalReplica,
    replicaFrontier,
    tryDecodeJournalRecord,
    journalAuthorToString,
} = require('./journal');

const { versionToString, stringToVersion } = require('./database');

const CANONICAL_BRANCH = 'journal-canonical-bootstrap';
const CANONICAL_REF = 'refs/heads/' + CANONICAL_BRANCH;
const ARTIFACT_FILE = 'canonical-bootstrap.json';

/** @param {import('./journal').CanonicalBootstrapCandidate} candidate */
function encodeCandidate(candidate) {
    return JSON.stringify({
        format: 1,
        creatorWriter: journalAuthorToString(candidate.creatorWriter),
        databaseVersion: versionToString(candidate.targetVersion),
        graphSchemeString: candidate.graphSchemeString,
        records: candidate.records.map(encodeJournalRecord),
    });
}

/** @param {unknown} value */
function decodeArtifact(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('the Git canonical slot is not an artifact object');
    }
    const format = Reflect.get(value, 'format');
    const creatorWriter = Reflect.get(value, 'creatorWriter');
    const databaseVersion = Reflect.get(value, 'databaseVersion');
    const graphSchemeString = Reflect.get(value, 'graphSchemeString');
    const encodedRecords = Reflect.get(value, 'records');
    if (format !== 1 || typeof creatorWriter !== 'string' ||
        typeof databaseVersion !== 'string' ||
        typeof graphSchemeString !== 'string' ||
        !Array.isArray(encodedRecords) || encodedRecords.length === 0) {
        throw new Error('the Git canonical slot carries malformed artifact metadata');
    }
    const writer = makeJournalAuthor(creatorWriter);
    if (isJournalError(writer)) {
        throw writer;
    }
    const records = [];
    for (const text of encodedRecords) {
        const record = tryDecodeJournalRecord(text);
        if (isJournalError(record)) {
            throw record;
        }
        records.push(record);
    }
    const replica = makeJournalReplica([[writer, records]]);
    if (isJournalError(replica)) {
        throw replica;
    }
    const artifact = makeCanonicalBootstrapSnapshot({
        records,
        creatorWriter: writer,
        bootstrapFrontier: replicaFrontier(replica),
        databaseVersion: stringToVersion(databaseVersion),
        graphSchemeString,
    });
    if (isJournalError(artifact)) {
        throw artifact;
    }
    return artifact;
}

/**
 * A successful query with no ref is a definite absence; every other read
 * failure is indeterminate and therefore fails startup.
 *
 * @param {{git: import('../../subprocess/command').Command, environment: import('../../environment').Environment, creator: import('../../filesystem/creator').FileCreator, deleter: import('../../filesystem/deleter').FileDeleter}} capabilities
 */
async function readGitCanonicalArtifact(capabilities) {
    const remote = capabilities.environment.generatorsRepository();
    const answer = await capabilities.git.call('ls-remote', '--heads', '--', remote, CANONICAL_REF);
    if (answer.stdout.trim() === '') {
        return null;
    }
    const temp = await capabilities.creator.createTemporaryDirectory();
    try {
        await capabilities.git.call(
            'clone', '--depth', '1', '--single-branch', '--branch', CANONICAL_BRANCH,
            '--', remote, temp
        );
        return decodeArtifact(JSON.parse(await fs.readFile(path.join(temp, ARTIFACT_FILE), 'utf8')));
    } finally {
        await capabilities.deleter.deleteDirectory(temp);
    }
}

/**
 * @param {{git: import('../../subprocess/command').Command, environment: import('../../environment').Environment, creator: import('../../filesystem/creator').FileCreator, deleter: import('../../filesystem/deleter').FileDeleter}} capabilities
 */
function gitCanonicalBootstrapSource(capabilities) {
    return makeCohortBootstrapSource({
        async queryCanonicalBootstrap() {
            return await readGitCanonicalArtifact(capabilities);
        },
        async publishCanonicalBootstrapIfAbsent(candidate) {
            const temp = await capabilities.creator.createTemporaryDirectory();
            const remote = capabilities.environment.generatorsRepository();
            try {
                await capabilities.git.call('init', '--initial-branch', CANONICAL_BRANCH, '--', temp);
                await fs.writeFile(path.join(temp, ARTIFACT_FILE), encodeCandidate(candidate), 'utf8');
                await capabilities.git.call('-C', temp, 'add', '--', ARTIFACT_FILE);
                await capabilities.git.call(
                    '-C', temp, '-c', 'user.name=Volodyslav',
                    '-c', 'user.email=bootstrap@localhost', 'commit', '-m',
                    'Publish immutable canonical Journal bootstrap'
                );
                try {
                    // The empty expected value is the key: a nonempty ref NEVER
                    // admits a write, even when this commit would fast-forward it.
                    await capabilities.git.call(
                        '-C', temp, 'push', '--porcelain',
                        '--force-with-lease=' + CANONICAL_REF + ':',
                        '--', remote, 'HEAD:' + CANONICAL_REF
                    );
                    const artifact = await readGitCanonicalArtifact(capabilities);
                    if (artifact === null) {
                        throw new Error('canonical publication returned without a durable artifact');
                    }
                    return { published: true, artifact };
                } catch (error) {
                    // A lost response may follow a successful publication. Resolve
                    // by observing the immutable slot, but NEVER retry with another
                    // candidate without first making this query.
                    const existing = await readGitCanonicalArtifact(capabilities);
                    if (existing !== null) {
                        return { alreadyExists: true, artifact: existing };
                    }
                    throw error;
                }
            } finally {
                await capabilities.deleter.deleteDirectory(temp);
            }
        },
    });
}
module.exports = { gitCanonicalBootstrapSource, readGitCanonicalArtifact, encodeCandidate, decodeArtifact };
