/**
 * Ordinary Journal emission finalization.
 *
 * `incremental-graph-journal-emission.md` §Staging and serialized finalization
 * separates the two halves of an ordinary operation: computors may run and stage
 * semantic intents before publication, but *durable* Journal coordinates are
 * allocated only inside the serialized graph finalization boundary. This module
 * is that boundary's pure half. It performs no I/O, holds no locks, and has no
 * lifecycle: it takes the settled graph transition together with the committed
 * writer state and returns the exact `JournalRecord`s the publication must make
 * durable, together with the writer state the next publication must observe.
 *
 * It implements finalization steps 5–9:
 *
 * - step 5, one contiguous local writer range: sequences are allocated as
 *   `writerHead + 1 ..` with no gap, so a failed transaction above this module
 *   consumes no durable coordinate;
 * - step 6, same-publication ValueId references resolved in dependency order: a
 *   `ValueEvent` is always allocated before the `ValidateEvent` naming its
 *   ValueId, and the whole batch is ordered by canonical NodeKey for the
 *   otherwise-unconstrained ties;
 * - step 7, contexts assigned from the complete committed retained frontier plus
 *   earlier same-publication records, with the own-writer coordinate exact;
 * - step 8, authority allocated to extend every predecessor by hybrid-logical
 *   allocation from the persisted high-water; and
 * - step 9's allocator half: a `WriterStateRecord` is appended exactly when the
 *   publication durably advances the local allocation watermark.
 *
 * ## Context closure
 *
 * Every semantic event's context is the complete committed retained frontier with
 * its own-writer coordinate replaced by `q - 1`, where `q` is the event's own
 * allocated coordinate. Because the committed frontier is causally closed by the
 * lifecycle which published it, and because `q - 1` extends the writer's complete
 * already-committed local prefix by exactly the earlier records of this same
 * publication, the resulting context is causally closed over every coordinate it
 * claims. This is the construction `incremental-graph-journal-types.md` §Causal
 * context requires of ordinary emission; this module does not re-check closure
 * because it is a consequence of building the context this way from a
 * guaranteed-closed committed frontier.
 */

const { fromISOString } = require("../../../datetime");
const { makeJournalPublicationError } = require("./errors");
const { makeValidationBasisEntry, nodeKeyToCanonicalString, sortValidationBasis } = require("./basis");
const {
    makeDeleteEvent,
    makeInvalidateEvent,
    makeValidateEvent,
    makeValueEvent,
    makeWriterStateRecord,
} = require("./records");
const {
    ZERO_JOURNAL_SEQUENCE,
    frontierJoin,
    isSameJournalAuthor,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalFrontier,
    makeJournalRecordId,
    makeJournalSequence,
} = require("./types");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('./records').JournalRecord} JournalRecord */
/** @typedef {import('./types').AuthorityTime} AuthorityTime */
/** @typedef {import('./types').JournalAuthor} JournalAuthor */
/** @typedef {import('./types').JournalFrontier} JournalFrontier */
/** @typedef {import('./types').JournalRecordId} JournalRecordId */
/** @typedef {import('./types').JournalSequence} JournalSequence */
/** @typedef {import('../database/node_key').NodeKey} NodeKey */
/** @typedef {import('../database/types').ComputedValue} ComputedValue */
/** @typedef {import('../database/types').NodeIdentifier} NodeIdentifier */

/**
 * One current direct input of a node, named by its semantic `NodeKey` and the
 * `ValueId` the finalized computation actually observed. Emission never invents a
 * basis entry: the caller supplies the settled transaction's real input
 * occurrences, and this module only orders them canonically.
 *
 * @typedef {object} MaterializeInput
 * @property {NodeKey} input
 * @property {JournalRecordId} value
 */

/**
 * A settled materialization: one node becomes a new semantic value occurrence,
 * and is validated against its finalized current direct-input occurrences.
 * `inputs` may be empty for a node with no direct inputs, in which case the
 * certificate proves the complete current input set of that node.
 *
 * @typedef {object} MaterializeIntent
 * @property {"materialize"} kind
 * @property {NodeKey} node
 * @property {NodeIdentifier} nodeIdentifier
 * @property {ComputedValue} payload
 * @property {string} createdAt
 * @property {string} modifiedAt
 * @property {ReadonlyArray<MaterializeInput>} inputs
 */

/**
 * A settled deletion: ordinary graph semantics removed this node's
 * materialization. Historical value occurrences are retained; the `DeleteEvent`
 * is semantic absence authority for the node.
 *
 * @typedef {object} DeleteIntent
 * @property {"delete"} kind
 * @property {NodeKey} node
 */

/**
 * A settled explicit invalidation: the node's incoming cache proof is directly
 * invalidated, which is node-scoped and independent of the selected occurrence.
 *
 * @typedef {object} InvalidateNodeIntent
 * @property {"invalidate-node"} kind
 * @property {NodeKey} node
 */

/**
 * A settled propagated persistent staleness: a cached dependent's exact current
 * occurrence became stale through its inputs. This is value-scoped and does not
 * by itself remove the occurrence's incoming proof.
 *
 * @typedef {object} InvalidateValueIntent
 * @property {"invalidate-value"} kind
 * @property {NodeKey} node
 * @property {JournalRecordId} value
 */

/**
 * The staged semantic intents of one ordinary committed graph transition. The
 * `kind` discriminant selects the record classes emitted for the intent, so an
 * intent can never ask for a record its variant does not define.
 *
 * @typedef {MaterializeIntent | DeleteIntent | InvalidateNodeIntent | InvalidateValueIntent} EmissionIntent
 */

/**
 * The committed local writer state a publication starts from. This is
 * committed-pair metadata, not history-derived state: an ordinary open reads it
 * directly rather than scanning retained records.
 *
 * The properties that this typedef carries are:
 * - `committedFrontier` is a causally closed frontier covering the complete
 *   retained journal this publication observed;
 * - `writerHead` is the local writer's last committed coordinate, or the zero
 *   coordinate when the local writer has published nothing;
 * - `authorityHighWater` is at least the greatest `AuthorityTime` among the
 *   semantic events this writer has observed.
 *
 * The proof of those properties is guaranteed by:
 * - the committed-pair metadata a lifecycle publication persisted atomically with
 *   its records, which this module consumes rather than re-derives; and
 * - this module advancing all three consistently: it never reads history, and the
 *   state it returns is the unique successor of the state it was given.
 *
 * @typedef {object} CommittedWriterState
 * @property {JournalAuthor} localWriter
 * @property {JournalSequence} writerHead
 * @property {JournalFrontier} committedFrontier
 * @property {AuthorityTime} authorityHighWater
 * @property {number} allocatorWatermark
 */

/**
 * @typedef {object} EmissionRequest
 * @property {CommittedWriterState} state - The committed state the publication starts from.
 * @property {ReadonlyArray<EmissionIntent>} intents - The settled graph transition, in no particular order.
 * @property {number} publicationInstant - Epoch milliseconds of the publication, used as the
 *   authority seed for every event which is not a `ValueEvent`.
 * @property {number} allocatorWatermark - The local allocation watermark this publication
 *   durably establishes. A `WriterStateRecord` is appended exactly when it exceeds the
 *   committed watermark.
 */

/**
 * The exact records one publication must make durable, and the writer state the
 * next publication must observe.
 *
 * The properties that this typedef carries are:
 * - `records` is a contiguous own-writer range whose contexts are causally closed
 *   and whose authority extends every predecessor, so appending it to a
 *   well-formed retained journal keeps that journal well formed;
 * - `writerState` is the unique committed state after the publication.
 *
 * The proof of those properties is guaranteed by:
 * - `finalizeEmission(request)`: allocates the range contiguously from
 *   `writerHead`, builds every context from the complete committed frontier with
 *   the exact own-writer coordinate, allocates authority strictly above the
 *   high-water for each record in order, orders each `ValueEvent` before the
 *   `ValidateEvent` naming it, and returns the advanced state.
 *
 * @typedef {object} FinalizedPublication
 * @property {ReadonlyArray<JournalRecord>} records
 * @property {CommittedWriterState} writerState
 */

/**
 * The canonical decimal successor of a coordinate. The logical HLC coordinate is
 * arbitrary precision, so the increment is decimal string arithmetic on canonical
 * digits; it is deliberately not a `number` and not a `BigInt`.
 * @param {JournalSequence} sequence
 * @returns {JournalSequence}
 */
function successorDigits(sequence) {
    const digits = journalSequenceToString(sequence).split("");
    let index = digits.length - 1;
    while (index >= 0) {
        const nextDigit = Number(digits[index]) + 1;
        digits[index] = String(nextDigit % 10);
        if (nextDigit < 10) {
            break;
        }
        index--;
    }
    const incremented = index < 0 ? "1" + digits.join("") : digits.join("");
    const successor = makeJournalSequence(incremented);
    if (successor instanceof Error) {
        throw new Error("emission built a coordinate the canonical pattern rejects: " + incremented);
    }
    return successor;
}

/**
 * Allocate the next authority time for one record by the ordinary hybrid-logical
 * rule of `incremental-graph-journal-types.md` §Ordinary authority allocation.
 *
 * A `ValueEvent` seeds from its exact `modifiedAt`; every other event seeds from
 * the publication instant. The high-water is advanced to at least the allocated
 * time, so a successor allocation always sorts strictly after this one.
 *
 * @param {AuthorityTime} highWater
 * @param {number} seedPhysical
 * @returns {{authorityTime: AuthorityTime, highWater: AuthorityTime} | {error: JournalError}}
 */
function allocateAuthority(highWater, seedPhysical) {
    const physical = Math.max(seedPhysical, highWater.physical);
    if (physical > highWater.physical) {
        const authorityTime = makeAuthorityTime(physical, "0");
        if (authorityTime instanceof Error) {
            return { error: authorityTime };
        }
        return { authorityTime, highWater: authorityTime };
    }
    const authorityTime = makeAuthorityTime(physical, journalSequenceToString(successorDigits(highWater.logical)));
    if (authorityTime instanceof Error) {
        return { error: authorityTime };
    }
    return { authorityTime, highWater: authorityTime };
}

/**
 * The epoch-millisecond instant of a canonical whole-millisecond timestamp. The
 * timestamp form ends in `Z`, so the conversion is timezone-independent, and the
 * value is the seed a `ValueEvent`'s authority is allocated from.
 * @param {string} canonicalInstant
 * @returns {number}
 */
function epochMillisecondsOf(canonicalInstant) {
    return fromISOString(canonicalInstant).toMillis();
}

/**
 * The context of the record at own-writer coordinate `q`: the complete committed
 * retained frontier, with the local writer's coordinate replaced by `q - 1`.
 * @param {CommittedWriterState} state
 * @param {JournalAuthor} localWriter
 * @param {JournalSequence} ownPrefix
 * @returns {JournalFrontier | JournalError}
 */
function contextOf(state, localWriter, ownPrefix) {
    /** @type {Array<[JournalAuthor, JournalSequence]>} */
    const entries = [];
    let sawLocalWriter = false;
    for (const coordinate of state.committedFrontier) {
        if (isSameJournalAuthor(coordinate[0], localWriter)) {
            sawLocalWriter = true;
            entries.push([coordinate[0], ownPrefix]);
            continue;
        }
        entries.push([coordinate[0], coordinate[1]]);
    }
    if (!sawLocalWriter) {
        entries.push([localWriter, ownPrefix]);
    }
    return makeJournalFrontier(entries);
}

/**
 * The canonical order which breaks ties between intents that semantics do not
 * otherwise constrain: canonical persisted NodeKey order, then a stable
 * record-kind order.
 * @param {EmissionIntent} left
 * @param {EmissionIntent} right
 * @returns {number}
 */
function compareIntents(left, right) {
    const byNode = compareNodeKeys(left, right);
    if (byNode !== 0) {
        return byNode;
    }
    return intentKindRank(left.kind) - intentKindRank(right.kind);
}

/**
 * @param {EmissionIntent["kind"]} kind
 * @returns {number}
 */
function intentKindRank(kind) {
    if (kind === "materialize") {
        return 0;
    }
    if (kind === "delete") {
        return 1;
    }
    if (kind === "invalidate-node") {
        return 2;
    }
    return 3;
}

/**
 * @param {EmissionIntent} left
 * @param {EmissionIntent} right
 * @returns {number}
 */
function compareNodeKeys(left, right) {
    const leftText = nodeKeyToCanonicalString(nodeOfIntent(left));
    const rightText = nodeKeyToCanonicalString(nodeOfIntent(right));
    if (leftText < rightText) {
        return -1;
    }
    return leftText > rightText ? 1 : 0;
}

/**
 * @param {EmissionIntent} intent
 * @returns {NodeKey}
 */
function nodeOfIntent(intent) {
    return intent.node;
}

/**
 * Build the canonical validation basis of a settled materialization: one entry
 * per current direct input, in canonical persisted NodeKey order. The caller
 * supplies the finalized input occurrences, so this only orders them.
 * @param {ReadonlyArray<MaterializeInput>} inputs
 * @returns {import('./basis').ValidationBasis}
 */
function basisOf(inputs) {
    return sortValidationBasis(inputs.map((entry) => makeValidationBasisEntry(entry.input, entry.value)));
}

/**
 * Finalize one ordinary publication.
 *
 * Allocates the durable records for a settled graph transition: a contiguous own-writer
 * range, contexts from the complete committed frontier, authority extending every
 * predecessor, and a writer-state record exactly when the allocator advances.
 *
 * @param {EmissionRequest} request
 * @returns {FinalizedPublication | JournalError}
 */
function finalizeEmission(request) {
    const { state, intents, publicationInstant, allocatorWatermark } = request;
    if (!Number.isSafeInteger(publicationInstant) || publicationInstant < 0) {
        return makeJournalPublicationError(
            "publication instant must be a non-negative whole millisecond, got " +
                JSON.stringify(publicationInstant)
        );
    }
    if (!Number.isSafeInteger(allocatorWatermark) || allocatorWatermark < 0) {
        return makeJournalPublicationError(
            "allocator watermark must be a non-negative integer, got " + JSON.stringify(allocatorWatermark)
        );
    }
    const localWriter = state.localWriter;
    const ordered = intents.slice().sort(compareIntents);

    /** @type {JournalRecord[]} */
    const records = [];
    /** @type {JournalSequence} */
    let nextSequence = successorDigits(state.writerHead);
    /** @type {AuthorityTime} */
    let highWater = state.authorityHighWater;

    /**
     * The context for the record currently being built, which sits at
     * `nextSequence` and therefore observes everything through `nextSequence - 1`.
     * @returns {JournalFrontier | JournalError}
     */
    function currentContext() {
        const ownPrefix = decrement(nextSequence);
        const context = contextOf(state, localWriter, ownPrefix);
        if (context instanceof Error) {
            return context;
        }
        return context;
    }

    for (const intent of ordered) {
        if (intent.kind === "materialize") {
            const valueId = makeJournalRecordId(localWriter, nextSequence);
            if (valueId instanceof Error) {
                return valueId;
            }
            const valueContext = currentContext();
            if (valueContext instanceof Error) {
                return valueContext;
            }
            const seedPhysical = epochMillisecondsOf(intent.modifiedAt);
            if (!Number.isSafeInteger(seedPhysical) || seedPhysical < 0) {
                return makeJournalPublicationError(
                    "modifiedAt must be a canonical whole-millisecond instant to allocate " +
                        "authority, got " +
                        JSON.stringify(intent.modifiedAt)
                );
            }
            const valueAuthority = allocateAuthority(highWater, seedPhysical);
            if ("error" in valueAuthority) {
                return valueAuthority.error;
            }
            const valueEvent = makeValueEvent(
                { id: valueId, context: valueContext, authorityTime: valueAuthority.authorityTime, node: intent.node },
                intent.nodeIdentifier,
                intent.payload,
                intent.createdAt,
                intent.modifiedAt,
                "compute"
            );
            if (valueEvent instanceof Error) {
                return valueEvent;
            }
            records.push(valueEvent);
            highWater = valueAuthority.highWater;
            nextSequence = successorDigits(nextSequence);

            const validateId = makeJournalRecordId(localWriter, nextSequence);
            if (validateId instanceof Error) {
                return validateId;
            }
            const validateContext = currentContext();
            if (validateContext instanceof Error) {
                return validateContext;
            }
            const validateAuthority = allocateAuthority(highWater, publicationInstant);
            if ("error" in validateAuthority) {
                return validateAuthority.error;
            }
            const validateEvent = makeValidateEvent(
                {
                    id: validateId,
                    context: validateContext,
                    authorityTime: validateAuthority.authorityTime,
                    node: intent.node,
                },
                valueId,
                basisOf(intent.inputs),
                "compute"
            );
            if (validateEvent instanceof Error) {
                return validateEvent;
            }
            records.push(validateEvent);
            highWater = validateAuthority.highWater;
            nextSequence = successorDigits(nextSequence);
            continue;
        }

        const id = makeJournalRecordId(localWriter, nextSequence);
        if (id instanceof Error) {
            return id;
        }
        const context = currentContext();
        if (context instanceof Error) {
            return context;
        }
        const authority = allocateAuthority(highWater, publicationInstant);
        if ("error" in authority) {
            return authority.error;
        }
        const base = { id, context, authorityTime: authority.authorityTime, node: intent.node };
        /** @type {import('./records').JournalRecord | JournalError} */
        let record;
        if (intent.kind === "delete") {
            record = makeDeleteEvent(base, "operation");
        } else if (intent.kind === "invalidate-node") {
            record = makeInvalidateEvent(base, { kind: "node" }, "explicit");
        } else {
            record = makeInvalidateEvent(base, { kind: "value", value: intent.value }, "propagated");
        }
        if (record instanceof Error) {
            return record;
        }
        records.push(record);
        highWater = authority.highWater;
        nextSequence = successorDigits(nextSequence);
    }

    if (allocatorWatermark > state.allocatorWatermark) {
        const writerStateId = makeJournalRecordId(localWriter, nextSequence);
        if (writerStateId instanceof Error) {
            return writerStateId;
        }
        const writerState = makeWriterStateRecord(writerStateId, allocatorWatermark);
        if (writerState instanceof Error) {
            return writerState;
        }
        records.push(writerState);
        nextSequence = successorDigits(nextSequence);
    }

    if (records.length === 0) {
        return makeJournalPublicationError(
            "a publication which changed no persisted semantic state must author no record"
        );
    }

    const lastRecord = records[records.length - 1];
    if (lastRecord === undefined) {
        return makeJournalPublicationError("a publication authored no record");
    }
    const newHead = lastRecord.id.sequence;
    const advanced = makeJournalFrontier([[localWriter, newHead]]);
    if (advanced instanceof Error) {
        return advanced;
    }
    // The new frontier replaces the local writer's coordinate with the publication's
    // head and keeps every other writer's coordinate, which is exactly the
    // componentwise maximum of the committed frontier and the advanced coordinate.
    const newFrontier = frontierJoin(state.committedFrontier, advanced);
    return {
        records,
        writerState: {
            localWriter,
            writerHead: newHead,
            committedFrontier: newFrontier,
            authorityHighWater: highWater,
            allocatorWatermark: Math.max(state.allocatorWatermark, allocatorWatermark),
        },
    };
}

/**
 * The coordinate immediately below `sequence`. Zero has no predecessor, and a
 * publication can never begin at zero because a record identity requires a
 * positive sequence, so reaching zero here is a defect in this module.
 * @param {JournalSequence} sequence
 * @returns {JournalSequence}
 */
function decrement(sequence) {
    const digits = journalSequenceToString(sequence).split("");
    let index = digits.length - 1;
    while (index >= 0) {
        const borrowed = Number(digits[index]) - 1;
        if (borrowed >= 0) {
            digits[index] = String(borrowed);
            const decremented = digits.join("").replace(/^0+(?=[0-9])/, "");
            const result = makeJournalSequence(decremented);
            if (result instanceof Error) {
                throw new Error("emission built a coordinate the canonical pattern rejects: " + decremented);
            }
            return result;
        }
        digits[index] = "9";
        index--;
    }
    return ZERO_JOURNAL_SEQUENCE;
}

module.exports = {
    finalizeEmission,
};
