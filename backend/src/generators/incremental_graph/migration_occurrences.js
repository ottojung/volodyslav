/**
 * Produce every value occurrence the migration's target graph materializes which
 * converted history does not already name.
 *
 * `incremental-graph-journal-migrations.md` §11a.3 fixes the timestamps of the
 * occurrences a migration genuinely creates or replaces: a `create` allocates a new
 * materialization and takes the migration publication time for both `createdAt` and
 * `modifiedAt`, while a replacement keeps the existing materialization and
 * `createdAt` and takes the publication time only as its `modifiedAt`.
 *
 * An occurrence-preserving decision transports a persisted occurrence, and §15
 * requires no record for it because converted history already names its `ValueId`.
 * That premise holds exactly when the source replica's retained Journal names the
 * occurrence. A source replica whose retained history predates the Journal names no
 * occurrence at all, and an occurrence-preserving decision against it transports a
 * value occurrence no record describes. Such an occurrence is produced here from the
 * source replica's own persisted fields — identifier, payload and timestamps preserved
 * exactly — and M1 authors it with `reason="bootstrap"`, so the transported value and
 * the record which names it cannot disagree.
 *
 * Each occurrence is produced exactly once, here, and every consumer of a produced
 * occurrence reads it rather than re-deriving it: the cutover reads the occurrence's
 * value and §11a.3 timestamps for the target replica's graph state, and the M1
 * `ValueEvent` names the same occurrence. The graph projection and the journal record
 * therefore describe one occurrence rather than two disagreeing representations of it.
 */

const { makeInvalidMigrationDecisionError } = require("./migration_errors");
const { stringToNodeKeyString, nodeIdentifierToString } = require("./database");

/** @typedef {import('./migration_storage').Decision} Decision */
/** @typedef {import('./migration_storage').ReadableMigrationStorage} ReadableMigrationStorage */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./migration_m1').TargetOccurrence} TargetOccurrence */

/**
 * Produce every value occurrence the migration's target graph materializes which
 * the converted retained history does not name.
 *
 * A `create` or a replacement genuinely produces its occurrence, so it is always
 * produced. An occurrence-preserving decision produces one exactly when the source
 * replica's retained history names no occurrence for its node key, in which case the
 * occurrence is the source replica's own persisted one: same `NodeIdentifier`, same
 * payload, same timestamps.
 *
 * @param {Map<NodeIdentifier, Decision>} decisions - The settled decisions, keyed by target materialization.
 * @param {ReadableMigrationStorage} prevStorage - The source replica, which holds the replaced occurrence's timestamps.
 * @param {IdentifierLookup} oldLookup - The source replica identifier lookup, which supplies the replaced node key.
 * @param {string} publicationInstant - Canonical whole-millisecond ISO instant of the migration.
 * @param {(nodeKeyString: import('./database/types').NodeKeyString) => Promise<boolean>} namesOccurrence - Whether the
 *   source replica's retained Journal names a value occurrence of this node key.
 * @returns {Promise<Map<NodeIdentifier, TargetOccurrence>>}
 */
async function buildProducedOccurrences(decisions, prevStorage, oldLookup, publicationInstant, namesOccurrence) {
    /** @type {Map<NodeIdentifier, TargetOccurrence>} */
    const produced = new Map();
    for (const [identifier, decision] of decisions) {
        if (decision.kind === "delete") {
            continue;
        }
        if (decision.kind !== "create" && decision.kind !== "override") {
            const transported = await readTransportedOccurrence(
                identifier,
                prevStorage,
                oldLookup,
                namesOccurrence
            );
            if (transported !== undefined) {
                produced.set(identifier, transported);
            }
            continue;
        }
        const value = await decision.value(identifier);
        if (value === null || value === undefined) {
            throw makeInvalidMigrationDecisionError(
                `Migration value producer for ${String(identifier)} did not return a computed value`
            );
        }
        if (decision.kind === "create") {
            const nodeKeyString = decision.nodeKeyString;
            if (nodeKeyString === undefined) {
                throw makeInvalidMigrationDecisionError(
                    `Migration create for ${String(identifier)} has no target node key`
                );
            }
            produced.set(identifier, {
                identifier,
                nodeKeyString: stringToNodeKeyString(nodeKeyString),
                value,
                createdAt: publicationInstant,
                modifiedAt: publicationInstant,
                reason: "migration",
            });
            continue;
        }
        const sourceKeyString = oldLookup.idToKey.get(nodeIdentifierToString(identifier));
        if (sourceKeyString === undefined) {
            throw makeInvalidMigrationDecisionError(
                `Migration replaced ${String(identifier)}, which the source replica does not materialize`
            );
        }
        const existing = await prevStorage.timestamps.get(identifier);
        if (existing === undefined) {
            throw makeInvalidMigrationDecisionError(
                `Migration replaced ${String(identifier)}, whose source replica has no timestamps`
            );
        }
        produced.set(identifier, {
            identifier,
            nodeKeyString: stringToNodeKeyString(String(sourceKeyString)),
            value,
            createdAt: existing.createdAt,
            modifiedAt: publicationInstant,
            reason: "migration",
        });
    }
    return produced;
}

/**
 * The occurrence an occurrence-preserving decision transports, when converted history
 * names none.
 *
 * The transported occurrence is the source replica's own: the same materialization,
 * the same persisted payload, and the same two instants. The migration neither
 * reinterprets it nor re-times it, so the graph state the target persists and the
 * record M1 authors for it describe one occurrence.
 *
 * @param {NodeIdentifier} identifier - The target materialization of the transported occurrence.
 * @param {ReadableMigrationStorage} prevStorage - The source replica, which persists the occurrence.
 * @param {IdentifierLookup} oldLookup - The source replica identifier lookup, which supplies the node key.
 * @param {(nodeKeyString: import('./database/types').NodeKeyString) => Promise<boolean>} namesOccurrence - Whether
 *   the source replica's retained Journal names a value occurrence of this node key.
 * @returns {Promise<TargetOccurrence | undefined>} The transported occurrence, or `undefined` when
 *   converted history already names one.
 */
async function readTransportedOccurrence(identifier, prevStorage, oldLookup, namesOccurrence) {
    const sourceKeyString = oldLookup.idToKey.get(nodeIdentifierToString(identifier));
    if (sourceKeyString === undefined) {
        throw makeInvalidMigrationDecisionError(
            `Migration preserves ${String(identifier)}, which the source replica does not materialize`
        );
    }
    const nodeKeyString = stringToNodeKeyString(String(sourceKeyString));
    if (await namesOccurrence(nodeKeyString)) {
        return undefined;
    }
    const [timestamps, value] = await Promise.all([
        prevStorage.timestamps.get(identifier),
        prevStorage.values.get(identifier),
    ]);
    if (timestamps === undefined) {
        throw makeInvalidMigrationDecisionError(
            `Migration transports ${String(identifier)}, whose source replica has no timestamps`
        );
    }
    if (value === undefined) {
        throw makeInvalidMigrationDecisionError(
            `Migration transports ${String(identifier)}, whose source replica has no value`
        );
    }
    return {
        identifier,
        nodeKeyString,
        value,
        createdAt: timestamps.createdAt,
        modifiedAt: timestamps.modifiedAt,
        reason: "bootstrap",
    };
}

module.exports = {
    buildProducedOccurrences,
};
