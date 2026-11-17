/**
 * The reset theorem's committed-result check.
 *
 * `incremental-graph-journal-reset.md` §Reset theorem states that the committed
 * result equals the requested target semantic graph: present keys, payloads,
 * identifiers, timestamps, freshness and validity edges. The check runs after the
 * last pass and against the source's committed projection, so it refuses a reset
 * whose committed occurrence state is not the target's no matter which pass
 * settled the occurrence.
 *
 * The occurrence state is compared against the target's rather than against the
 * source's `ValueId`, because a preserved occurrence keeps its own record
 * identity, and the settled occurrence is compared separately so that the record
 * reset landed on cannot be mistaken for the target's.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('./pass2').ResetTargetOccurrence} ResetTargetOccurrence */

const { journalRecordIdToString, makeJournalProjectionError } = require("../journal");
const { nodeIdentifierToString } = require("../database");
const { payloadEquals } = require("./pass1");
const { sameEdgeSet } = require("./pass2");

/**
 * Does the committed result equal the requested target semantic graph?
 *
 * @param {Projection} final
 * @param {Iterable<ResetTargetOccurrence>} targetOccurrences
 * @returns {JournalError | undefined}
 */
function verifyTargetEquivalence(final, targetOccurrences) {
    const finalByKey = new Map(
        final.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
    );
    for (const occurrence of targetOccurrences) {
        const committed = finalByKey.get(occurrence.nodeKeyString);
        if (committed === undefined) {
            return makeJournalProjectionError(
                "the committed result does not contain a target-present node",
                occurrence.nodeKeyString
            );
        }
        if (journalRecordIdToString(committed.valueId) !== journalRecordIdToString(occurrence.valueId)) {
            return makeJournalProjectionError(
                "the committed occurrence is not the occurrence reset settled on",
                occurrence.nodeKeyString
            );
        }
        if (!sameEdgeSet(committed.validInputs, occurrence.validInputs)) {
            return makeJournalProjectionError(
                "the committed validity edges are not the target's",
                occurrence.nodeKeyString
            );
        }
        if (!payloadEquals(committed.payload, occurrence.payload)) {
            return makeJournalProjectionError(
                "the committed payload is not the target's",
                occurrence.nodeKeyString
            );
        }
        if (
            nodeIdentifierToString(committed.nodeIdentifier) !==
            nodeIdentifierToString(occurrence.nodeIdentifier)
        ) {
            return makeJournalProjectionError(
                "the committed node identifier is not the target's",
                occurrence.nodeKeyString
            );
        }
        if (committed.createdAt !== occurrence.createdAt) {
            return makeJournalProjectionError(
                "the committed createdAt is not the target's",
                occurrence.nodeKeyString
            );
        }
        if (committed.modifiedAt !== occurrence.modifiedAt) {
            return makeJournalProjectionError(
                "the committed modifiedAt is not the target's",
                occurrence.nodeKeyString
            );
        }
        if (committed.fresh !== occurrence.fresh) {
            return makeJournalProjectionError(
                "the committed freshness is not the target's",
                occurrence.nodeKeyString
            );
        }
    }
    return undefined;
}

module.exports = {
    verifyTargetEquivalence,
};
