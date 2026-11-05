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
 * **Linear-time historical validation.** The two relational predicates below —
 * transitive closure and authority extension — each quantify over the semantic
 * events an event causally observes. Evaluating that quantifier by scanning the
 * observed prefix once per event is Θ(H²) over retained history H, which
 * migration's historical-validation class (`$id-6845129073418625`) forbids. The
 * batch entry point `validateCausalContextClosure` therefore builds one
 * prefix-indexed writer-stream index (`buildCausalContextIndex`) in O(H·W) time
 * for W writers, then evaluates each event's two predicates against the
 * per-writer running maxima with a binary search, in O(W·log H). The total is
 * O(H·W·log H) — O(H) for the fixed writer count and fixed context size the
 * migration bound is stated against — and the predicates are exactly the ones
 * the per-event form defines. The per-event entry points keep the same meaning;
 * they build the same index for one event, so a caller which loops them is
 * still Θ(H²), and only the batch entry point is the linear path.
 */

const { makeJournalCausalClosureError } = require("./errors");
const { authorityCompare } = require("./ordering");
const { isSemanticEvent } = require("./records");
const {
    isSameJournalAuthor,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    journalSequenceToString,
    compareJournalSequence,
    ZERO_JOURNAL_SEQUENCE,
} = require("./types");
const { predecessorJournalSequence } = require("./coordinates");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('./replica').JournalReplica} JournalReplica */
/** @typedef {import('./records').SemanticEvent} SemanticEvent */
/** @typedef {import('./types').AuthorityTime} AuthorityTime */
/** @typedef {import('./types').JournalAuthor} JournalAuthor */
/** @typedef {import('./types').JournalFrontier} JournalFrontier */
/** @typedef {import('./types').JournalRecordId} JournalRecordId */
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
 * The authority part of one prefix-index entry: the authority-greatest semantic
 * event of that writer at or below the entry's coordinate.
 *
 * @typedef {object} IndexedAuthorityMaximum
 * @property {JournalRecordId} id
 * @property {JournalFrontier} context
 * @property {AuthorityTime} authorityTime
 */

/**
 * One semantic event of a writer, together with the running componentwise
 * maximum of the contexts and the running authority maximum of that writer's
 * semantic events at or below it.
 *
 * @typedef {object} CausalIndexEntry
 * @property {JournalSequence} sequence
 * @property {Array<[JournalAuthor, JournalSequence]>} context
 * @property {IndexedAuthorityMaximum} authority
 */

/**
 * The prefix index the batch sweep is evaluated against: every writer's
 * semantic events in writer-stream order, each carrying the running maxima
 * through it, plus the semantic events in replica iteration order.
 *
 * @typedef {object} CausalContextIndex
 * @property {Map<string, Array<CausalIndexEntry>>} byWriter
 * @property {Array<SemanticEvent>} events
 */

/**
 * The componentwise maximum of a running context maximum and one frontier.
 *
 * The running maximum is the smallest causally closed cut that includes every
 * context folded so far, so a later event's closure check only has to compare
 * against this one cut rather than rescan the folded contexts.
 *
 * @param {Array<[JournalAuthor, JournalSequence]>} left
 * @param {JournalFrontier} right
 * @returns {Array<[JournalAuthor, JournalSequence]>}
 */
function mergeContextMaximum(left, right) {
    /** @type {Map<string, [JournalAuthor, JournalSequence]>} */
    const merged = new Map();
    for (const [author, sequence] of left) {
        merged.set(journalAuthorToString(author), [author, sequence]);
    }
    for (const [author, sequence] of right) {
        const name = journalAuthorToString(author);
        const existing = merged.get(name);
        if (existing === undefined || compareJournalSequence(sequence, existing[1]) > 0) {
            merged.set(name, [author, sequence]);
        }
    }
    return [...merged.values()];
}

/**
 * Build the prefix index of one replica.
 *
 * The index holds one entry per semantic event, so its size is O(H·W): the
 * running context maximum is a frontier of at most W coordinates and the
 * authority maximum is one event reference. Non-semantic records are skipped
 * exactly as `semanticEventsOfReplica` skips them.
 *
 * @param {JournalReplica} replica
 * @returns {CausalContextIndex}
 */
function buildCausalContextIndex(replica) {
    /** @type {Map<string, Array<CausalIndexEntry>>} */
    const byWriter = new Map();
    /** @type {Array<SemanticEvent>} */
    const events = [];
    for (const stream of replica) {
        const name = journalAuthorToString(stream[0]);
        const entries = byWriter.get(name) ?? [];
        for (const record of stream[1]) {
            if (!isSemanticEvent(record)) {
                continue;
            }
            events.push(record);
            const previous = entries[entries.length - 1];
            const context = previous === undefined
                ? mergeContextMaximum([], record.context)
                : mergeContextMaximum(previous.context, record.context);
            const authority = previous === undefined ||
                authorityCompare(record, previous.authority) > 0
                ? { id: record.id, context: record.context, authorityTime: record.authorityTime }
                : previous.authority;
            entries.push({ sequence: record.id.sequence, context, authority });
        }
        byWriter.set(name, entries);
    }
    return { byWriter, events };
}

/**
 * The running maximum of one writer at or below a coordinate, or `undefined`
 * when the writer has no semantic event at or below it.
 *
 * @param {Map<string, Array<CausalIndexEntry>>} byWriter
 * @param {string} name
 * @param {JournalSequence} sequence
 * @returns {CausalIndexEntry | undefined}
 */
function maximumUpTo(byWriter, name, sequence) {
    const entries = byWriter.get(name);
    const first = entries === undefined ? undefined : entries[0];
    if (entries === undefined || first === undefined) {
        return undefined;
    }
    if (compareJournalSequence(sequence, first.sequence) < 0) {
        return undefined;
    }
    let low = 0;
    let high = entries.length - 1;
    let found = 0;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const entry = entries[middle];
        if (entry !== undefined && compareJournalSequence(entry.sequence, sequence) <= 0) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return entries[found];
}

/**
 * For every semantic event the context includes, the context must also include
 * everything that event had observed.
 *
 * The per-writer prefix maximum is the smallest cut containing every observed
 * context at or below the claimed coordinate, so the check is: that cut is
 * included by the event's own context.
 *
 * @param {SemanticEvent} event
 * @param {CausalContextIndex} index
 * @returns {JournalError | undefined}
 */
function validateTransitiveClosureIndexed(event, index) {
    const label = journalRecordIdToString(event.id);
    for (const coordinate of event.context) {
        const author = coordinate[0];
        const sequence = coordinate[1];
        if (compareJournalSequence(sequence, ZERO_JOURNAL_SEQUENCE) === 0) {
            continue;
        }
        const maximum = maximumUpTo(index.byWriter, journalAuthorToString(author), sequence);
        if (maximum === undefined) {
            continue;
        }
        for (const [observedAuthor, observedSequence] of maximum.context) {
            if (compareJournalSequence(
                observedSequence,
                journalSequenceAtFrontier(event.context, observedAuthor)
            ) > 0) {
                return makeJournalCausalClosureError(
                    label,
                    "transitive closure",
                    "context omits the " +
                        journalAuthorToString(observedAuthor) +
                        ":" +
                        journalSequenceToString(observedSequence) +
                        " observed by an event it includes"
                );
            }
        }
    }
    return undefined;
}

/**
 * Causality implies increasing authority: a context which claims causal
 * observation but whose authority does not extend it is malformed.
 *
 * Authority is a total order, so it suffices to compare the event against the
 * authority-greatest observed predecessor of each writer: that maximum is at
 * least every other observed predecessor, and it violates exactly when any does.
 * The own-writer prefix is the maximum at or below the event's predecessor; the
 * cross-writer predecessors are the maxima at or below each claimed coordinate.
 *
 * @param {SemanticEvent} event
 * @param {CausalContextIndex} index
 * @returns {JournalError | undefined}
 */
function validateAuthorityExtensionIndexed(event, index) {
    const label = journalRecordIdToString(event.id);
    const own = predecessorJournalSequence(event.id.sequence);
    if (!(own instanceof Error)) {
        const ownMaximum = maximumUpTo(
            index.byWriter,
            journalAuthorToString(event.id.author),
            own
        );
        if (ownMaximum !== undefined && authorityCompare(ownMaximum.authority, event) >= 0) {
            return makeJournalCausalClosureError(
                label,
                "authority consistency",
                "authority does not extend the observed predecessor " +
                    journalRecordIdToString(ownMaximum.authority.id)
            );
        }
    }
    for (const coordinate of event.context) {
        const author = coordinate[0];
        const sequence = coordinate[1];
        // The own writer is ordered by its stream prefix above, exactly as the
        // same-author branch of `happenedBefore` orders it; its context
        // coordinate must not widen that prefix.
        if (isSameJournalAuthor(author, event.id.author)) {
            continue;
        }
        if (compareJournalSequence(sequence, ZERO_JOURNAL_SEQUENCE) === 0) {
            continue;
        }
        const maximum = maximumUpTo(index.byWriter, journalAuthorToString(author), sequence);
        if (maximum === undefined) {
            continue;
        }
        if (authorityCompare(maximum.authority, event) >= 0) {
            return makeJournalCausalClosureError(
                label,
                "authority consistency",
                "authority does not extend the observed predecessor " +
                    journalRecordIdToString(maximum.authority.id)
            );
        }
    }
    return undefined;
}

/**
 * For every semantic event the context includes, the context must also include
 * everything that event had observed.
 *
 * The per-event form. A single event's closure is not cheaper than the history
 * it observes, so this builds the same prefix index the batch sweep uses and
 * answers one event from it. The batch entry point builds the index once for
 * the whole replica.
 *
 * @param {SemanticEvent} event
 * @param {JournalReplica} replica
 * @returns {JournalError | undefined}
 */
function validateTransitiveClosure(event, replica) {
    return validateTransitiveClosureIndexed(event, buildCausalContextIndex(replica));
}

/**
 * Causality implies increasing authority: a context which claims causal
 * observation but whose authority does not extend it is malformed.
 *
 * The per-event form; see `validateTransitiveClosure` for why it shares the
 * index with the batch sweep.
 *
 * @param {SemanticEvent} event
 * @param {JournalReplica} replica
 * @returns {JournalError | undefined}
 */
function validateAuthorityExtension(event, replica) {
    return validateAuthorityExtensionIndexed(event, buildCausalContextIndex(replica));
}

/**
 * Validate the whole causal context of one semantic event against an index and
 * a retained replica frontier.
 * @param {SemanticEvent} event
 * @param {CausalContextIndex} index
 * @param {JournalFrontier} retainedFrontier
 * @returns {JournalError | undefined}
 */
function validateEventContextIndexed(event, index, retainedFrontier) {
    return (
        validateRetainedRangeCoverage(event, retainedFrontier) ??
        validateCompleteLocalPrefix(event) ??
        validateTransitiveClosureIndexed(event, index) ??
        validateAuthorityExtensionIndexed(event, index)
    );
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
    return validateEventContextIndexed(event, buildCausalContextIndex(replica), retainedFrontier);
}

/**
 * Validate every semantic event's causal context in a replica.
 *
 * One index is built and every event is answered from it, so the historical
 * validation cost is O(H·W·log H) rather than the Θ(H²) of rescanning each
 * event's observed prefix.
 * @param {JournalReplica} replica
 * @param {JournalFrontier} retainedFrontier
 * @returns {JournalError | undefined}
 */
function validateCausalContextClosure(replica, retainedFrontier) {
    const index = buildCausalContextIndex(replica);
    for (const event of index.events) {
        const failure = validateEventContextIndexed(event, index, retainedFrontier);
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
