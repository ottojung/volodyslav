/**
 * Bounded durable staging of a receiver's retained Journal records.
 *
 * `incremental-graph-journal-sync.md` §Atomic publication and
 * `incremental-graph-journal-reset.md` §Atomicity both permit a transfer to stream
 * into inactive durable staging, with active state changing only at the final
 * replica-pointer cutover. The retained half of a publication is history-sized, so
 * folding it into the one cutover batch would hold the whole retained history in
 * RAM; this module stages it instead, in bounded chunks, into the inactive replica
 * the cutover will later select.
 *
 * ## Why the staging target is the inactive replica
 *
 * A publication targets the namespace which is about to become active, and that
 * namespace is not the active one until the pointer moves. Writing records into it
 * is therefore durable staging rather than a visible change: a fault at any point
 * before the cutover leaves the previously activated replica as the receiver, and
 * the cutover batch is the only write whose success is observed. A retry re-stages
 * the same deterministic record keys, so an abandoned partial stage is overwritten
 * rather than accumulated.
 *
 * ## Why the chunks are bounded
 *
 * Each record becomes one `put` operation under its own author-and-coordinate key,
 * and the writer flushes a full chunk before queueing the next, so the staging path
 * holds at most `RAW_BATCH_CHUNK_SIZE` operations plus the record being staged,
 * never the complete retained history. The chunk size is the database's own
 * `RAW_BATCH_CHUNK_SIZE`, so a staging batch is exactly the size the rest of the
 * tree already uses for large transfers.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../database/root_database').SchemaStorage} SchemaStorage */

const { RAW_BATCH_CHUNK_SIZE, stringToJournalText } = require('../database');
const {
    encodeJournalRecord,
    journalAuthorToString,
} = require('../journal');
const {
    forEachRetainedRecord,
    makeJournalRecordKey,
} = require('../journal_store');

/**
 * A `SchemaStorage.batch` writer which never queues more than one bounded chunk.
 *
 * The properties this class carries are:
 * - at most `RAW_BATCH_CHUNK_SIZE - 1` operations are queued between `push` calls,
 *   because every `push` first flushes complete chunks; and
 * - every operation passed to `push` is eventually issued in a `batch` call, either
 *   by `push` itself or by the final `flush`.
 *
 * The proof of those properties is guaranteed by:
 * - `push(...)`: it appends one operation and then calls `flushCompleteChunks`,
 *   which issues every chunk of exactly `RAW_BATCH_CHUNK_SIZE` operations and
 *   leaves a remainder strictly smaller than one chunk; and
 * - `flush(...)`: it issues the remainder, if any, in one final `batch` call.
 */
class BoundedBatchWriter {
    /**
     * @param {SchemaStorage} target
     */
    constructor(target) {
        this._target = target;
        /** @type {Array<*>} */
        this._pending = [];
    }

    /**
     * Queue one operation, flushing a complete chunk when one is queued.
     *
     * @param {*} operation
     * @returns {Promise<void>}
     */
    async push(operation) {
        this._pending.push(operation);
        while (this._pending.length >= RAW_BATCH_CHUNK_SIZE) {
            const chunk = this._pending.slice(0, RAW_BATCH_CHUNK_SIZE);
            await this._target.batch(chunk);
            this._pending = this._pending.slice(RAW_BATCH_CHUNK_SIZE);
        }
    }

    /**
     * Issue every queued operation, including the final partial chunk.
     *
     * @returns {Promise<void>}
     */
    async flush() {
        if (this._pending.length === 0) {
            return;
        }
        const chunk = this._pending;
        this._pending = [];
        await this._target.batch(chunk);
    }
}

/**
 * Stage the receiver's retained journal into the inactive target in bounded chunks.
 *
 * The records are folded out of the receiver's own streaming source one at a time
 * and written under their own author-and-coordinate keys, so the target gains exactly
 * the keys `Jfinal` (or `Jreset`) names for them and nothing else. Occurrence keys are
 * not written here: the shared lowering derives the occurrence index from the
 * projection it lowers, so the target's index names the projection and not the
 * receiver's pre-publication occurrences.
 *
 * `makeError` names the failure a record whose storage key the Journal sublevel
 * rejects is reported as, so each front reports the failure against its own outcome.
 *
 * @param {SchemaStorage} target
 * @param {JournalSource} retainedSource - The activated replica's retained journal,
 *   read through its per-writer streaming readers.
 * @param {(recordKey: string) => Error} makeError
 * @returns {Promise<void>}
 */
async function stageRetainedRecords(target, retainedSource, makeError) {
    const writer = new BoundedBatchWriter(target);
    const failure = await forEachRetainedRecord(retainedSource, async (record) => {
        const key = makeJournalRecordKey(record.id.author, record.id.sequence);
        if (key instanceof Error) {
            throw makeError(journalAuthorToString(record.id.author));
        }
        await writer.push(target.journal.putOp(key, stringToJournalText(encodeJournalRecord(record))));
        return undefined;
    });
    if (failure !== undefined) {
        throw failure;
    }
    await writer.flush();
}

module.exports = {
    BoundedBatchWriter,
    stageRetainedRecords,
};
