/**
 * Persisting and maintaining the Journal's change-bounded retained replay state.
 *
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires the
 * active/staged Journal state to be accompanied by an incrementally maintained derived
 * summary, requires imported/reset-authored records to update a staged summary before
 * cutover, and forbids reset/synchronization/routine open from falling back to scanning
 * unrelated retained history to obtain it. §Derived indexes requires a maintained index
 * to be updated in durable staging before the state it describes becomes active.
 *
 * This module is the store's half of that contract: the one key the summary occupies,
 * the operation which writes it in the same batch as the records it summarises, the read
 * which acquires it as a single point read, and the fold an ordinary publication uses to
 * extend it by exactly the records that publication admits. A summary which is absent,
 * or which retains records without one, is the missing-summary case that section
 * reserves for explicit rebuild/maintenance, so a caller is told that rather than
 * silently given a reconstructed state.
 */

/** @typedef {import("../journal/errors").AnyJournalError} JournalError */
/** @typedef {import("../journal/records").JournalRecord} JournalRecord */
/** @typedef {import("../journal/types").JournalAuthor} JournalAuthor */
/** @typedef {import("../database/types").DatabaseBatchOperation} DatabaseBatchOperation */
/** @typedef {import("../database/types").JournalKey} JournalKey */
/** @typedef {import("../database/root_database").JournalDatabase} JournalDatabase */
/** @typedef {import("../journal_retained").CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import("../journal_retained").RetainedReplayState} RetainedReplayState */

const {
    journalKeyToString,
    journalTextToString,
    stringToJournalKey,
    stringToJournalText,
} = require("../database");
const {
    makeJournalAuthor,
    makeJournalPublicationError,
} = require("../journal");
const {
    deserializeRetainedReplayState,
    makeEmptyRetainedReplayState,
    projectRetainedReplay,
    serializeRetainedReplayState,
    stageRetainedRecords,
} = require("../journal_retained");

/**
 * The one key the Journal's persisted change-bounded retained replay state occupies.
 *
 * The summary lives in the same sublevel as the records it summarises and is written in
 * the same atomic batch, so a reader can never observe records without the summary which
 * describes them.
 */
const JOURNAL_RETAINED_STATE_KEY = stringToJournalKey("retained_state");

/**
 * The record-key prefix, which `journalRetainsRecords` reads to tell a genuinely empty
 * Journal from one which has lost its summary.
 */
const RECORD_KEY_PREFIX = "record|";

/**
 * Append the operations which persist one retained replay state.
 *
 * The state is the change-bounded proof summary and the replay state derived from the
 * journal the same batch publishes, so it is written in the same atomic write rather
 * than afterwards. A caller which does not hold the state omits this call and its
 * journal is left without a summary, which the consuming lifecycles treat as the
 * missing-summary case §Change-bounded proof summary reserves for explicit
 * rebuild/maintenance.
 *
 * @param {JournalDatabase} journalDatabase
 * @param {Array<DatabaseBatchOperation>} operations
 * @param {RetainedReplayState} state
 * @returns {JournalError | undefined}
 */
function appendRetainedStateOp(journalDatabase, operations, state) {
    let text;
    try {
        text = serializeRetainedReplayState(state);
    } catch (error) {
        return makeJournalPublicationError(
            "the retained replay state could not be serialized: " +
                (error instanceof Error ? error.message : String(error))
        );
    }
    operations.push(journalDatabase.putOp(JOURNAL_RETAINED_STATE_KEY, stringToJournalText(text)));
    return undefined;
}

/**
 * Read and decode the Journal's persisted retained replay state.
 *
 * `undefined` means the sublevel holds no summary, which the caller treats as the
 * missing-summary case. A summary which is present but does not decode, or which was
 * built for another local writer, is returned as an error rather than as a state. The
 * read is one point read of one key: it never traverses the retained records.
 *
 * @param {JournalDatabase} journalDatabase
 * @param {object} request
 * @param {JournalAuthor} request.localWriter
 * @param {CurrentInputKeysOfNode} request.currentInputKeysOfNode
 * @returns {Promise<RetainedReplayState | undefined | JournalError>}
 */
async function readRetainedReplayState(journalDatabase, request) {
    const raw = await journalDatabase.get(JOURNAL_RETAINED_STATE_KEY);
    if (raw === undefined) {
        return undefined;
    }
    return deserializeRetainedReplayState(journalTextToString(raw), request);
}

/**
 * Whether the Journal sublevel retains any record at all.
 *
 * The scan stops at the first record key, so its work is bounded by the sublevel's key
 * prefix structure and never by the number of records. It is used only to distinguish a
 * genuinely empty Journal, whose summary is legitimately empty, from a Journal which
 * retains records but has lost its summary, which requires explicit rebuild/maintenance.
 *
 * @param {JournalDatabase} journalDatabase
 * @returns {Promise<boolean>}
 */
async function journalRetainsRecords(journalDatabase) {
    for await (const key of journalDatabase.keys()) {
        if (journalKeyToString(key).startsWith(RECORD_KEY_PREFIX)) {
            return true;
        }
    }
    return false;
}

/**
 * The retained replay state one ordinary local publication leaves behind.
 *
 * §Change-bounded proof summary requires the active summary to be updated whenever a
 * publication changes a relevant certificate, invalidation, selected occurrence or
 * input, and forbids ordinary local publication from scanning unrelated retained
 * history. This reads the persisted summary, folds the publication's own records into it
 * and resolves the new cut, so the publication's contribution to the summary is exactly
 * its own delta.
 *
 * A replica which retains records but has no summary is the missing-summary case the
 * same section reserves for explicit rebuild/maintenance, so the publication fails
 * closed rather than reconstructing the summary by traversal. A genuinely empty replica,
 * whose summary is legitimately empty, is the one state an ordinary publication may
 * start from.
 *
 * @param {JournalDatabase} journalDatabase
 * @param {string} fingerprint
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 * @param {ReadonlyArray<JournalRecord>} records
 * @returns {Promise<RetainedReplayState>}
 */
async function maintainedRetainedState(journalDatabase, fingerprint, currentInputKeysOfNode, records) {
    const localWriter = makeJournalAuthor(fingerprint);
    if (localWriter instanceof Error) {
        throw localWriter;
    }
    const persisted = await readRetainedReplayState(journalDatabase, {
        localWriter,
        currentInputKeysOfNode,
    });
    if (persisted instanceof Error) {
        throw persisted;
    }
    let state;
    if (persisted === undefined) {
        if (await journalRetainsRecords(journalDatabase)) {
            throw makeJournalPublicationError(
                "the active Journal replica retains records but has no change-bounded proof " +
                    "summary, which requires explicit rebuild/maintenance rather than an ordinary " +
                    "publication"
            );
        }
        state = makeEmptyRetainedReplayState(localWriter, currentInputKeysOfNode);
    } else {
        state = persisted;
    }
    stageRetainedRecords(state, records);
    const projected = projectRetainedReplay(state);
    if ("error" in projected) {
        throw projected.error;
    }
    return state;
}

module.exports = {
    JOURNAL_RETAINED_STATE_KEY,
    appendRetainedStateOp,
    journalRetainsRecords,
    maintainedRetainedState,
    readRetainedReplayState,
};
