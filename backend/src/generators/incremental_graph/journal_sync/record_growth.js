/**
 * The journal growth of one synchronization or reset, as a streaming source.
 *
 * `incremental-graph-journal-sync.md` §Streamability and
 * `incremental-graph-journal-reset.md` §Streamability require the complete newly
 * transferred suffix and the complete changed-node set to be consumable
 * incrementally, never held as one in-RAM collection. The acquisition half of a
 * synchronization already satisfies that: `planForeignSuffixImport` holds each
 * imported writer's range and a re-readable positioned reader, not its records.
 *
 * This module is the growth the computation publishes, expressed the same way. It
 * is the imported suffixes re-read on demand, followed by the receiver-authored
 * records, which are graph-sized and therefore bounded by the affected closure
 * rather than by history. A consumer folds it one record at a time — the
 * persistence front stages each record durably before pulling the next — and a
 * caller which genuinely needs the whole growth as an array asks `collect`, which
 * is the one place that materialises it and is never the production path.
 *
 * The abstraction is deliberately not an array: `SyncOutcome`/`ResetOutcome` used
 * to expose `records` as a materialised array, which is exactly the accumulation
 * §Streamability forbids for the imported suffix.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('./import_plan').ImportedSuffix} ImportedSuffix */

/**
 * The properties this class carries are:
 * - `forEachRecord(visit)` yields every imported record unchanged, in ascending
 *   writer order and ascending writer-local coordinate order, followed by every
 *   receiver-authored record, and then returns; and
 * - `collect()` returns exactly those records as one array, which is the only
 *   materialisation the type offers.
 *
 * The proof of those properties is guaranteed by:
 * - This class can only be introduced through `makeRecordGrowth(suffixes,
 *   authored)`, whose callers pass the `ImportPlan.suffixes` the acquisition
 *   validated and the authored records the operation allocated; and
 * - `forEachRecord(...)`: it opens each suffix's own positioned reader, pulls one
 *   record at a time until that reader ends, and reports a reader failure rather
 *   than yielding a partial stream; and
 * - `collect()`: it accumulates `forEachRecord`'s yields, so it returns the same
 *   sequence.
 *
 * @param {ReadonlyArray<ImportedSuffix>} suffixes
 * @param {ReadonlyArray<JournalRecord>} authored
 */
class RecordGrowthClass {
    /**
     * @param {ReadonlyArray<ImportedSuffix>} suffixes
     * @param {ReadonlyArray<JournalRecord>} authored
     */
    constructor(suffixes, authored) {
        this._suffixes = suffixes;
        this._authored = authored;
    }

    /**
     * Fold every growth record through `visit`, one at a time.
     *
     * `visit` may be asynchronous, because a consumer which stages each record
     * durably must await that write before the next record is pulled.
     *
     * @param {(record: JournalRecord) => (void | Promise<void>)} visit
     * @returns {Promise<void>}
     */
    async forEachRecord(visit) {
        for (const suffix of this._suffixes) {
            const reader = suffix.reader();
            for (;;) {
                const record = await reader.nextRecord();
                if (record === undefined) {
                    const failure = reader.failure();
                    if (failure !== undefined) {
                        throw failure;
                    }
                    break;
                }
                await visit(record);
            }
        }
        for (const record of this._authored) {
            await visit(record);
        }
    }

    /**
     * The whole growth as one array.
     *
     * This materialises the imported suffix, so it belongs to callers which
     * genuinely need the complete sequence — a reference comparison, an
     * in-memory test — and never to the production persistence path.
     *
     * @returns {Promise<ReadonlyArray<JournalRecord>>}
     */
    async collect() {
        /** @type {JournalRecord[]} */
        const records = [];
        await this.forEachRecord((record) => {
            records.push(record);
        });
        return records;
    }
}

/** @typedef {RecordGrowthClass} RecordGrowth */

/**
 * @param {ReadonlyArray<ImportedSuffix>} suffixes
 * @param {ReadonlyArray<JournalRecord>} authored
 * @returns {RecordGrowth}
 */
function makeRecordGrowth(suffixes, authored) {
    return new RecordGrowthClass(suffixes, authored);
}

/**
 * @param {unknown} value
 * @returns {value is RecordGrowth}
 */
function isRecordGrowth(value) {
    return value instanceof RecordGrowthClass;
}

module.exports = {
    RecordGrowthClass,
    isRecordGrowth,
    makeRecordGrowth,
};
