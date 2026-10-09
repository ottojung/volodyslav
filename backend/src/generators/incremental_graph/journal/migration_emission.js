/**
 * Journal emission for Journal-aware migration, `incremental-graph-journal-migrations.md` Part II.
 *
 * Ordinary graph transitions and migration are separate owners of emission.
 * `incremental-graph-journal-emission.md` owns the records an ordinary computor
 * transition authors, and those records carry the `compute`/`operation` reasons.
 * This module owns the records migration authors over an already-converted retained
 * history, and those records carry the `migration` reason: a value occurrence a
 * migration genuinely creates or replaces, and the absence a migration establishes
 * for a target-absent key.
 *
 * The two are separate entry points rather than one parameterized finalizer because
 * their guarantees differ. An ordinary publication's `ValueEvent` is the first
 * occurrence of a node the graph is computing for the first time. A migration
 * `ValueEvent` is a new occurrence over a target key whose *previous* occurrence
 * converted history already names, so its authority is seeded from the migration
 * physical time like every other non-value event, and no `ValidateEvent` accompanies
 * it: M1 authors values and absence only, and M2 (§16) and M3 (§17) author the proof
 * and persistent-staleness records separately. The one exception is the transported
 * `bootstrap` occurrence, for which converted history names no occurrence at all and
 * whose authority is therefore seeded from its own `modifiedAt`.
 *
 * This module is pure. It takes the committed writer state and the settled migration
 * target, and returns the exact records the migration publication must make durable
 * together with the writer state the next publication must observe. It reads no
 * database, allocates no identifier, and consults no clock: every time it uses is
 * passed in.
 */

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
/** @typedef {import('./emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('./emission').FinalizedPublication} FinalizedPublication */

const { makeJournalPublicationError } = require("./errors");
const { makeNodeScope, makeProofScope, makeValueScope, nodeKeyToCanonicalString } = require("./basis");
const { predecessorJournalSequence, requireSuccessorJournalSequence } = require("./coordinates");
const {
    makeDeleteEvent,
    makeInvalidateEvent,
    makeValidateEvent,
    makeValueEvent,
    makeWriterStateRecord,
} = require("./records");
const { allocateAuthority, contextOf, epochMillisecondsOf } = require("./emission");
const {
    frontierJoin,
    makeJournalFrontier,
    makeJournalRecordId,
} = require("./types");

/**
 * One target-present key whose occurrence converted history does not name, and which
 * therefore authors a `ValueEvent`.
 *
 * A `create` allocates a new `NodeIdentifier` and sets `createdAt` to the migration
 * publication time; a `replace` preserves the existing `NodeIdentifier` and
 * `createdAt` and sets `modifiedAt` to the migration publication time
 * (`incremental-graph-journal-migrations.md` §11a.3). A transported occurrence whose
 * `ValueId` no converted record names carries the source replica's persisted payload
 * and the source replica's two persisted timestamps exactly, under the `NodeIdentifier`
 * the migration decision was keyed by rather than one read back out of the source
 * replica, and is authored as `reason="bootstrap"`. The only case this module has to
 * tell apart is that transported one, and it tells it apart by `reason`, the field it
 * branches on: the identifier and the timestamps together do not name it, since a
 * replacement whose source `createdAt` equals the publication instant, or a
 * transported occurrence whose `modifiedAt` equals it, is indistinguishable from the
 * other cases by timestamps alone. So this module does not need to know which decision
 * produced the occurrence — it never sees a decision — but the caller has to state
 * which case this is, because `reason` is the field that states it.
 *
 * The properties that this typedef carries are:
 * - `node` is a target-representation `NodeKey` which is present in the migration
 *   target graph and whose occurrence converted history does not already name;
 * - `payload` is the target-version `ComputedValue` of exactly that occurrence;
 * - `reason` names why the occurrence is authored: `migration` when the migration
 *   genuinely produces the occurrence at the cut, and `bootstrap` when the migration
 *   transports a persisted legacy occurrence which no converted record names.
 *
 * The proof of those properties is guaranteed by:
 * - this class cannot enforce the properties by construction, since it is a
 *   structural record of an already-settled decision;
 * - therefore every function that constructs a `MigrationValueIntent` is part of the
 *   proof. The current construction site is:
 *   - `buildMigrationM1Intents(...)`: satisfies the property because it emits one
 *     intent per decision whose occurrence no converted record names, taking the
 *     intent's value and timestamps out of the single occurrence map rather than
 *     deriving them per `reason`: for a produced occurrence the map holds what the
 *     decision settled, and for a transported occurrence it holds what
 *     `readTransportedOccurrence` read back from the source replica's storage. Its
 *     `nodeIdentifier` is the key the settled decisions map is keyed by, which is why
 *     it is the decision's own materialization in both cases, and its `reason` it
 *     reads from the occurrence.
 *
 * @typedef {object} MigrationValueIntent
 * @property {"migrate-value"} kind
 * @property {NodeKey} node - The target-representation node key.
 * @property {NodeIdentifier} nodeIdentifier - The materialization this occurrence belongs to.
 * @property {ComputedValue} payload - The target-version value.
 * @property {string} createdAt - Canonical whole-millisecond instant the occurrence was created.
 * @property {string} modifiedAt - Canonical whole-millisecond instant the occurrence was last modified.
 * @property {"migration" | "bootstrap"} reason - Why this occurrence is authored.
 */

/**
 * One key which is present in the converted source projection and absent from the
 * migration target graph, and which therefore authors one required
 * `DeleteEvent(reason="migration")`.
 *
 * The properties that this typedef carries are:
 * - `node` names an occurrence the migration decided absent.
 *
 * The proof of those properties is guaranteed by:
 * - this class cannot enforce the properties by construction;
 * - therefore every function that constructs a `MigrationDeleteIntent` is part of the
 *   proof. The current construction site is:
 *   - `buildMigrationM1Intents(...)`: satisfies the property because it emits one
 *     intent per decision of kind `delete`, resolving that decision's `node` from the
 *     source replica's identifier lookup and rejecting a decision whose key the source
 *     replica does not materialize rather than emitting an intent for it.
 *
 * Nothing here reads the converted retained history, so this module neither knows nor
 * needs to know which keys that history already selects absent.
 *
 * @typedef {object} MigrationDeleteIntent
 * @property {"migrate-delete"} kind
 * @property {NodeKey} node - The target-representation node key.
 */

/**
 * One key which the migration explicitly invalidated at the cut, and which therefore
 * authors one `InvalidateEvent(scope=node, reason="migration")`
 * (`incremental-graph-journal-migrations.md` §16.1).
 *
 * The properties that this typedef carries are:
 * - `node` names an occurrence the migration explicitly invalidated.
 *
 * The proof of those properties is guaranteed by:
 * - this class cannot enforce the properties by construction;
 * - therefore every function that constructs a `MigrationInvalidateIntent` is part of
 *   the proof. The current construction site is:
 *   - `buildMigrationM1Intents(...)`: satisfies the property because it emits one
 *     intent per decision of kind `invalidate` whose provenance is `explicit`,
 *     resolving that decision's node from the transported target key view and
 *     rejecting a decision whose key the codec could not transport rather than
 *     emitting an intent for it.
 *
 * A propagated invalidation authors no record here: §11a.2 keeps propagated freshness
 * separate from a semantic migration decision, so replay derives it through the
 * invalidated input and no stored marker is needed for it.
 *
 * @typedef {object} MigrationInvalidateIntent
 * @property {"migrate-invalidate"} kind
 * @property {NodeKey} node - The target-representation node key.
 */

/**
 * @typedef {MigrationValueIntent | MigrationDeleteIntent | MigrationInvalidateIntent} MigrationIntent
 */

/**
 * One occurrence-scoped proof barrier of Pass M2: an incoming edge the target must
 * not expose, retired for the exact preserved occurrence
 * (`incremental-graph-journal-migrations.md` §16.2).
 *
 * @typedef {object} MigrationProofBarrierIntent
 * @property {"migrate-proof-barrier"} kind
 * @property {NodeKey} node
 * @property {JournalRecordId} value
 * @property {NodeKey} input
 */

/**
 * One target certificate of Pass M2 for a preserved or produced occurrence whose
 * replay state does not already yield exactly the target's validity edges
 * (`incremental-graph-journal-migrations.md` §16.3).
 *
 * @typedef {object} MigrationValidationIntent
 * @property {"migrate-validate"} kind
 * @property {NodeKey} node
 * @property {JournalRecordId} value
 * @property {import('./basis').ValidationBasis} basis
 */

/**
 * One target-persistent-stale marker of Pass M3 for a target-stale occurrence whose
 * own proof is ready (`incremental-graph-journal-migrations.md` §17).
 *
 * @typedef {object} MigrationStaleMarkerIntent
 * @property {"migrate-stale-marker"} kind
 * @property {NodeKey} node
 * @property {JournalRecordId} value
 */

/**
 * @typedef {MigrationProofBarrierIntent | MigrationValidationIntent | MigrationStaleMarkerIntent} MigrationRepairIntent
 */

/**
 * @typedef {object} MigrationEmissionRequest
 * @property {CommittedWriterState} state - The committed state the migration publication starts from.
 * @property {ReadonlyArray<MigrationIntent>} intents - The settled M1 value/absence transition.
 * @property {number} publicationInstant - Epoch milliseconds of the migration publication, used as
 *   the authority seed of every record.
 * @property {number} allocatorWatermark - The local allocation watermark this publication durably
 *   establishes.
 */

/**
 * The canonical order of one migration publication's intents. M1 authors values and
 * absence only, and no M1 record names another M1 record, so canonical NodeKey order
 * is a total order of this pass's semantics and the tie-break is only there to make
 * the order a function of the intent list alone.
 *
 * @param {MigrationIntent} left
 * @param {MigrationIntent} right
 * @returns {number}
 */
function compareMigrationIntents(left, right) {
    const leftText = nodeKeyToCanonicalString(left.node);
    const rightText = nodeKeyToCanonicalString(right.node);
    if (leftText < rightText) {
        return -1;
    }
    return leftText > rightText ? 1 : 0;
}

/**
 * Reject a publication which would author two records whose target occurrence is
 * ambiguous.
 *
 * At most one `ValueEvent` and at most one `DeleteEvent` may name one node key: a
 * second one would make the target occurrence or the target absence of that key
 * undetermined. A node-scoped invalidation is not in that set, because it retires the
 * certificates which named the occurrence rather than naming a second occurrence, so
 * it may accompany the value record of the same key.
 *
 * @param {ReadonlyArray<MigrationIntent>} ordered
 * @returns {JournalError | undefined}
 */
function rejectDuplicateNodes(ordered) {
    /** @type {Map<string, Set<string>>} */
    const kindsByNode = new Map();
    for (const intent of ordered) {
        const nodeText = nodeKeyToCanonicalString(intent.node);
        const occurrenceKinds = kindsByNode.get(nodeText) ?? new Set();
        if (intent.kind === "migrate-value") {
            occurrenceKinds.add("value");
        } else if (intent.kind === "migrate-delete") {
            occurrenceKinds.add("delete");
        }
        kindsByNode.set(nodeText, occurrenceKinds);
    }
    for (const [nodeText, occurrenceKinds] of kindsByNode) {
        if (occurrenceKinds.has("value") && occurrenceKinds.has("delete")) {
            return makeJournalPublicationError(
                "the migration target names the node " + nodeText +
                    " both present and absent, so its target occurrence is ambiguous"
            );
        }
        if (occurrenceKinds.size > 1) {
            return makeJournalPublicationError(
                "the migration target names the occurrence of the node " + nodeText +
                    " more than once, so its target occurrence is ambiguous"
            );
        }
    }
    return undefined;
}

/**
 * Finalize the M1 migration publication over an already-converted retained history.
 *
 * Allocates a contiguous own-writer range from `writerHead`, gives every record a
 * context which observes the complete committed frontier through its own coordinate,
 * allocates each authority time strictly above the high-water, and returns the
 * advanced committed state.
 *
 * @param {MigrationEmissionRequest} request
 * @returns {FinalizedPublication | JournalError}
 */
function finalizeMigrationEmission(request) {
    const { state, intents, publicationInstant, allocatorWatermark } = request;
    if (!Number.isSafeInteger(publicationInstant) || publicationInstant < 0) {
        return makeJournalPublicationError(
            "migration publication instant must be a non-negative whole millisecond, got " +
                JSON.stringify(publicationInstant)
        );
    }
    if (!Number.isSafeInteger(allocatorWatermark) || allocatorWatermark < 0) {
        return makeJournalPublicationError(
            "migration allocator watermark must be a non-negative integer, got " +
                JSON.stringify(allocatorWatermark)
        );
    }

    const ordered = intents.slice().sort(compareMigrationIntents);
    const duplicated = rejectDuplicateNodes(ordered);
    if (duplicated !== undefined) {
        return duplicated;
    }

    /** @type {JournalAuthor} */
    const localWriter = state.localWriter;
    /** @type {JournalRecord[]} */
    const records = [];
    /** @type {JournalSequence} */
    let nextSequence = requireSuccessorJournalSequence(state.writerHead);
    /** @type {AuthorityTime} */
    let highWater = state.authorityHighWater;

    for (const intent of ordered) {
        const id = makeJournalRecordId(localWriter, nextSequence);
        if (id instanceof Error) {
            return id;
        }
        const ownPrefix = predecessorJournalSequence(nextSequence);
        if (ownPrefix instanceof Error) {
            return ownPrefix;
        }
        const context = contextOf(state, localWriter, ownPrefix);
        if (context instanceof Error) {
            return context;
        }
        // Every M1 record is seeded from the migration physical time rather than from
        // an occurrence timestamp: a migration `ValueEvent` is semantic production at
        // the migration cut, not the ordinary restatement of a historical
        // `modifiedAt` as its authority seed.
        //
        // A `bootstrap` `ValueEvent` is the exception: it restates a persisted legacy
        // occurrence which converted history does not name, so its authority must be
        // seeded from that occurrence's own `modifiedAt`. Seeding it from the migration
        // instant would give upgrade time precedence over history and would make the
        // occurrence sort after every historical record it actually precedes.
        let seedPhysical = publicationInstant;
        if (intent.kind === "migrate-value" && intent.reason === "bootstrap") {
            seedPhysical = epochMillisecondsOf(intent.modifiedAt);
            if (!Number.isSafeInteger(seedPhysical) || seedPhysical < 0) {
                return makeJournalPublicationError(
                    "modifiedAt must be a canonical whole-millisecond instant to allocate " +
                        "authority, got " + JSON.stringify(intent.modifiedAt)
                );
            }
        }
        const allocated = allocateAuthority(highWater, seedPhysical);
        if ("error" in allocated) {
            return allocated.error;
        }
        const base = { id, context, authorityTime: allocated.authorityTime, node: intent.node };
        /** @type {JournalRecord | JournalError} */
        let record;
        if (intent.kind === "migrate-value") {
            record = makeValueEvent(
                base,
                intent.nodeIdentifier,
                intent.payload,
                intent.createdAt,
                intent.modifiedAt,
                intent.reason
            );
        } else if (intent.kind === "migrate-invalidate") {
            record = makeInvalidateEvent(base, makeNodeScope(), "migration");
        } else {
            record = makeDeleteEvent(base, "migration");
        }
        if (record instanceof Error) {
            return record;
        }
        records.push(record);
        highWater = allocated.highWater;
        nextSequence = requireSuccessorJournalSequence(nextSequence);
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
        nextSequence = requireSuccessorJournalSequence(nextSequence);
    }

    if (records.length === 0) {
        return makeJournalPublicationError(
            "a migration which created no occurrence and established no absence must author no record"
        );
    }

    const lastRecord = records[records.length - 1];
    if (lastRecord === undefined) {
        return makeJournalPublicationError("the migration publication authored no record");
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
    if (newFrontier instanceof Error) {
        return newFrontier;
    }
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
 * Finalize the M2/M3 repair publication of one migration over the already-converted
 * and M1-extended target history.
 *
 * The requests arrive in the order the passes fixed them — barriers, then target
 * certificates, then value markers — because a barrier must be causally earlier than
 * the certificate which re-proves the target's remaining edges, and the marker must
 * observe the certificate. Every record is seeded from the migration publication
 * instant like every other non-value migration record, and its context observes the
 * committed frontier the M1 publication left, so the repair records are causally
 * after M1.
 *
 * @param {object} request
 * @param {CommittedWriterState} request.state
 * @param {ReadonlyArray<MigrationRepairIntent>} request.requests
 * @param {number} request.publicationInstant
 * @returns {{records: ReadonlyArray<JournalRecord>, writerState: CommittedWriterState} | JournalError}
 */
function finalizeMigrationRepair(request) {
    const { state, requests, publicationInstant } = request;
    if (!Number.isSafeInteger(publicationInstant) || publicationInstant < 0) {
        return makeJournalPublicationError(
            "migration publication instant must be a non-negative whole millisecond, got " +
                JSON.stringify(publicationInstant)
        );
    }
    if (requests.length === 0) {
        return { records: [], writerState: state };
    }

    /** @type {JournalAuthor} */
    const localWriter = state.localWriter;
    /** @type {JournalRecord[]} */
    const records = [];
    /** @type {JournalSequence} */
    let nextSequence = requireSuccessorJournalSequence(state.writerHead);
    /** @type {AuthorityTime} */
    let highWater = state.authorityHighWater;

    for (const entry of requests) {
        const id = makeJournalRecordId(localWriter, nextSequence);
        if (id instanceof Error) {
            return id;
        }
        const ownPrefix = predecessorJournalSequence(nextSequence);
        if (ownPrefix instanceof Error) {
            return ownPrefix;
        }
        const context = contextOf(state, localWriter, ownPrefix);
        if (context instanceof Error) {
            return context;
        }
        const allocated = allocateAuthority(highWater, publicationInstant);
        if ("error" in allocated) {
            return allocated.error;
        }
        const base = { id, context, authorityTime: allocated.authorityTime, node: entry.node };
        /** @type {JournalRecord | JournalError} */
        let record;
        if (entry.kind === "migrate-proof-barrier") {
            record = makeInvalidateEvent(base, makeProofScope(entry.value, entry.input), "migration");
        } else if (entry.kind === "migrate-validate") {
            record = makeValidateEvent(base, entry.value, entry.basis, "migration");
        } else {
            record = makeInvalidateEvent(base, makeValueScope(entry.value), "migration");
        }
        if (record instanceof Error) {
            return record;
        }
        records.push(record);
        highWater = allocated.highWater;
        nextSequence = requireSuccessorJournalSequence(nextSequence);
    }

    const lastRecord = records[records.length - 1];
    if (lastRecord === undefined) {
        return makeJournalPublicationError("the migration repair publication authored no record");
    }
    const advanced = makeJournalFrontier([[localWriter, lastRecord.id.sequence]]);
    if (advanced instanceof Error) {
        return advanced;
    }
    const newFrontier = frontierJoin(state.committedFrontier, advanced);
    if (newFrontier instanceof Error) {
        return newFrontier;
    }
    return {
        records,
        writerState: {
            localWriter,
            writerHead: lastRecord.id.sequence,
            committedFrontier: newFrontier,
            authorityHighWater: highWater,
            allocatorWatermark: state.allocatorWatermark,
        },
    };
}

module.exports = {
    finalizeMigrationEmission,
    finalizeMigrationRepair,
};
