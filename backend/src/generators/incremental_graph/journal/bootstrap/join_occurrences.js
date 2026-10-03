/**
 * Pass J1 of `incremental-graph-journal-migrations.md` §7.2: establish one value
 * occurrence per materialized joining node.
 *
 * An occurrence whose immutable fields are exactly the canonical occurrence's keeps
 * the canonical `ValueId` and authors nothing, because the two replicas already hold
 * the same physical occurrence. Every other materialized node becomes a
 * joining-writer historical `ValueEvent` under the §7.1 context exception, allocated
 * in nondecreasing `(modifiedAt, canonical NodeKey)` order with authority seeded from
 * its own legacy `modifiedAt`, so the joining writer's own sequence order never
 * contradicts its bootstrap `AuthorityTime`.
 *
 * A canonical node the joining graph does not materialize is not deleted here: legacy
 * cache absence is not timestamped deletion evidence, so no `DeleteEvent` is authored
 * by this pass at all.
 */

const { nodeKeyStringToString } = require("../../database");
const { makeJournalPublicationError } = require("../errors");
const { epochMillisecondsOf } = require("../emission");
const { makeValueEvent } = require("../records");
const { isExactSharedOccurrence, joiningValueOrder } = require("./joining_support");

/** @typedef {import('../errors').AnyJournalError} JournalError */
/** @typedef {import('../types').JournalRecordId} JournalRecordId */
/** @typedef {import('../oracle/projection').Projection} Projection */
/** @typedef {import('../oracle/projection').ProjectedOccurrence} ProjectedOccurrence */
/** @typedef {import('./joining_support').JoiningCursorClass} JoiningCursor */
/** @typedef {import('./legacy_state').LegacyBootstrapState} LegacyBootstrapState */

/**
 * The properties that this typedef carries are:
 * - `valueIdOf` is the Journal identity of each materialized joining node's own
 *   legacy occurrence, the canonical one where the occurrence is exact-shared and the
 *   new historical value's own id otherwise;
 * - `locallyAuthored` names exactly the nodes for which this pass authored that
 *   value, which is the set §7.3 gives local proof;
 * - `exactShared` names exactly the nodes whose occurrence is the canonical
 *   occurrence itself, which is the set whose canonical `ValueId`s §7.5 requires the
 *   join to preserve;
 * - `selected` is the replay of the canonical cut together with those values, so the
 *   caller reads conflict selection from replay instead of predicting it.
 *
 * The proof of those properties is guaranteed by:
 * - `establishJoiningOccurrences(options)`: fills `valueIdOf` from the canonical
 *   occurrence exactly when `isExactSharedOccurrence` holds, and otherwise only from
 *   the `ValueEvent` it has just appended to the joining cursor; and appends every
 *   joining value before the returned replay is taken, so the replay observes the
 *   whole of Pass J1.
 *
 * @typedef {object} JoiningOccurrences
 * @property {Map<string, JournalRecordId>} valueIdOf
 * @property {Set<string>} locallyAuthored
 * @property {Set<string>} exactShared
 * @property {Projection} selected
 */

/**
 * @typedef {object} EstablishJoiningOccurrencesOptions
 * @property {LegacyBootstrapState} legacyState - The joining replica's persisted
 *   pre-Journal graph.
 * @property {Map<string, ProjectedOccurrence>} canonicalOccurrences - The canonical
 *   cut's occurrences, keyed by canonical NodeKey identity.
 * @property {JoiningCursor} cursor - The joining replica's record cursor.
 * @property {() => Projection | JournalError} replay - Replays the canonical cut
 *   together with the joining records authored so far.
 */

/**
 * @param {EstablishJoiningOccurrencesOptions} options
 * @returns {JoiningOccurrences | JournalError}
 */
function establishJoiningOccurrences(options) {
    const { legacyState, canonicalOccurrences, cursor, replay } = options;
    // Pass J1: one occurrence per materialized joining node.
    /** @type {Map<string, JournalRecordId>} */
    const joiningOccurrenceValueId = new Map();
    /** @type {Set<string>} */
    const locallyAuthored = new Set();
    /** @type {Set<string>} */
    const exactShared = new Set();
    for (const legacyNode of joiningValueOrder(legacyState)) {
        const key = nodeKeyStringToString(legacyNode.nodeKeyString);
        const canonical = canonicalOccurrences.get(key);
        if (canonical !== undefined && isExactSharedOccurrence(canonical, legacyNode)) {
            joiningOccurrenceValueId.set(key, canonical.valueId);
            exactShared.add(key);
            continue;
        }
        const physical = epochMillisecondsOf(legacyNode.modifiedAt);
        if (!Number.isSafeInteger(physical) || physical < 0) {
            return makeJournalPublicationError(
                "the joining pre-Journal source persists the modifiedAt " +
                    JSON.stringify(legacyNode.modifiedAt) +
                    " for " +
                    key +
                    ", which is not a canonical whole-millisecond instant, so no joining authority can be " +
                    "seeded from it"
            );
        }
        const allocated = cursor.allocate(true, physical);
        if ("error" in allocated) {
            return allocated.error;
        }
        const record = makeValueEvent(
            { ...allocated.fields, node: legacyNode.node },
            legacyNode.nodeIdentifier,
            legacyNode.payload,
            legacyNode.createdAt,
            legacyNode.modifiedAt,
            "bootstrap"
        );
        if (record instanceof Error) {
            return record;
        }
        cursor.append(record);
        joiningOccurrenceValueId.set(key, record.id);
        locallyAuthored.add(key);
    }

    const afterValues = replay();
    if (afterValues instanceof Error) {
        return afterValues;
    }

    return {
        valueIdOf: joiningOccurrenceValueId,
        locallyAuthored,
        exactShared,
        selected: afterValues,
    };
}

module.exports = {
    establishJoiningOccurrences,
};
