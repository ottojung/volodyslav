/**
 * The ordinary publication's retained replay summary is cached per replica
 * and committed writer cut. Failed publications abandon the cache before
 * mutating any state; only successful atomic batches may install a new cut.
 */
const {
    appendJournalPublicationOps,
    maintainedRetainedState,
    serializeWriterState,
} = require("./journal_store");

/** @typedef {import('./journal_retained').RetainedReplayState} RetainedReplayState */
/** @typedef {import('./journal_retained').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('./journal').CommittedWriterState} CommittedWriterState */
/** @typedef {import('./journal').FinalizedPublication} FinalizedPublication */
/** @typedef {import('./database/root_database').JournalDatabase} JournalDatabase */

/** @param {string} fingerprint @param {CurrentInputKeysOfNode} currentInputKeysOfNode */
function makeRetainedPublicationCache(fingerprint, currentInputKeysOfNode) {
    /** @type {RetainedReplayState | undefined} */
    let retained;
    /** @type {string | undefined} */
    let replica;
    /** @type {string | undefined} */
    let committedText;
    return {
        /**
         * @param {JournalDatabase} journal
         * @param {Array<*>} operations
         * @param {FinalizedPublication} publication
         * @param {CommittedWriterState} previous
         * @param {string} activeReplica
         */
        async stage(journal, operations, publication, previous, activeReplica) {
            const oldStamp = JSON.stringify(serializeWriterState(previous));
            const cached = retained !== undefined && replica === activeReplica &&
                committedText === oldStamp ? retained : undefined;
            retained = undefined;
            replica = undefined;
            committedText = undefined;
            const next = await maintainedRetainedState(
                journal, fingerprint, currentInputKeysOfNode, publication.records, cached
            );
            const failure = await appendJournalPublicationOps(
                journal, operations, publication, next
            );
            if (failure !== undefined) throw failure;
            return {
                retained: next,
                committedText: JSON.stringify(serializeWriterState(publication.writerState)),
            };
        },
        /**
         * @param {{retained: RetainedReplayState, committedText: string} | undefined} result
         * @param {string} activeReplica
         */
        published(result, activeReplica) {
            if (result === undefined) return;
            retained = result.retained;
            committedText = result.committedText;
            replica = activeReplica;
        },
    };
}

module.exports = { makeRetainedPublicationCache };
