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
 * `invalidate` authors one only when the source replica's retained history names no
 * occurrence for it, because converted history then names no `ValueId` for it. An
 * occurrence-preserving decision whose converted history does name the occurrence
 * authors none, keeping the `ValueId` converted history already gave it.
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
 *   - `buildProducedOccurrences(...)`: satisfies the property because for a `create`
 *     and for a replacement it derives every field from the migration decision, the
 *     source replica's stored timestamps, and the migration publication instant passed
 *     in, and never from a default, because a missing value or a missing stored
 *     timestamp is rejected rather than defaulted.
 *   - `readTransportedOccurrence(...)`: satisfies the property because it derives
 *     `nodeKeyString` from the source replica's identifier lookup and derives
 *     `value`, `createdAt` and `modifiedAt` from the source replica's own persisted
 *     `values` and `timestamps`, taking the source replica's persisted value as the
 *     occurrence's value rather than re-deriving it from a decision, and it tags the
 *     result `bootstrap` because no migration decision produced it. A missing
 *     persisted value or timestamp is rejected rather than defaulted.
 *
 * The graph state the cutover writes into the target replica and the M1 `ValueEvent`
 * which names the occurrence cannot disagree, and the mechanism differs by provenance.
 * Their identity agrees because both name the key of the settled decisions map —
 * `buildMigrationM1Intents` iterates that map, and the lazy source the cutover
 * unifies from yields the same keys out of it — not because there is one construction
 * site. For a `create` or a replacement, their value and their §11a.3 timestamps agree
 * because both read the occurrence out of the single map `buildProducedOccurrences`
 * returns. For a transported occurrence only the timestamps come out of that map: the
 * target graph state's value is read from the source replica's `values` sublevel
 * instead, while the `ValueEvent` carries the value `readTransportedOccurrence` read
 * from that same sublevel. Those two are the same read of the same key against the
 * same read-only source storage, which the cutover never writes, so they cannot
 * disagree either.
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
            if (decision.kind === "create" || decision.kind === "replace") {
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
