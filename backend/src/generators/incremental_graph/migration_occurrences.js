/**
 * The value occurrences a Journal-aware migration genuinely produces.
 *
 * `incremental-graph-journal-migrations.md` §11a.3 fixes the identity of a produced
 * occurrence, and the produced occurrence is the thing the M1 `ValueEvent` of §15
 * names. A `create` allocates a new materialization and takes the migration
 * publication time for both `createdAt` and `modifiedAt`; a replacement keeps the
 * existing materialization and `createdAt` and takes the publication time only as its
 * `modifiedAt`.
 *
 * Each occurrence is produced exactly once, here, so the graph state the cutover
 * writes into the target replica and the journal record which explains it cannot
 * disagree about which occurrence they name.
 */

const { makeInvalidMigrationDecisionError } = require("./migration_errors");
const { stringToNodeKeyString, nodeIdentifierToString } = require("./database");

/** @typedef {import('./migration_storage').Decision} Decision */
/** @typedef {import('./migration_storage').ReadableMigrationStorage} ReadableMigrationStorage */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./migration_m1').TargetOccurrence} TargetOccurrence */

/**
 * Produce the value occurrences a migration genuinely creates or replaces.
 *
 * `incremental-graph-journal-migrations.md` §11a.3 fixes the timestamps of these
 * occurrences: a `create` allocates a new materialization and takes the migration
 * publication time for both `createdAt` and `modifiedAt`, while a replacement keeps the
 * existing materialization and `createdAt` and takes the publication time only as its
 * `modifiedAt`. Both are produced here, once, so the graph state written into the
 * target replica and the M1 `ValueEvent` which names the occurrence cannot disagree.
 *
 * @param {Map<NodeIdentifier, Decision>} decisions - The settled decisions, keyed by target materialization.
 * @param {ReadableMigrationStorage} prevStorage - The source replica, which holds the replaced occurrence's timestamps.
 * @param {IdentifierLookup} oldLookup - The source replica identifier lookup, which supplies the replaced node key.
 * @param {string} publicationInstant - Canonical whole-millisecond ISO instant of the migration.
 * @returns {Promise<Map<NodeIdentifier, TargetOccurrence>>}
 */
async function buildProducedOccurrences(decisions, prevStorage, oldLookup, publicationInstant) {
    /** @type {Map<NodeIdentifier, TargetOccurrence>} */
    const produced = new Map();
    for (const [identifier, decision] of decisions) {
        if (decision.kind !== "create" && decision.kind !== "override") {
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
        });
    }
    return produced;
}

module.exports = {
    buildProducedOccurrences,
};
