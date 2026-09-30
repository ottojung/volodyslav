/**
 * The Journal half of a Journal-aware migration cutover.
 *
 * `incremental-graph-journal-migrations.md` §22 makes migration an exclusive
 * maintenance transition with one atomic cutover, and §9 requires the inactive target
 * to be built before that cutover happens. This module performs the target's Journal
 * build: it carries the retained history of the source replica into the inactive
 * target, then appends the M1 records over that converted history.
 *
 * Carrying retained history is not optional bookkeeping. The target replica's graph
 * state is a projection of its Journal, so a target which received values without the
 * history which explains them has nodes with no value occurrence to validate against,
 * and the first ordinary publication after the cutover fails. The two halves therefore
 * have to land in the same target: the carried history, and the M1 records which state
 * what the migration changed about it.
 *
 * Representation rewriting proper is §9a's `JournalFormatCodec`, owned by the migration
 * definition rather than by this module. This module is the identity-codec seam: it
 * carries each retained record under the target's own current-format encoding, which
 * is the correct rewrite whenever the retained history is already in the running
 * format. A migration whose source version differs supplies its codec by rewriting the
 * records it hands to `carryRetainedJournal`.
 */

const {
    appendJournalPublicationOps,
    readCommittedWriterState,
} = require("./journal_store");
const {
    finalizeMigrationEmission,
    makeJournalPublicationError,
} = require("./journal");

/** @typedef {import('./journal/errors').AnyJournalError} JournalError */
/** @typedef {import('./journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('./journal/migration_emission').MigrationIntent} MigrationIntent */
/** @typedef {import('./database/root_database').JournalDatabase} JournalDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */

/**
 * Make the inactive target's Journal be the source replica's retained history.
 *
 * Records, the current-occurrence index, and the committed writer state all travel
 * together, because a target which received records without the writer state would
 * allocate the next own-writer coordinate over history it already holds.
 *
 * The target Journal is *replaced*, not merged. The inactive target is the migration's
 * to build, and §22 step 3 makes its retained history the converted source history
 * plus what the migration appends. A key the source does not retain is therefore not
 * retained history: it is residue of an earlier attempt at this same cutover, left
 * behind when that attempt failed after writing and before the pointer selected the
 * target. Carrying the source's keys without removing the target's would let a record
 * or an occurrence-index entry from a discarded attempt survive into a replica the
 * next run declares the current one, where the retained authority would select an
 * occurrence the migration never decided.
 *
 * Nothing a source retains is ever removed: the deletion is over the target's keys
 * the source lacks, which is exactly the set this call is responsible for having
 * written. No retained record is rewritten or dropped, only an inactive replica's
 * own leftovers.
 *
 * The copy is one batch of the target storage, so the target's Journal is either
 * entirely without the retained history or entirely with it.
 *
 * @param {SchemaStorage} sourceStorage
 * @param {SchemaStorage} targetStorage
 * @returns {Promise<void>}
 */
async function carryRetainedJournal(sourceStorage, targetStorage) {
    const sourceJournal = sourceStorage.journal;
    const targetJournal = targetStorage.journal;
    /** @type {Set<string>} */
    const sourceKeys = new Set();
    /** @type {Array<import('./database/root_database').DatabaseBatchOperation>} */
    const operations = [];
    for await (const sourceKey of sourceJournal.keys()) {
        const key = String(sourceKey);
        const value = await sourceJournal.get(sourceKey);
        if (value === undefined) {
            throw makeJournalPublicationError(
                "the migration source journal key " + key + " has no stored value"
            );
        }
        sourceKeys.add(key);
        operations.push(targetJournal.putOp(sourceKey, value));
    }
    for await (const targetKey of targetJournal.keys()) {
        if (sourceKeys.has(String(targetKey))) {
            continue;
        }
        operations.push(targetJournal.delOp(targetKey));
    }
    if (operations.length > 0) {
        await targetStorage.batch(operations);
    }
}

/**
 * Append the M1 publication of one migration to the target replica's Journal.
 *
 * The publication is appended to the converted history the target already carries, so
 * the M1 records are causally after the complete converted frontier, which is the
 * migration observation cut §13 requires.
 *
 * @param {SchemaStorage} targetStorage
 * @param {CommittedWriterState} state - The committed state the converted history leaves behind.
 * @param {ReadonlyArray<MigrationIntent>} intents - The M1 value/absence transition.
 * @param {number} publicationInstant - Epoch milliseconds of the migration publication.
 * @param {number} allocatorWatermark - The allocation watermark the target durably establishes.
 * @returns {Promise<CommittedWriterState | JournalError>}
 */
async function publishMigrationM1(targetStorage, state, intents, publicationInstant, allocatorWatermark) {
    if (intents.length === 0 && allocatorWatermark <= state.allocatorWatermark) {
        return state;
    }
    const publication = finalizeMigrationEmission({
        state,
        intents,
        publicationInstant,
        allocatorWatermark,
    });
    if (publication instanceof Error) {
        return publication;
    }
    /** @type {Array<import('./database/root_database').DatabaseBatchOperation>} */
    const operations = [];
    const rejected = appendJournalPublicationOps(targetStorage.journal, operations, publication);
    if (rejected !== undefined) {
        return rejected;
    }
    await targetStorage.batch(operations);
    return publication.writerState;
}

/**
 * Build the target replica's Journal for one migration and publish M1 over it.
 *
 * This is the whole Journal half of a cutover in one call: the source's retained
 * history travels into the inactive target, and the M1 records state what the
 * migration changed about that history. Both land before the cutover selects the
 * target, so a failure anywhere in between leaves the previous active pair selected.
 *
 * @param {SchemaStorage} sourceStorage - The still-active source replica.
 * @param {SchemaStorage} targetStorage - The inactive target replica being built.
 * @param {string} fingerprint - The local writer name.
 * @param {ReadonlyArray<MigrationIntent>} intents - The M1 value/absence transition.
 * @param {number} publicationInstant - Epoch milliseconds of the migration publication.
 * @param {number} allocatorWatermark - The allocation watermark the target establishes.
 * @returns {Promise<void>}
 */
async function buildMigrationJournal(sourceStorage, targetStorage, fingerprint, intents, publicationInstant, allocatorWatermark) {
    await carryRetainedJournal(sourceStorage, targetStorage);
    const sourceWriterState = await readCommittedWriterState(sourceStorage.journal, fingerprint);
    if (sourceWriterState instanceof Error) {
        throw sourceWriterState;
    }
    const targetWriterState = await publishMigrationM1(
        targetStorage,
        sourceWriterState,
        intents,
        publicationInstant,
        allocatorWatermark
    );
    if (targetWriterState instanceof Error) {
        throw targetWriterState;
    }
}

module.exports = {
    buildMigrationJournal,
};
