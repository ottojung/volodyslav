/**
 * Causal context closure.
 *
 * A semantic event's context is not a set of individually in-range coordinates;
 * it is a causally closed journal cut. This module is the executable form of
 * that rule.
 *
 * The pre-Journal bootstrap conversion is the one documented case where
 * migration read order is not semantic observation, so a joining legacy
 * `ValueEvent(reason="bootstrap")` may omit canonical foreign coordinates. The
 * rules here already express exactly what that exception still requires — an
 * exact own-writer prefix, retained coordinates, closure over every coordinate
 * the context actually claims, no impossible reference, and authority extending
 * every claimed observation — so the exception needs no special case here: what
 * it grants is permission to omit, never permission to claim something
 * unclosed.
 *
 * These checks are history-sized by construction: each event's context is
 * compared against the events it includes and against every observed
 * predecessor. That cost belongs to the explicit rebuild and maintenance
 * boundaries, never to routine open.
 */

const { makeJournalCausalClosureError } = require("./errors");
const { authorityCompare, happenedBefore } = require("./ordering");
const {
    semanticEventsOfReplica,
    semanticEventsUpToSequence,
} = require("./replica");
const {
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    journalSequenceToString,
    compareJournalSequence,
    ZERO_JOURNAL_SEQUENCE,
    predecessorJournalSequence,
} = require("./types");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('./replica').JournalReplica} JournalReplica */
/** @typedef {import('./records').SemanticEvent} SemanticEvent */
/** @typedef {import('./types').JournalAuthor} JournalAuthor */
/** @typedef {import('./types').JournalFrontier} JournalFrontier */
/** @typedef {import('./types').JournalSequence} JournalSequence */

/**
 * Every coordinate the context claims must be retained.
 * @param {SemanticEvent} event
 * @param {JournalFrontier} retainedFrontier
 * @returns {JournalError | undefined}
 */
function validateRetainedRangeCoverage(event, retainedFrontier) {
    const label = journalRecordIdToString(event.id);
    for (const coordinate of event.context) {
        const author = coordinate[0];
        const sequence = coordinate[1];
        if (
            compareJournalSequence(
                sequence,
                journalSequenceAtFrontier(retainedFrontier, author)
            ) > 0
        ) {
            return makeJournalCausalClosureError(
                label,
                "retained-range coverage",
                "context claims " +
                    journalAuthorToString(author) +
                    ":" +
                    journalSequenceToString(sequence) +
                    ", which is not retained"
            );
        }
    }
    return undefined;
}

/**
 * The own-writer coordinate is exact: a writer observes its complete
 * already-committed local prefix plus every earlier record of the same
 * publication.
 * @param {SemanticEvent} event
 * @returns {JournalError | undefined}
 */
function validateCompleteLocalPrefix(event) {
    const label = journalRecordIdToString(event.id);
    const expected = predecessorJournalSequence(event.id.sequence);
    if (expected instanceof Error) {
        return makeJournalCausalClosureError(
            label,
            "complete local prefix",
            "this record has no complete local prefix"
        );
    }
    const actual = journalSequenceAtFrontier(event.context, event.id.author);
    if (compareJournalSequence(actual, expected) !== 0) {
        return makeJournalCausalClosureError(
            label,
            "complete local prefix",
            "own-writer context is " +
                journalSequenceToString(actual) +
                " but must be exactly " +
                journalSequenceToString(expected)
        );
    }
    return undefined;
}

/**
 * For every semantic event the context includes, the context must also include
 * everything that event had observed.
 * @param {SemanticEvent} event
 * @param {JournalReplica} replica
 * @returns {JournalError | undefined}
 */
function validateTransitiveClosure(event, replica) {
    const label = journalRecordIdToString(event.id);
    for (const coordinate of event.context) {
        const author = coordinate[0];
        const sequence = coordinate[1];
        if (compareJournalSequence(sequence, ZERO_JOURNAL_SEQUENCE) === 0) {
            continue;
        }
        for (const observed of semanticEventsUpToSequence(replica, author, sequence)) {
            for (const own of observed.context) {
                if (compareJournalSequence(own[1], journalSequenceAtFrontier(event.context, own[0])) > 0) {
                    return makeJournalCausalClosureError(
                        label,
                        "transitive closure",
                        "context includes " +
                            journalRecordIdToString(observed.id) +
                            " but omits the " +
                            journalAuthorToString(own[0]) +
                            ":" +
                            journalSequenceToString(own[1]) +
                            " it observed"
                    );
                }
            }
        }
    }
    return undefined;
}

/**
 * Causality implies increasing authority: a context which claims causal
 * observation but whose authority does not extend it is malformed.
 * @param {SemanticEvent} event
 * @param {JournalReplica} replica
 * @returns {JournalError | undefined}
 */
function validateAuthorityExtension(event, replica) {
    const label = journalRecordIdToString(event.id);
    for (const observed of semanticEventsOfReplica(replica)) {
        if (journalRecordIdToString(observed.id) === label) {
            continue;
        }
        if (!happenedBefore(observed, event)) {
            continue;
        }
        if (authorityCompare(observed, event) >= 0) {
            return makeJournalCausalClosureError(
                label,
                "authority consistency",
                "authority does not extend the observed predecessor " +
                    journalRecordIdToString(observed.id)
            );
        }
    }
    return undefined;
}

/**
 * Validate the whole causal context of one semantic event against a retained
 * replica.
 * @param {SemanticEvent} event
 * @param {JournalReplica} replica
 * @param {JournalFrontier} retainedFrontier
 * @returns {JournalError | undefined}
 */
function validateEventContext(event, replica, retainedFrontier) {
    return (
        validateRetainedRangeCoverage(event, retainedFrontier) ??
        validateCompleteLocalPrefix(event) ??
        validateTransitiveClosure(event, replica) ??
        validateAuthorityExtension(event, replica)
    );
}

/**
 * Validate every semantic event's causal context in a replica.
 * @param {JournalReplica} replica
 * @param {JournalFrontier} retainedFrontier
 * @returns {JournalError | undefined}
 */
function validateCausalContextClosure(replica, retainedFrontier) {
    for (const event of semanticEventsOfReplica(replica)) {
        const failure = validateEventContext(event, replica, retainedFrontier);
        if (failure !== undefined) {
            return failure;
        }
    }
    return undefined;
}

module.exports = {
    validateAuthorityExtension,
    validateCausalContextClosure,
    validateCompleteLocalPrefix,
    validateEventContext,
    validateRetainedRangeCoverage,
    validateTransitiveClosure,
};
