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
 * already exists in converted history, so its authority is seeded from the migration
 * physical time like every other non-value event, and no `ValidateEvent` accompanies
 * it: M1 authors values and absence only, and M2 (§16) and M3 (§17) author the proof
 * and persistent-staleness records separately.
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
const { nodeKeyToCanonicalString } = require("./basis");
const { predecessorJournalSequence, requireSuccessorJournalSequence } = require("./coordinates");
const { makeDeleteEvent, makeValueEvent, makeWriterStateRecord } = require("./records");
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
 * `ValueId` no converted record names preserves the source's `NodeIdentifier`,
 * payload and timestamps exactly and is authored as `reason="bootstrap"`. All three
 * cases are stated by the timestamps the caller passes here, so this module does not
 * need to know which decision produced the occurrence.
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
 *     intent per decision whose occurrence no converted record names, whose value is
 *     the target payload the decision settled, and whose `reason` it reads from
 *     whether that decision produced the occurrence or transported it.
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
 * A key whose converted history already selects absence authors no record, so the
 * caller only supplies keys whose absence the migration itself establishes.
 *
 * The properties that this typedef carries are:
 * - `node` is a target-representation `NodeKey` which is absent from the migration
 *   target graph and was not already absent in converted history.
 *
 * The proof of those properties is guaranteed by:
 * - this class cannot enforce the properties by construction;
 * - therefore every function that constructs a `MigrationDeleteIntent` is part of
 *   the proof. The current construction site is:
 *   - `absentKeys(...)`: satisfies the property because it emits one intent per
 *     `ConvertedBeforePresent - TargetPresent` key the migration decided absent.
 *
 * @typedef {object} MigrationDeleteIntent
 * @property {"migrate-delete"} kind
 * @property {NodeKey} node - The target-representation node key.
 */

/**
 * @typedef {MigrationValueIntent | MigrationDeleteIntent} MigrationIntent
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
 * Reject a publication which would author two records at one node key, which would
 * make the target occurrence of that key ambiguous.
 *
 * @param {ReadonlyArray<MigrationIntent>} ordered
 * @returns {JournalError | undefined}
 */
function rejectDuplicateNodes(ordered) {
    for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1];
        const current = ordered[index];
        if (previous === undefined || current === undefined) {
            continue;
        }
        if (nodeKeyToCanonicalString(previous.node) === nodeKeyToCanonicalString(current.node)) {
            return makeJournalPublicationError(
                "the migration target names the node " + nodeKeyToCanonicalString(current.node) +
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

module.exports = {
    finalizeMigrationEmission,
};
