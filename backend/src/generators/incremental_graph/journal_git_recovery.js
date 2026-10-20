/**
 * Git-backed installation recovery for the existing generators checkpoint transport.
 *
 * No new root capability or persisted transport locator: the existing git,
 * environment, creator and deleter facilities identify and read the same
 * hostname branch which ordinary checkpoint/synchronization already uses.
 *
 * A branch absence is a definite absence only when ls-remote succeeds.
 * The held snapshot is checked out at one commit; a read/clone/parse error
 * is indeterminate and must never be reinterpreted as definite absence.
 */
const path = require('path');
const defaultBranch = require('../../gitstore').defaultBranch;
const {
    makeJournalAuthor,
    makeJournalReplica,
    makeReplicaSource,
    projectRetainedJournal,
    tryDecodeJournalRecord,
    journalAuthorToString,
    journalSequenceToString,
    journalSequenceAtFrontier,
    compareJournalSequence,
    compareAuthorityTime,
    isSemanticEvent,
    replicaFrontier,
} = require('./journal');
const { deserializeWriterState } = require('./journal_store');
const { makeContinuationSafeSnapshot, makeInstallationRecoverySource } =
    require('./journal_recovery_source');
const {
    deriveInputPositions,
    nodeKeyStringToString,
    parseGraphScheme,
    stringToNodeKeyString,
} = require('./database');

/**
 * @param {{reader: import('../../filesystem/reader').FileReader}} capabilities
 * @param {string} filepath
 */
async function readJson(capabilities, filepath) {
    return JSON.parse(await capabilities.reader.readFileAsText(filepath));
}

/**
 * Read one immutable rendered Git checkpoint without constructing any live
 * receiver, fingerprint, or alternate installation.
 *
 * @param {{reader: import('../../filesystem/reader').FileReader, scanner: import('../../filesystem/dirscanner').DirScanner}} capabilities
 * @param {string} replicaPath
 */
async function snapshotFromRenderedReplica(capabilities, replicaPath) {
    const journalDirectory = path.join(replicaPath, 'journal');
    /** @type {Map<string, Array<import('./journal').JournalRecord>>} */
    const byAuthor = new Map();
    const members = await capabilities.scanner.scanDirectory(journalDirectory);
    for (const member of members.sort((a, b) => a.path.localeCompare(b.path))) {
        const name = path.basename(member.path);
        if (!name.startsWith('record|')) {
            continue;
        }
        const fields = /^record\|([a-z]{9,})\|([0-9]{30})$/.exec(name);
        if (fields === null) {
            throw new Error('recovery checkpoint contains an invalid Journal record key');
        }
        const record = tryDecodeJournalRecord(await capabilities.reader.readFileAsText(member.path));
        if (record instanceof Error) {
            throw record;
        }
        // Reject files which claim a different coordinate in their body.
        if (journalAuthorToString(record.id.author) !== fields[1] ||
            journalSequenceToString(record.id.sequence).padStart(30, '0') !== fields[2]) {
            throw new Error('recovery checkpoint record key disagrees with its semantic identity');
        }
        const records = byAuthor.get(fields[1]);
        if (records === undefined) {
            byAuthor.set(fields[1], [record]);
        } else {
            records.push(record);
        }
    }
    /** @type {Array<[import('./journal').JournalAuthor, ReadonlyArray<import('./journal').JournalRecord>]>} */
    const streams = [];
    for (const authorText of [...byAuthor.keys()].sort()) {
        const author = makeJournalAuthor(authorText);
        if (author instanceof Error) {
            throw author;
        }
        const records = byAuthor.get(authorText);
        if (records === undefined) {
            throw new Error('recovery checkpoint lost a writer stream');
        }
        streams.push([author, records]);
    }
    const replica = makeJournalReplica(streams);
    if (replica instanceof Error) {
        throw replica;
    }
    const fingerprint = await readJson(capabilities, path.join(replicaPath, 'global', 'fingerprint'));
    const writerState = deserializeWriterState(
        await readJson(capabilities, path.join(journalDirectory, 'state')), fingerprint
    );
    if (writerState instanceof Error) {
        throw writerState;
    }
    // The committed pair is authoritative metadata, not an independently
    // restorable claim. A held checkpoint must agree with the records it holds:
    // otherwise restoration could install a writer head or imported frontier
    // naming events which were never restored.
    const observedFrontier = replicaFrontier(replica);
    if (observedFrontier.size !== writerState.committedFrontier.size) {
        throw new Error('recovery checkpoint committed frontier disagrees with retained Journal');
    }
    for (const [writer, sequence] of observedFrontier) {
        if (compareJournalSequence(
            sequence, journalSequenceAtFrontier(writerState.committedFrontier, writer)
        ) !== 0) {
            throw new Error('recovery checkpoint committed frontier disagrees with retained Journal');
        }
    }
    if (compareJournalSequence(
        writerState.writerHead, journalSequenceAtFrontier(observedFrontier, writerState.localWriter)
    ) !== 0) {
        throw new Error('recovery checkpoint local writer head disagrees with retained Journal');
    }
    for (const records of replica.values()) {
        for (const record of records) {
            if (isSemanticEvent(record) &&
                compareAuthorityTime(record.authorityTime, writerState.authorityHighWater) > 0) {
                throw new Error('recovery checkpoint authority high-water is below a retained record');
            }
        }
    }
    const graphSchemeString = await readJson(capabilities, path.join(replicaPath, 'global', 'graph_scheme'));
    const scheme = parseGraphScheme(graphSchemeString);
    const projection = await projectRetainedJournal({
        source: makeReplicaSource(replica),
        localWriter: writerState.localWriter,
        currentInputKeysOfNode: (keyText) => {
            const key = stringToNodeKeyString(keyText);
            if (key instanceof Error) {
                return undefined;
            }
            try {
                return deriveInputPositions(scheme, key).map(nodeKeyStringToString);
            } catch {
                return undefined;
            }
        },
    });
    if (projection instanceof Error) {
        throw projection;
    }
    const snapshot = makeContinuationSafeSnapshot({
        localWriter: writerState.localWriter,
        records: [...replica.values()].flat(),
        projection,
        writerState,
        databaseVersion: await readJson(capabilities, path.join(replicaPath, 'global', 'version')),
        graphSchemeString,
    });
    if (snapshot instanceof Error) {
        throw snapshot;
    }
    return snapshot;
}

/**
 * Construct a source from existing infrastructure, not by adding a capability.
 * @param {{ environment: import('../../environment').Environment, git: import('../../subprocess/command').Command, creator: import('../../filesystem/creator').FileCreator, deleter: import('../../filesystem/deleter').FileDeleter, reader: import('../../filesystem/reader').FileReader, scanner: import('../../filesystem/dirscanner').DirScanner }} capabilities
 */
function gitInstallationRecoverySource(capabilities) {
    return makeInstallationRecoverySource({
        async queryInstallationRecovery() {
            const remote = capabilities.environment.generatorsRepository();
            const branch = defaultBranch(capabilities);
            // Do not collapse a failed ls-remote into definite absence.
            const response = await capabilities.git.call(
                'ls-remote', '--heads', '--', remote, 'refs/heads/' + branch
            );
            if (response.stdout.trim() === '') {
                return null;
            }
            // The checkout fixes one immutable cut even if another writer advances
            // the remote branch while we are restoring.
            const temp = await capabilities.creator.createTemporaryDirectory();
            try {
                await capabilities.git.call(
                    'clone', '--depth', '1', '--single-branch', '--branch', branch,
                    '--', remote, temp
                );
                return await snapshotFromRenderedReplica(capabilities, path.join(temp, 'rendered', 'r'));
            } finally {
                await capabilities.deleter.deleteDirectory(temp);
            }
        },
    });
}

module.exports = { gitInstallationRecoverySource, snapshotFromRenderedReplica };
