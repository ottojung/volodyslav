/**
 * Pass M1 of Journal-aware migration: target values and absence.
 *
 * `incremental-graph-journal-migrations.md` §15 states what a migration must author
 * for target presence and target absence, and this module is that statement in
 * executable form. It reads the settled migration decisions and the source replica's
 * materialization, and returns the value/absence transitions M1 encodes.
 *
 * M1 is deliberately only about occurrences and absence. The proof a preserved
 * occurrence retains and the persistent staleness a target-stale occurrence needs are
 * M2 (§16) and M3 (§17), and `incremental-graph-journal-migrations.md` §11a is what
 * constructs `Gtarget` in the first place. This module does not decide semantics: it
 * translates decisions which have already been settled into the records which encode
 * them, so a decision cannot be expressed in the journal differently from how it was
 * decided.
 *
 * The occurrence-identity rule this module implements is §15's: a genuine
 * `create`/`replace` authors a `ValueEvent`, and an occurrence-preserving `keep` or
 * `invalidate` authors none, because the transported occurrence keeps the `ValueId`
 * converted history already gave it.
 */

const { makeInvalidMigrationDecisionError } = require("./migration_errors");
const { stringToNodeKeyString, nodeIdentifierToString } = require("./database");

/** @typedef {import('./migration_storage').Decision} Decision */
/** @typedef {import('./journal/migration_emission').MigrationIntent} MigrationIntent */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/node_key').NodeKey} NodeKey */

/**
 * The target value occurrence of a node the migration's target graph materializes,
 * together with the timestamps §11a.3 assigns it.
 *
 * The properties that this class carries are:
 * - `identifier` is the target materialization the occurrence belongs to;
 * - `value` is the target-version `ComputedValue` of that occurrence;
 * - `createdAt`/`modifiedAt` are the canonical instants §11a.3 assigns: a `create`
 *   gets `createdAt == modifiedAt ==` the migration publication time, a replacement
 *   preserves the existing `createdAt` while taking the publication time as its
 *   `modifiedAt`, and a transported occurrence preserves both instants of the source
 *   replica it came from;
 * - `reason` states why the occurrence is authored: `migration` when the decision
 *   produced the occurrence at the cut, `bootstrap` when the decision transported an
 *   occurrence converted history does not name.
 *
 * The proof of those properties is guaranteed by:
 * - this typedef cannot enforce the properties by construction;
 * - therefore every function that constructs a `TargetOccurrence` is part of the
 *   proof. The current construction sites are:
 *   - `buildProducedOccurrences(...)`: satisfies the property because it is the
 *     single place a migration produces an occurrence, deriving every field from the
 *     migration decision, the source replica's stored timestamps, and the migration
 *     publication instant passed in, and never from a default.
 *
 * Because `buildProducedOccurrences` is the only producer, the graph state the cutover
 * writes into the target replica and the M1 `ValueEvent` which names the occurrence
 * are derived from the same value and cannot disagree about its identity or its
 * timestamps.
 *
 * @typedef {object} TargetOccurrence
 * @property {NodeIdentifier} identifier
 * @property {NodeKeyString} nodeKeyString
 * @property {ComputedValue} value
 * @property {string} createdAt
 * @property {string} modifiedAt
 * @property {"migration" | "bootstrap"} reason
 */

/**
 * Build the M1 value/absence intents of one settled migration.
 *
 * For each target-present key whose decision produces an occurrence no converted
 * record names, the result carries one `migrate-value` intent. For each
 * converted-source-present key the migration decided absent, the result carries one
 * `migrate-delete` intent. An occurrence-preserving `keep` or `invalidate` whose
 * converted history names the occurrence contributes no intent at all: its `ValueId`
 * is the one converted history already retains.
 *
 * @param {Map<NodeIdentifier, Decision>} decisions - The settled decisions, keyed by target materialization.
 * @param {import('./database/identifier_lookup').IdentifierLookup} sourceLookup - The source replica's
 *   identifier lookup, which supplies the source NodeKey of every transported key.
 * @param {ReadonlyMap<NodeIdentifier, TargetOccurrence>} producedOccurrences - The occurrences no
 *   converted record names, already carrying their §11a.3 timestamps and values.
 * @param {(nodeKeyString: import('./database/types').NodeKeyString) => NodeKey} toNodeKey - Narrows a persisted NodeKeyString to
 *   the `NodeKey` the journal record names.
 * @returns {Array<MigrationIntent>}
 */
function buildMigrationM1Intents(decisions, sourceLookup, producedOccurrences, toNodeKey) {
    /** @type {Array<MigrationIntent>} */
    const intents = [];

    for (const [identifier, decision] of decisions) {
        if (decision.kind === "delete") {
            continue;
        }
        const occurrence = producedOccurrences.get(identifier);
        if (occurrence === undefined) {
            if (decision.kind === "create" || decision.kind === "override") {
                throw makeInvalidMigrationDecisionError(
                    "migration decision " + decision.kind + " for " + nodeIdentifierToString(identifier) +
                        " produced no target value occurrence"
                );
            }
            // The converted history names this occurrence, so §15 requires no
            // ValueEvent for it: `keep` and `invalidate` preserve the `ValueId`
            // already retained. Proof (M2) and persistent staleness (M3) are
            // separate passes and author nothing here.
            continue;
        }
        intents.push({
            kind: "migrate-value",
            node: toNodeKey(occurrence.nodeKeyString),
            nodeIdentifier: identifier,
            payload: occurrence.value,
            createdAt: occurrence.createdAt,
            modifiedAt: occurrence.modifiedAt,
            reason: occurrence.reason,
        });
    }

    for (const [identifier, decision] of decisions) {
        if (decision.kind !== "delete") {
            continue;
        }
        const sourceKeyString = sourceLookup.idToKey.get(nodeIdentifierToString(identifier));
        if (sourceKeyString === undefined) {
            throw makeInvalidMigrationDecisionError(
                "migration deleted " + nodeIdentifierToString(identifier) +
                    ", which the source replica does not materialize"
            );
        }
        intents.push({
            kind: "migrate-delete",
            node: toNodeKey(stringToNodeKeyString(String(sourceKeyString))),
        });
    }

    return intents;
}

module.exports = {
    buildMigrationM1Intents,
};
