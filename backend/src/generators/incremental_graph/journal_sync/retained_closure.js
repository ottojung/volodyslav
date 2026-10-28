/**
 * Retained-prefix evidence for the bounded import validation.
 *
 * `incremental-graph-journal-sync.md` §Final replay and validation requires the
 * contexts of newly admitted records to have exact own prefix and transitive
 * closure "against retained context summaries/indexes", and
 * `incremental-graph-journal-storage.md` §Synchronization/reset validation
 * permits the use of "retained indexes/committed metadata as needed". This
 * module is that evidence: it resolves a claimed retained-prefix coordinate by
 * positioned reads of the receiver's retained journal and verifies the claim
 * transitively.
 *
 * Every read opens the receiver's stream at the claimed coordinate rather than
 * at the canonical first coordinate, so a durable source seeks to it and never
 * traverses the retained prefix before it. A backward walk only crosses the
 * non-semantic records adjacent to a claimed coordinate. The cost therefore
 * scales with the admitted change set's claimed observations, never with
 * unclaimed retained history. Results are memoized per operation.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/records').SemanticEvent} SemanticEvent */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalFrontier} JournalFrontier */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../journal/types').NodeKey} NodeKey */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('./admission').AdmittedIndex} AdmittedIndex */

const {
    authorityCompare,
    compareJournalSequence,
    isInvalidateEvent,
    isSemanticEvent,
    isValidateEvent,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    journalSequenceToString,
    makeJournalCausalClosureError,
    makeJournalRecordValidationError,
    nodeKeyToCanonicalString,
    predecessorJournalSequence,
    suffixReaderOf,
    ZERO_JOURNAL_SEQUENCE,
} = require("../journal");

/**
 * Read one retained record at an exact coordinate through a positioned read.
 *
 * A coordinate the receiver does not hold at all is a validation failure
 * rather than vacuous acceptance: every retained-prefix claim this function is
 * asked about is already covered by the union frontier.
 *
 * @param {JournalSource} receiver
 * @param {JournalAuthor} author
 * @param {JournalSequence} sequence
 * @returns {Promise<{record: JournalRecord} | {error: JournalError}>}
 */
async function readRetainedRecordAt(receiver, author, sequence) {
    const reader = suffixReaderOf(receiver, author, sequence);
    const record = await reader.nextRecord();
    const failure = reader.failure();
    if (failure !== undefined) {
        return { error: failure };
    }
    if (record === undefined) {
        return {
            error: makeJournalRecordValidationError(
                "a retained context coordinate has no retained record",
                journalAuthorToString(author) + ":" + journalSequenceToString(sequence)
            ),
        };
    }
    if (compareJournalSequence(record.id.sequence, sequence) !== 0) {
        return {
            error: makeJournalRecordValidationError(
                "a retained context coordinate resolved to another coordinate",
                journalRecordIdToString(record.id)
            ),
        };
    }
    return { record };
}

/**
 * The nearest retained semantic event at or below a claimed coordinate.
 *
 * Whole-history validation answers a claim from the running per-writer maxima,
 * which for authority is the nearest semantic event at or below the claimed
 * coordinate: authority strictly increases along a validated writer stream, so
 * the running authority maximum is that event. The context half is answered by
 * `verifyClaimedObservation`, which recurses through what each resolved event
 * observed. Each step is one positioned read, and results are memoized in
 * `cache` across the operation, keyed by coordinate.
 *
 * @param {JournalSource} receiver
 * @param {JournalAuthor} author
 * @param {JournalSequence} sequence
 * @param {Map<string, JournalRecord>} cache
 * @returns {Promise<JournalRecord | undefined | JournalError>}
 */
async function nearestRetainedSemantic(receiver, author, sequence, cache) {
    const name = journalAuthorToString(author);
    let current = sequence;
    for (;;) {
        if (compareJournalSequence(current, ZERO_JOURNAL_SEQUENCE) === 0) {
            return undefined;
        }
        const key = name + ":" + journalSequenceToString(current);
        let entry = cache.get(key);
        if (entry === undefined) {
            const read = await readRetainedRecordAt(receiver, author, current);
            if ("error" in read) {
                return read.error;
            }
            entry = read.record;
            cache.set(key, entry);
        }
        if (isSemanticEvent(entry)) {
            return entry;
        }
        const previous = predecessorJournalSequence(current);
        if (previous instanceof Error) {
            return previous;
        }
        current = previous;
    }
}

/**
 * Check that one claimed observation is closed over and extended by `event`.
 *
 * The claim is answered from the admitted-relations index when the change set
 * covers it, and from the receiver's retained prefix otherwise; in both cases
 * the observed context must be included by `event`'s own context and the
 * observed authority must be extended by `event`'s authority. Retained
 * observations recurse: a retained event's own claimed coordinates are verified
 * the same way, so a suffix which claims a retained event while omitting what
 * that event observed is rejected exactly as whole-history validation rejects
 * it. Admitted maxima already fold the change set, so only their
 * retained-prefix components recurse. `visited` memoizes coordinates across
 * one record's check, so shared observations are verified once.
 *
 * @param {SemanticEvent} event
 * @param {JournalAuthor} author
 * @param {JournalSequence} sequence
 * @param {AdmittedIndex} index
 * @param {JournalSource} receiver
 * @param {Map<string, JournalRecord>} cache
 * @param {Set<string>} visited
 * @returns {Promise<JournalError | undefined>}
 */
async function verifyClaimedObservation(event, author, sequence, index, receiver, cache, visited) {
    const label = journalRecordIdToString(event.id);
    if (compareJournalSequence(sequence, ZERO_JOURNAL_SEQUENCE) === 0) {
        return undefined;
    }
    const name = journalAuthorToString(author);
    const key = name + ":" + journalSequenceToString(sequence);
    if (visited.has(key)) {
        return undefined;
    }
    visited.add(key);
    const maximum = index.maximumUpTo(name, sequence);
    if (maximum !== undefined) {
        for (const [observedAuthor, observedSequence] of maximum.context) {
            if (compareJournalSequence(
                observedSequence,
                journalSequenceAtFrontier(event.context, observedAuthor)
            ) > 0) {
                return makeJournalCausalClosureError(
                    label,
                    "transitive closure",
                    "context omits " +
                        journalAuthorToString(observedAuthor) +
                        ":" +
                        journalSequenceToString(observedSequence) +
                        " observed by an event it includes"
                );
            }
        }
        if (authorityCompare(maximum.authority, event) >= 0) {
            return makeJournalCausalClosureError(
                label,
                "authority consistency",
                "authority does not extend the observed predecessor " +
                    journalRecordIdToString(maximum.authority.id)
            );
        }
        for (const [observedAuthor, observedSequence] of maximum.context) {
            if (index.maximumUpTo(journalAuthorToString(observedAuthor), observedSequence) !== undefined) {
                continue;
            }
            const deeper = await verifyClaimedObservation(
                event, observedAuthor, observedSequence, index, receiver, cache, visited
            );
            if (deeper !== undefined) {
                return deeper;
            }
        }
        return undefined;
    }
    const nearest = await nearestRetainedSemantic(receiver, author, sequence, cache);
    if (nearest === undefined) {
        return undefined;
    }
    if (nearest instanceof Error) {
        return nearest;
    }
    for (const [observedAuthor, observedSequence] of nearest.context) {
        if (compareJournalSequence(
            observedSequence,
            journalSequenceAtFrontier(event.context, observedAuthor)
        ) > 0) {
            return makeJournalCausalClosureError(
                label,
                "transitive closure",
                "context omits " +
                    journalAuthorToString(observedAuthor) +
                    ":" +
                    journalSequenceToString(observedSequence) +
                    " observed by the retained event " +
                    journalRecordIdToString(nearest.id)
            );
        }
    }
    if (authorityCompare(nearest, event) >= 0) {
        return makeJournalCausalClosureError(
            label,
            "authority consistency",
            "authority does not extend the observed retained predecessor " +
                journalRecordIdToString(nearest.id)
        );
    }
    for (const [observedAuthor, observedSequence] of nearest.context) {
        const deeper = await verifyClaimedObservation(
            event, observedAuthor, observedSequence, index, receiver, cache, visited
        );
        if (deeper !== undefined) {
            return deeper;
        }
    }
    return undefined;
}

/**
 * The ValueId coordinates one record names, or an empty array when it names none.
 *
 * A validation names its target occurrence and, for every explicit input, the
 * occurrence it used as that input; `incremental-graph-journal-well-formedness.md`
 * section Validation basis rules items 4 and 5 require each non-`"unknown"` basis
 * value to be a retained ValueEvent of the declared input node that happened-before
 * the validation, so every basis occurrence is a coordinate the record names. A
 * value scope and a proof scope both name a ValueId: they retire something about
 * the named occurrence. Only the node scope names no coordinate.
 *
 * @param {JournalRecord} record
 * @returns {ReadonlyArray<JournalRecordId>}
 */
function referencedIdsOf(record) {
    if (isValidateEvent(record)) {
        const references = [record.value];
        for (const entry of record.basis) {
            if (entry.value !== "unknown") {
                references.push(entry.value);
            }
        }
        return references;
    }
    if (record.kind === "invalidate" && record.scope.kind !== "node") {
        return [record.scope.value];
    }
    return [];
}

/**
 * The canonical NodeKey identities a record's validation basis names.
 * @param {JournalRecord} record
 * @returns {ReadonlyArray<string>}
 */
function basisInputsOf(record) {
    if (!isValidateEvent(record)) {
        return [];
    }
    return record.basis.map((entry) => nodeKeyToCanonicalString(entry.input));
}

/**
 * Check that a ValueId one admitted record names resolves to a `ValueEvent` of
 * the expected node.
 *
 * A coordinate beyond the union frontier is not retained at all, so the
 * reference is impossible and is rejected. A coordinate at or below the frontier
 * which the change set does not hold is a retained-prefix coordinate whose
 * record was validated when the receiver admitted it, so this operation does not
 * rescan it. A coordinate the change set does hold is resolved directly: it must
 * be a `ValueEvent` of the node the reference declares, exactly as whole-history
 * validation requires. Resolving an admitted coordinate visits one admitted
 * record and never retained history, so the check stays change-bounded.
 *
 * @param {SemanticEvent} event
 * @param {JournalRecordId} referenceId
 * @param {NodeKey} expectedNode
 * @param {JournalFrontier} frontier
 * @param {AdmittedIndex} index
 * @returns {JournalError | undefined}
 */
function validateAdmittedReference(event, referenceId, expectedNode, frontier, index) {
    const label = journalRecordIdToString(event.id);
    if (compareJournalSequence(
        referenceId.sequence,
        journalSequenceAtFrontier(frontier, referenceId.author)
    ) > 0) {
        return makeJournalRecordValidationError("referenced ValueId is not retained", label);
    }
    const resolved = index.recordOf(referenceId);
    if (resolved === undefined) {
        return undefined;
    }
    if (!resolved.isValue) {
        return makeJournalRecordValidationError(
            "referenced ValueId is not a ValueEvent",
            label
        );
    }
    if (nodeKeyToCanonicalString(resolved.node) !== nodeKeyToCanonicalString(expectedNode)) {
        return makeJournalRecordValidationError(
            "referenced ValueId belongs to another semantic node",
            label
        );
    }
    return undefined;
}

/**
 * Check the self-described references of one admitted record against the
 * admitted change set.
 *
 * A validation names its target occurrence and, for each explicit input, the
 * occurrence it used as that input; a value- or proof-scoped invalidation names
 * the occurrence it retires. Each is a `ValueEvent` of the record's own node (or
 * of the named input) in whole-history well-formedness, so each is resolved here
 * for the coordinates the change set holds.
 *
 * @param {SemanticEvent} event
 * @param {JournalFrontier} frontier
 * @param {AdmittedIndex} index
 * @returns {JournalError | undefined}
 */
function validateAdmittedReferences(event, frontier, index) {
    if (isValidateEvent(event)) {
        const target = validateAdmittedReference(event, event.value, event.node, frontier, index);
        if (target !== undefined) {
            return target;
        }
        for (const entry of event.basis) {
            if (entry.value === "unknown") {
                continue;
            }
            const basis = validateAdmittedReference(event, entry.value, entry.input, frontier, index);
            if (basis !== undefined) {
                return basis;
            }
        }
        return undefined;
    }
    if (isInvalidateEvent(event) && event.scope.kind !== "node") {
        return validateAdmittedReference(event, event.scope.value, event.node, frontier, index);
    }
    return undefined;
}

/**
 * Check one admitted record's transitive closure, authority extension and
 * self-described references against the admitted change set and the retained
 * prefix it claims.
 *
 * This is the relation-shaped half of the bounded validation contract evaluated
 * with retained evidence: admitted maxima are compared directly, and every
 * claimed coordinate no admitted maximum covers is resolved by positioned
 * retained reads and verified transitively. `cache` memoizes retained records
 * across the operation; it must be created once per `planForeignSuffixImport`
 * call and shared by every record that call checks.
 *
 * @param {JournalRecord} record
 * @param {AdmittedIndex} index
 * @param {JournalFrontier} frontier - The union frontier including every admitted suffix.
 * @param {JournalSource} receiver
 * @param {Map<string, JournalRecord>} cache
 * @returns {Promise<JournalError | undefined>}
 */
async function validateAdmittedRelationsWithRetained(record, index, frontier, receiver, cache) {
    if (!isSemanticEvent(record)) {
        return undefined;
    }
    const visited = new Set();
    for (const [author, sequence] of record.context) {
        const failure = await verifyClaimedObservation(
            record, author, sequence, index, receiver, cache, visited
        );
        if (failure !== undefined) {
            return failure;
        }
    }
    return validateAdmittedReferences(record, frontier, index);
}

module.exports = {
    basisInputsOf,
    referencedIdsOf,
    validateAdmittedReferences,
    validateAdmittedRelationsWithRetained,
    verifyClaimedObservation,
};
