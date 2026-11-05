/**
 * The lazy source of the target replica's desired migration state.
 *
 * The migration writes its target through `unifyStores`, which reads the desired
 * state one key at a time. Building that state eagerly would hold every migrated
 * value in memory at once, so this module computes each value on demand from the
 * source replica and the settled decisions: peak memory is one value plus the key
 * set, which is the same bound the synchronization path works to.
 *
 * The state the source yields is a projection of the Journal the same cutover
 * builds in the target, and the §11a.3 timestamps of every occurrence the migration
 * authors — produced at the cut or transported from the source replica's storage —
 * are passed in rather than re-derived here, so the graph state and the M1 records
 * name the same occurrence with the same timestamps.
 *
 * The freshness flags are `buildTargetFreshness`'s, also passed in: §11a.4 derives
 * a replacement's flag from the freshness of the inputs it selected, so the flag
 * cannot be read back from the source replica for a node the migration replaced.
 *
 * The target replica's `identifiers_keys_map` is the target lookup, which is the
 * source materialization under the target NodeKey representation, so the graph state
 * this source yields and the retained history the same cutover rewrites name one node
 * key for one materialized node. A transported payload is read out of the source
 * replica and rewritten through the same codec which rewrote the record which names
 * it, because `GconvertedBefore` carries the rewritten representation of the value
 * and not the source representation of it.
 */

const {
    compareNodeIdentifier,
    deserializeNodeKey,
    GRAPH_SCHEME_KEY,
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
    serializeIdentifierLookup,
} = require("./database");
const { makeInvalidMigrationDecisionError } = require("./migration_errors");

/** @typedef {import('./database').ReadableSchemaStorage} ReadableSchemaStorage */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').Freshness} Freshness */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/types').Version} Version */
/** @typedef {import('./migration_storage').Decision} Decision */
/** @typedef {import('./migration_storage').ReadableMigrationStorage} ReadableMigrationStorage */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./journal_rewrite').HistoryRewriter} HistoryRewriter */


/**
 * Create a lazy read-only source that yields the desired migration state.
 *
 * Values are computed from prevStorage on demand — no values are accumulated
 * in memory simultaneously.  Combined with makeDbToDbAdapter + unifyStores this
 * achieves O(|max value| + |keys|) peak memory for migration, matching sync.
 *
 * For 'keep' decisions the target sublevel value is read twice (once during
 * keys() to check existence, once during readSource()) — this is an I/O
 * trade-off that avoids per-value memory retention.
 *
 * @param {ReadableMigrationStorage} prevStorage
 * @param {IdentifierLookup} sourceLookup - The source replica's identifier lookup, which supplies
 *   the source NodeKey of every transported key.
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} desiredValid
 * @param {ReadonlyMap<NodeIdentifier, Freshness>} targetFreshness - The §11a.4
 *   freshness flag of every target-present node.
 * @param {import('./database/types').Version} newVersion
 * @param {number} maxAllocatedIndex - The max allocated local index during this migration.
 * @param {number} sourceLastNodeIndex - The validated durable last_node_index from the source replica.
 * @param {string} fingerprint - The database fingerprint to carry forward.
 * @param {string} graphSchemeString
 * @param {ReadonlyMap<NodeIdentifier, import('./migration_m1').TargetOccurrence>} producedOccurrences - The
 *   occurrences a `create` or a replacement produced and the occurrences an occurrence-preserving decision
 *   transported, already carrying their §11a.3 timestamps. The M1 records name the same occurrences, so the
 *   graph state and the journal describe one value.
 * @param {IdentifierLookup} targetLookup - The target replica's identifier lookup, in target NodeKey
 *   representation.
 * @param {HistoryRewriter} rewriter - The migration's one source->target rewrite.
 * @returns {ReadableSchemaStorage}
 */
function makeLazyMigrationSource(prevStorage, sourceLookup, decisions, desiredValid, targetFreshness, newVersion, maxAllocatedIndex, sourceLastNodeIndex, fingerprint, graphSchemeString, producedOccurrences, targetLookup, rewriter) {
    /**
     * @param {NodeIdentifier} key
     * @param {Decision} decision
     * @returns {Promise<ComputedValue | undefined>}
     */
    async function readFinalValue(key, decision) {
        if (decision.kind === "create" || decision.kind === "replace") {
            const occurrence = producedOccurrences.get(key);
            if (occurrence !== undefined) {
                return occurrence.value;
            }
            throw makeInvalidMigrationDecisionError(`Migration value producer for ${String(key)} did not return a computed value`);
        }
        const sourceValue = await prevStorage.values.get(key);
        if (sourceValue === undefined) {
            return undefined;
        }
        const sourceKeyString = sourceLookup.idToKey.get(String(key));
        if (sourceKeyString === undefined) {
            throw makeInvalidMigrationDecisionError(
                `Migration transports ${String(key)}, which the source replica does not materialize`
            );
        }
        const rewritten = rewriter.payload(
            deserializeNodeKey(sourceKeyString),
            sourceValue
        );
        if (rewritten instanceof Error) {
            throw makeInvalidMigrationDecisionError(
                `Migration transports ${String(key)}, whose value the source->target codec could not rewrite`
            );
        }
        return rewritten;
    }

    const sortedDecisionOutputKeys = [...decisions.keys()]
        .sort(compareNodeIdentifier);

    const sortedValidKeys = [...desiredValid.keys()].sort(compareNodeIdentifier);

    return {
        values: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decision = decisions.get(outputKey);
                    if (!decision || decision.kind === "delete") continue;
                    yield outputKey;
                }
            },
            async get(key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                return await readFinalValue(key, decision);
            },
        },
        freshness: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decision = decisions.get(outputKey);
                    if (!decision || decision.kind === "delete") continue;
                    yield outputKey;
                }
            },
            async get(key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                if (decision.kind === "create") return decision.freshness;
                if (decision.kind === "invalidate") return "potentially-outdated";
                const settled = targetFreshness.get(key);
                if (settled !== undefined) return settled;
                return await prevStorage.freshness.get(key);
            },
        },
        valid: {
            async *keys() {
                for (const key of sortedValidKeys) {
                    yield key;
                }
            },
            async get(key) {
                return desiredValid.get(key);
            },
        },
        timestamps: {
            async *keys() {
                for (const outputKey of sortedDecisionOutputKeys) {
                    const decision = decisions.get(outputKey);
                    if (!decision || decision.kind === "delete") continue;
                    yield outputKey;
                }
            },
            async get(key) {
                const decision = decisions.get(key);
                if (!decision || decision.kind === "delete") return undefined;
                // A genuine occurrence-producing decision takes the §11a.3 timestamps
                // the M1 record was built with, so the persisted graph state and the
                // journal name one occurrence rather than two disagreeing ones. A
                // `create` is a new materialization and takes the publication time for
                // both stamps; a replacement keeps the existing materialization and its
                // `createdAt` and takes the publication time as its `modifiedAt`.
                // An occurrence-preserving decision transports the source stamps.
                const produced = producedOccurrences.get(key);
                if (produced !== undefined) {
                    return { createdAt: produced.createdAt, modifiedAt: produced.modifiedAt };
                }
                return await prevStorage.timestamps.get(key);
            },
        },
        global: {
            async *keys() {
                yield 'version';
                yield IDENTIFIERS_KEY;
                yield LAST_NODE_INDEX_KEY;
                yield 'fingerprint';
                yield GRAPH_SCHEME_KEY;
            },
            async get(key) {
                if (key === 'version') {
                    return newVersion;
                }
                if (key === IDENTIFIERS_KEY) {
                    return serializeIdentifierLookup(targetLookup);
                }
                if (key === LAST_NODE_INDEX_KEY) {
                    return Math.max(sourceLastNodeIndex, maxAllocatedIndex);
                }
                if (key === 'fingerprint') {
                    return fingerprint;
                }
                if (key === GRAPH_SCHEME_KEY) {
                    return graphSchemeString;
                }
                return await prevStorage.global.get(key);
            },
        },
    };
}

module.exports = {
    makeLazyMigrationSource,
};
