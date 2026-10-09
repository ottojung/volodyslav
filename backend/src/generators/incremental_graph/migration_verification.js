/**
 * §22 step 5 of a Journal-aware migration: verify the target before the cutover.
 *
 * `incremental-graph-journal-migrations.md` §22 makes the cutover one atomic
 * selection, and lists verifying the target's replay, projection and invariants as
 * the step which precedes it. That step is what makes the preceding steps safe to
 * run blind: the target replica's graph state is a projection of the retained
 * history the migration just carried into it plus the M1 records it appended, and
 * nothing else in the procedure reads the target's Journal.
 *
 * The verification therefore reads the target's own retained Journal and replays
 * it, rather than trusting the values the unification wrote. A migration which
 * produced a graph state and a journal record that disagree about one occurrence
 * is indistinguishable from a correct one until something replays the record and
 * compares, and the target is the only place both representations coexist.
 *
 * **Scope of the comparison.** The target's graph state is a projection of the
 * retained history, so every fact the graph persists must equal the replayed one:
 * which semantic nodes are present, which occurrence each one names, that
 * occurrence's payload, its `NodeIdentifier`, its `createdAt`/`modifiedAt`
 * (§§11a.3, 15, 19), and the freshness and validity edges M2 (§16) and M3 (§17)
 * encode. Those are the facts this module compares, and they are compared exactly.
 *
 * Comparing freshness and validity here is what makes M2 and M3 load-bearing: a
 * cutover which authored the target occurrences but not the proof and persistent
 * staleness which explain them replays to a different freshness or edge set, and is
 * refused rather than selected.
 */

const {
    journalRecordIdToString,
    makeJournalProjectionError,
    makeJournalSourceReadError,
    validateJournalReplica,
    makeReplicaSource,
    projectRetainedJournal,
} = require("./journal");

const { readRetainedJournal } = require("./journal_store");
const { deriveInputPositions, nodeIdentifierToString, nodeKeyStringToString, stringToNodeKeyString } = require("./database");

/** @typedef {import('./journal/errors').AnyJournalError} JournalError */
/** @typedef {import('./journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/graph_scheme').GraphScheme} GraphScheme */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */

/**
 * The current schema's direct input keys of one semantic node.
 *
 * A node the current schema does not contain has no current direct inputs, which is
 * what a historical node family absent from the target schema projects as.
 *
 * @param {GraphScheme} graphScheme
 * @returns {(nodeKeyString: string) => ReadonlyArray<string>}
 */
function makeCurrentInputKeysOfNode(graphScheme) {
    return (nodeKeyString) => {
        let key;
        try {
            key = stringToNodeKeyString(nodeKeyString);
        } catch {
            return [];
        }
        try {
            return deriveInputPositions(graphScheme, key).map(nodeKeyStringToString);
        } catch {
            return [];
        }
    };
}

/**
 * The occurrence facts of one semantic node, as the target graph persists them.
 *
 * @typedef {object} PersistedOccurrence
 * @property {import('./database/types').ComputedValue} payload
 * @property {import('./database/types').NodeIdentifier} nodeIdentifier
 * @property {string} createdAt
 * @property {string} modifiedAt
 * @property {boolean} fresh
 * @property {Set<string>} validInputs
 */

/**
 * Read every occurrence the target graph persists, keyed by canonical node key.
 *
 * The target's identifier lookup is the materialization set: a materialization the
 * graph cannot state an occurrence for is a target which is not a projection of any
 * Journal, and is reported rather than skipped.
 *
 * @param {SchemaStorage} targetStorage
 * @param {IdentifierLookup} targetLookup
 * @param {GraphScheme} graphScheme
 * @returns {Promise<Map<string, PersistedOccurrence>>}
 */
async function readTargetOccurrences(targetStorage, targetLookup, graphScheme) {
    /** @type {Map<string, PersistedOccurrence>} */
    const occurrences = new Map();
    for (const [nodeIdentifier, nodeKeyString] of targetLookup.serialized) {
        const [timestamps, value, freshness] = await Promise.all([
            targetStorage.timestamps.get(nodeIdentifier),
            targetStorage.values.get(nodeIdentifier),
            targetStorage.freshness.get(nodeIdentifier),
        ]);
        if (timestamps === undefined || value === undefined) {
            throw makeJournalProjectionError(
                "the migration target replica materializes a node with no value occurrence",
                nodeKeyStringToString(nodeKeyString)
            );
        }
        /** @type {Set<string>} */
        const validInputs = new Set();
        for (const inputKey of deriveInputPositions(graphScheme, nodeKeyString)) {
            const inputIdentifier = targetLookup.keyToId.get(nodeKeyStringToString(inputKey));
            if (inputIdentifier === undefined) {
                continue;
            }
            const dependents = await targetStorage.valid.get(inputIdentifier) ?? [];
            if (dependents.some(
                (id) => nodeIdentifierToString(id) === nodeIdentifierToString(nodeIdentifier)
            )) {
                validInputs.add(nodeKeyStringToString(inputKey));
            }
        }
        occurrences.set(nodeKeyStringToString(nodeKeyString), {
            payload: value,
            nodeIdentifier,
            createdAt: timestamps.createdAt,
            modifiedAt: timestamps.modifiedAt,
            fresh: freshness === "up-to-date",
            validInputs,
        });
    }
    return occurrences;
}

/**
 * Verify the target replica's retained Journal against the target replica's graph.
 *
 * §22 step 5. The target's retained history must be well formed, must replay, and
 * the occurrences that replay selects must be the occurrences the target graph
 * persists. The cutover selects the target only when all three hold.
 *
 * @param {SchemaStorage} targetStorage - The inactive target replica being verified.
 * @param {IdentifierLookup} targetLookup - The target replica's identifier lookup.
 * @param {GraphScheme} graphScheme - The target schema, which is the current schema the replay lowers into.
 * @param {JournalAuthor} localWriter - The local writer whose allocator projection the replay reconstructs.
 * @param {string} replicaName - The target replica's name, for the failure message.
 * @returns {Promise<void>}
 */
async function verifyTargetReplica(targetStorage, targetLookup, graphScheme, localWriter, replicaName) {
    const retained = await readRetainedJournal(targetStorage.journal);
    if (retained instanceof Error) {
        throw makeJournalSourceReadError(
            "the migration target replica (" + replicaName + ") retained history could not be read: " + retained.message
        );
    }

    const malformed = validateJournalReplica(retained);
    if (malformed !== undefined) {
        throw makeJournalProjectionError(
            "the migration target replica (" + replicaName + ") retained history is not well formed: " + malformed.message,
            "unknown"
        );
    }

    const projection = projectRetainedJournal({
        source: makeReplicaSource(retained),
        localWriter,
        currentInputKeysOfNode: makeCurrentInputKeysOfNode(graphScheme),
    });
    if (projection instanceof Error) {
        throw makeJournalProjectionError(
            "the migration target replica (" + replicaName + ") retained history does not replay: " + projection.message,
            "unknown"
        );
    }

    const persisted = await readTargetOccurrences(targetStorage, targetLookup, graphScheme);
    for (const replayed of projection.occurrences) {
        const graph = persisted.get(replayed.nodeKeyString);
        if (graph === undefined) {
            throw makeJournalProjectionError(
                "the migration target replica replays an occurrence for a node its graph does not materialize",
                replayed.nodeKeyString
            );
        }
        const disagreement = describeDisagreement(replayed, graph);
        if (disagreement !== undefined) {
            throw makeJournalProjectionError(
                "the migration target replica (" + replicaName + ") journal and graph disagree: " + disagreement,
                replayed.nodeKeyString
            );
        }
    }
    for (const nodeKeyString of persisted.keys()) {
        if (projection.occurrences.every((replayed) => replayed.nodeKeyString !== nodeKeyString)) {
            throw makeJournalProjectionError(
                "the migration target replica materializes a node its retained history selects no occurrence for",
                nodeKeyString
            );
        }
    }
}

/**
 * Name the first occurrence fact on which the replayed Journal and the persisted
 * graph disagree, or `undefined` when they agree.
 *
 * @param {import('./journal/oracle/projection').ProjectedOccurrence} replayed
 * @param {PersistedOccurrence} graph
 * @returns {string | undefined}
 */
function describeDisagreement(replayed, graph) {
    if (nodeIdentifierToString(replayed.nodeIdentifier) !== nodeIdentifierToString(graph.nodeIdentifier)) {
        return "occurrence " + journalRecordIdToString(replayed.valueId) + " names materialization " +
            nodeIdentifierToString(replayed.nodeIdentifier) + " while the graph materializes " +
            nodeIdentifierToString(graph.nodeIdentifier);
    }
    if (replayed.createdAt !== graph.createdAt) {
        return "the replayed occurrence records createdAt " + replayed.createdAt +
            " while the graph records " + graph.createdAt;
    }
    if (replayed.modifiedAt !== graph.modifiedAt) {
        return "the replayed occurrence records modifiedAt " + replayed.modifiedAt +
            " while the graph records " + graph.modifiedAt;
    }
    if (JSON.stringify(replayed.payload) !== JSON.stringify(graph.payload)) {
        return "the replayed occurrence carries a payload the graph does not persist";
    }
    if (replayed.fresh !== graph.fresh) {
        return "the replayed occurrence is " + (replayed.fresh ? "fresh" : "stale") +
            " while the graph persists it " + (graph.fresh ? "fresh" : "stale");
    }
    if (replayed.validInputs.size !== graph.validInputs.size) {
        return "the replayed occurrence proves " + replayed.validInputs.size +
            " input edge(s) while the graph persists " + graph.validInputs.size;
    }
    for (const inputKeyString of replayed.validInputs) {
        if (!graph.validInputs.has(inputKeyString)) {
            return "the replayed occurrence proves input edge " + inputKeyString +
                " which the graph does not persist";
        }
    }
    return undefined;
}

module.exports = {
    verifyTargetReplica,
};
