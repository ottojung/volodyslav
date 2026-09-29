/**
 * The five core Journal record classes.
 *
 * Each class is created only by a `make…` function which validates every
 * current-format field, so an instance of one of these classes is already valid
 * under the current Journal record representation.
 *
 * The properties these classes carry and the functions which establish them:
 *
 * - every record class: `kind` is the class's own literal kind and `id` is a
 *   `JournalRecordId`. Established by `makeValueEvent`, `makeDeleteEvent`,
 *   `makeValidateEvent`, `makeInvalidateEvent` and `makeWriterStateRecord`,
 *   which each set `kind` themselves and validate the id.
 * - the four semantic events: `context` is a `JournalFrontier`,
 *   `authorityTime` is an `AuthorityTime` and `node` is a `NodeKey`.
 *   Established by the four `make…Event` functions, which reject arguments of
 *   any other type.
 * - `ValueEvent`: the two persisted timestamps are canonical whole-millisecond
 *   instants and `reason` is one of the four value reasons. Established by
 *   `makeValueEvent`. Those timestamps are physical data with no ordering
 *   invariant, so an occurrence with `createdAt > modifiedAt` is valid.
 * - `ValidateEvent`: `value` is a `JournalRecordId` and `basis` is a
 *   canonical-ordered basis with at most one entry per semantic input.
 *   Established by `makeValidateEvent`.
 * - `InvalidateEvent`: `scope` is an `InvalidateScope`. Established by
 *   `makeInvalidateEvent`, which also enforces the current-format rule that a
 *   proof-edge barrier is authored only by a controlled maintenance reason.
 * - `WriterStateRecord`: `lastNodeIndex` is a non-negative safe integer.
 *   Established by `makeWriterStateRecord`. A writer state record carries no
 *   context and no reference, so it is not a semantic event.
 *
 * The allocator watermark is a `number` because the current representation
 * defines `lastNodeIndex` as a non-negative integer, and because history growth
 * is accounted in the journal sequence and the HLC logical coordinate rather
 * than in the allocator index.
 *
 * The context closure rules which need the retained replica — own-prefix
 * exactness, retained-range coverage, transitive closure, authority extension
 * and reference causality — are not established here; they are established by
 * `well_formedness.js`. A record can therefore be built in isolation and
 * rejected by a validator, which is what the closure fixtures require.
 */

const { makeJournalRecordValidationError } = require("./errors");
const {
    isBaselineValidationReason,
    isInvalidateScope,
    isNodeKey,
    ownedNodeKey,
} = require("./basis");
const {
    invalidBasisDetail,
    isCanonicalTimestamp,
    isComputedValue,
    isNodeIdentifier,
    isPlainRecord,
    ownedComputedValue,
    readEnumMember,
    readRecordId,
} = require("./record_fields");
const {
    isAuthorityTime,
    isJournalFrontier,
    isJournalRecordId,
    journalRecordIdToString,
} = require("./types");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('./types').AuthorityTime} AuthorityTime */
/** @typedef {import('./types').JournalFrontier} JournalFrontier */
/** @typedef {import('./types').JournalRecordId} JournalRecordId */
/** @typedef {import('./types').NodeKey} NodeKey */
/** @typedef {import('./basis').InvalidateScope} InvalidateScope */
/** @typedef {import('./basis').ValidationBasis} ValidationBasis */
/** @typedef {import('../database/types').ComputedValue} ComputedValue */
/** @typedef {import('../database/types').NodeIdentifier} NodeIdentifier */

/**
 * The fields every semantic event carries, before its kind-specific body.
 * @typedef {object} SemanticEventFields
 * @property {JournalRecordId | string} id
 * @property {JournalFrontier} context
 * @property {AuthorityTime} authorityTime
 * @property {NodeKey} node
 */

const VALUE_REASONS = ["compute", "bootstrap", "reset", "migration"];
const DELETE_REASONS = ["operation", "reset", "migration", "sync"];
const VALIDATE_REASONS = [
    "compute",
    "unchanged",
    "cache-revalidate",
    "bootstrap",
    "reset",
    "migration",
];
const INVALIDATE_REASONS = [
    "explicit",
    "propagated",
    "sync",
    "bootstrap",
    "reset",
    "migration",
];

class ValueEventClass {
    /** @type {"value"} */
    kind = "value";

    /**
     * @param {ResolvedEventFields} base
     * @param {NodeIdentifier} nodeIdentifier
     * @param {ComputedValue} payload
     * @param {string} createdAt
     * @param {string} modifiedAt
     * @param {string} reason
     */
    constructor(base, nodeIdentifier, payload, createdAt, modifiedAt, reason) {
        this.id = base.id;
        this.context = base.context;
        this.authorityTime = base.authorityTime;
        this.node = base.node;
        this.nodeIdentifier = nodeIdentifier;
        this.payload = payload;
        this.createdAt = createdAt;
        this.modifiedAt = modifiedAt;
        this.reason = reason;
    }
}

/** @typedef {ValueEventClass} ValueEvent */

class DeleteEventClass {
    /** @type {"delete"} */
    kind = "delete";

    /**
     * @param {ResolvedEventFields} base
     * @param {string} reason
     */
    constructor(base, reason) {
        this.id = base.id;
        this.context = base.context;
        this.authorityTime = base.authorityTime;
        this.node = base.node;
        this.reason = reason;
    }
}

/** @typedef {DeleteEventClass} DeleteEvent */

class ValidateEventClass {
    /** @type {"validate"} */
    kind = "validate";

    /**
     * @param {ResolvedEventFields} base
     * @param {JournalRecordId} value
     * @param {ValidationBasis} basis
     * @param {string} reason
     */
    constructor(base, value, basis, reason) {
        this.id = base.id;
        this.context = base.context;
        this.authorityTime = base.authorityTime;
        this.node = base.node;
        this.value = value;
        this.basis = basis;
        this.reason = reason;
    }
}

/** @typedef {ValidateEventClass} ValidateEvent */

class InvalidateEventClass {
    /** @type {"invalidate"} */
    kind = "invalidate";

    /**
     * @param {ResolvedEventFields} base
     * @param {InvalidateScope} scope
     * @param {string} reason
     */
    constructor(base, scope, reason) {
        this.id = base.id;
        this.context = base.context;
        this.authorityTime = base.authorityTime;
        this.node = base.node;
        this.scope = scope;
        this.reason = reason;
    }
}

/** @typedef {InvalidateEventClass} InvalidateEvent */

class WriterStateRecordClass {
    /** @type {"writer-state"} */
    kind = "writer-state";

    /**
     * @param {JournalRecordId} id
     * @param {number} lastNodeIndex
     */
    constructor(id, lastNodeIndex) {
        this.id = id;
        this.lastNodeIndex = lastNodeIndex;
        Object.freeze(this);
    }
}

/** @typedef {WriterStateRecordClass} WriterStateRecord */

/**
 * A semantic event carries a causally closed context, an authority time and a
 * node.
 * @typedef {ValueEvent | DeleteEvent | ValidateEvent | InvalidateEvent} SemanticEvent
 */

/**
 * The core Journal record union.
 *
 * The union is deliberately open: higher-level operation and tracing record
 * classes may be added later as additional immutable non-semantic records. A
 * dispatch over the current core classes therefore keeps a default branch, and
 * the current-format codec rejects any kind it does not know rather than
 * upcasting it.
 * @typedef {SemanticEvent | WriterStateRecord} JournalRecord
 */

/**
 * @param {unknown} value
 * @returns {value is JournalRecord}
 */
function isJournalRecord(value) {
    return isSemanticEvent(value) || isWriterStateRecord(value);
}

/**
 * @param {unknown} value
 * @returns {value is SemanticEvent}
 */
function isSemanticEvent(value) {
    return (
        isValueEvent(value) ||
        isDeleteEvent(value) ||
        isValidateEvent(value) ||
        isInvalidateEvent(value)
    );
}

/**
 * @param {unknown} value
 * @returns {value is ValueEvent}
 */
function isValueEvent(value) {
    return value instanceof ValueEventClass;
}

/**
 * @param {unknown} value
 * @returns {value is DeleteEvent}
 */
function isDeleteEvent(value) {
    return value instanceof DeleteEventClass;
}

/**
 * @param {unknown} value
 * @returns {value is ValidateEvent}
 */
function isValidateEvent(value) {
    return value instanceof ValidateEventClass;
}

/**
 * @param {unknown} value
 * @returns {value is InvalidateEvent}
 */
function isInvalidateEvent(value) {
    return value instanceof InvalidateEventClass;
}

/**
 * @param {unknown} value
 * @returns {value is WriterStateRecord}
 */
function isWriterStateRecord(value) {
    return value instanceof WriterStateRecordClass;
}

/**
 * The shared body of a semantic event with its id already resolved.
 * @typedef {object} ResolvedEventFields
 * @property {JournalRecordId} id
 * @property {JournalFrontier} context
 * @property {AuthorityTime} authorityTime
 * @property {NodeKey} node
 */

/**
 * Validate the shared body of a semantic event.
 * @param {SemanticEventFields} fields
 * @returns {{ok: true, base: ResolvedEventFields} | {ok: false, error: JournalError}}
 */
function readSemanticEventBase(fields) {
    if (!isPlainRecord(fields)) {
        return {
            ok: false,
            error: makeJournalRecordValidationError("record is not an object", "unknown"),
        };
    }
    const id = readRecordId(fields.id, "unknown");
    if (!isJournalRecordId(id)) {
        return { ok: false, error: id };
    }
    const label = journalRecordIdToString(id);
    if (!isJournalFrontier(fields.context)) {
        return {
            ok: false,
            error: makeJournalRecordValidationError(
                "context is missing or is not a journal frontier",
                label
            ),
        };
    }
    if (!isAuthorityTime(fields.authorityTime)) {
        return {
            ok: false,
            error: makeJournalRecordValidationError(
                "authority time is missing or malformed",
                label
            ),
        };
    }
    if (!isNodeKey(fields.node)) {
        return {
            ok: false,
            error: makeJournalRecordValidationError("node is missing or is not a node key", label),
        };
    }
    return {
        ok: true,
        base: {
            id,
            context: fields.context,
            authorityTime: fields.authorityTime,
            node: ownedNodeKey(fields.node),
        },
    };
}

/**
 * @param {SemanticEventFields} fields
 * @param {unknown} nodeIdentifier
 * @param {unknown} payload
 * @param {unknown} createdAt
 * @param {unknown} modifiedAt
 * @param {unknown} reason
 * @returns {ValueEvent | JournalError}
 */
function makeValueEvent(fields, nodeIdentifier, payload, createdAt, modifiedAt, reason) {
    const read = readSemanticEventBase(fields);
    if (!read.ok) {
        return read.error;
    }
    const label = journalRecordIdToString(read.base.id);
    if (!isNodeIdentifier(nodeIdentifier)) {
        return makeJournalRecordValidationError("node identifier is missing or malformed", label);
    }
    if (!isComputedValue(payload)) {
        return makeJournalRecordValidationError(
            "payload is not a valid current-version computed value",
            label
        );
    }
    if (!isCanonicalTimestamp(createdAt) || !isCanonicalTimestamp(modifiedAt)) {
        return makeJournalRecordValidationError(
            "createdAt and modifiedAt must be canonical whole-millisecond instants",
            label
        );
    }
    const readReason = readEnumMember(label, VALUE_REASONS, reason);
    if (!readReason.ok) {
        return readReason.error;
    }
    return Object.freeze(
        new ValueEventClass(
            read.base,
            nodeIdentifier,
            ownedComputedValue(payload),
            createdAt,
            modifiedAt,
            readReason.value
        )
    );
}

/**
 * @param {SemanticEventFields} fields
 * @param {unknown} reason
 * @returns {DeleteEvent | JournalError}
 */
function makeDeleteEvent(fields, reason) {
    const read = readSemanticEventBase(fields);
    if (!read.ok) {
        return read.error;
    }
    const readReason = readEnumMember(
        journalRecordIdToString(read.base.id),
        DELETE_REASONS,
        reason
    );
    if (!readReason.ok) {
        return readReason.error;
    }
    return Object.freeze(new DeleteEventClass(read.base, readReason.value));
}

/**
 * A basis the record owns: a fresh frozen array, so the caller can keep and
 * mutate the array it passed.
 * @param {ValidationBasis} basis
 * @returns {ValidationBasis}
 */
function frozenBasis(basis) {
    const owned = basis.slice();
    Object.freeze(owned);
    return owned;
}

/**
 * @param {SemanticEventFields} fields
 * @param {JournalRecordId | string} value
 * @param {ValidationBasis} basis
 * @param {unknown} reason
 * @returns {ValidateEvent | JournalError}
 */
function makeValidateEvent(fields, value, basis, reason) {
    const read = readSemanticEventBase(fields);
    if (!read.ok) {
        return read.error;
    }
    const label = journalRecordIdToString(read.base.id);
    const resolvedValue = readRecordId(value, label);
    if (!isJournalRecordId(resolvedValue)) {
        return resolvedValue;
    }
    const basisError = invalidBasisDetail(basis, label);
    if (basisError !== undefined) {
        return basisError;
    }
    const readReason = readEnumMember(label, VALIDATE_REASONS, reason);
    if (!readReason.ok) {
        return readReason.error;
    }
    return Object.freeze(
        new ValidateEventClass(read.base, resolvedValue, frozenBasis(basis), readReason.value)
    );
}

/**
 * @param {SemanticEventFields} fields
 * @param {InvalidateScope} scope
 * @param {unknown} reason
 * @returns {InvalidateEvent | JournalError}
 */
function makeInvalidateEvent(fields, scope, reason) {
    const read = readSemanticEventBase(fields);
    if (!read.ok) {
        return read.error;
    }
    const label = journalRecordIdToString(read.base.id);
    if (!isInvalidateScope(scope)) {
        return makeJournalRecordValidationError("invalidation scope is missing or malformed", label);
    }
    const readReason = readEnumMember(label, INVALIDATE_REASONS, reason);
    if (!readReason.ok) {
        return readReason.error;
    }
    if (scope.kind === "proof" && !isBaselineValidationReason(readReason.value)) {
        return makeJournalRecordValidationError(
            "proof scope is reserved for bootstrap/reset/migration maintenance, got reason " +
                JSON.stringify(reason),
            label
        );
    }
    return Object.freeze(new InvalidateEventClass(read.base, scope, readReason.value));
}

/**
 * @param {JournalRecordId | string} id
 * @param {unknown} lastNodeIndex
 * @returns {WriterStateRecord | JournalError}
 */
function makeWriterStateRecord(id, lastNodeIndex) {
    const resolvedId = readRecordId(id, "unknown");
    if (!isJournalRecordId(resolvedId)) {
        return resolvedId;
    }
    const label = journalRecordIdToString(resolvedId);
    if (typeof lastNodeIndex !== "number" || !Number.isSafeInteger(lastNodeIndex) || lastNodeIndex < 0) {
        return makeJournalRecordValidationError(
            "lastNodeIndex must be a non-negative integer, got " + JSON.stringify(lastNodeIndex),
            label
        );
    }
    return Object.freeze(new WriterStateRecordClass(resolvedId, lastNodeIndex));
}

module.exports = {
    DELETE_REASONS,
    INVALIDATE_REASONS,
    VALIDATE_REASONS,
    VALUE_REASONS,
    isDeleteEvent,
    isInvalidateEvent,
    isJournalRecord,
    isSemanticEvent,
    isValidateEvent,
    isValueEvent,
    isWriterStateRecord,
    makeDeleteEvent,
    makeInvalidateEvent,
    makeValidateEvent,
    makeValueEvent,
    makeWriterStateRecord,
};
