/**
 * Reading a persisted replica as the startup gate's pre-Journal source.
 *
 * The canonical-bootstrap decision needs a validated `LegacyBootstrapState`, and
 * `journal/bootstrap` builds that value from a weak observation rather than from
 * storage: it owns the rejection list, so a source which is not supported is rejected
 * by the same rule everywhere it is read. This module is only the reader which produces
 * that observation from a replica, and it reads through the replica's own persisted
 * metadata so it introduces no second notion of what a replica contains.
 *
 * The three facts it reports are the three the gate needs and no more:
 *
 * - `materializedNodes`, read through the replica's `identifiers_keys_map`, so a
 *   materialized node is a node the replica persists an identifier for;
 * - `retainsJournalRecords`, which is what separates a Journal replica from a
 *   pre-Journal one: a replica which already retains Journal records is not a
 *   pre-Journal source, and startup must not offer it to the bootstrap decision;
 * - `legacyState`, the validated source, absent exactly when the replica materializes
 *   nothing at all.
 */

/** @typedef {import('./journal/errors').AnyJournalError} JournalError */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./journal').LegacyBootstrapState} LegacyBootstrapState */

const {
    GRAPH_SCHEME_KEY,
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    nodeKeyStringToString,
    stringToNodeKeyString,
} = require("./database");
const { isJournalError, makeJournalPublicationError } = require("./journal");
const { readLegacyBootstrapState } = require("./journal");

/**
 * @typedef {object} ReadPreJournalResult
 * @property {number} materializedNodes - How many nodes the replica persists.
 * @property {boolean} retainsJournalRecords - Whether the replica already retains
 *   Journal records, which makes it a Journal replica rather than a pre-Journal one.
 * @property {LegacyBootstrapState | undefined} legacyState - The validated supported
 *   pre-Journal source, absent when the replica materializes no node.
 */

/**
 * Read the active replica's persisted state for the bootstrap gate.
 *
 * The gate needs three facts and nothing else: whether the replica retains Journal
 * records at all, whether it materializes anything, and — if it materializes something
 * while retaining no Journal record — the validated supported pre-Journal source those
 * materializations are. The source is read through the replica's own persisted
 * `identifiers_keys_map`, `last_node_index` and `global/graph_scheme`, so a replica
 * which is not a supported pre-Journal source is rejected by the subfolder's own
 * boundary check rather than by a second rule here.
 *
 * @param {SchemaStorage} storage - The active replica's storage.
 * @returns {Promise<ReadPreJournalResult | JournalError>}
 */
async function readPreJournalSourceState(storage) {
    const retainsJournalRecords = await journalRecordsRetained(storage);
    const graphSchemeString = await storage.global.get(GRAPH_SCHEME_KEY);
    const lastNodeIndex = await storage.global.get(LAST_NODE_INDEX_KEY);
    const serializedLookup = await storage.global.get(IDENTIFIERS_KEY);
    const entries = identifierEntriesOf(serializedLookup);
    if (entries === undefined) {
        return makeJournalPublicationError(
            "the replica persists an identifier lookup which is not a list of identifier/key pairs"
        );
    }
    if (entries.length === 0) {
        return { materializedNodes: 0, retainsJournalRecords, legacyState: undefined };
    }
    /** @type {Map<string, string>} */
    const keyByIdentifier = new Map();
    /** @type {Map<string, Set<string>>} */
    const inputIdentifiersByDependent = new Map();
    for (const [identifier, key] of entries) {
        keyByIdentifier.set(nodeIdentifierToString(identifier), nodeKeyStringToString(key));
    }
    for (const [identifier] of entries) {
        for (const dependent of (await storage.valid.get(identifier)) ?? []) {
            const dependentText = nodeIdentifierToString(dependent);
            const inputs = inputIdentifiersByDependent.get(dependentText);
            if (inputs === undefined) {
                inputIdentifiersByDependent.set(dependentText, new Set([nodeIdentifierToString(identifier)]));
                continue;
            }
            inputs.add(nodeIdentifierToString(identifier));
        }
    }
    const observedNodes = [];
    for (const [identifier] of entries) {
        const identifierText = nodeIdentifierToString(identifier);
        const payload = await storage.values.get(identifier);
        const timestamps = await storage.timestamps.get(identifier);
        const freshness = await storage.freshness.get(identifier);
        if (payload === undefined || timestamps === undefined || freshness === undefined) {
            return makeJournalPublicationError(
                "the pre-Journal source persists the identifier " +
                    identifierText +
                    " without a value, timestamps or a freshness flag, so it is not a supported source"
            );
        }
        observedNodes.push({
            nodeKeyString: keyByIdentifier.get(identifierText),
            nodeIdentifier: identifier,
            payload,
            createdAt: timestamps.createdAt,
            modifiedAt: timestamps.modifiedAt,
            upToDate: freshness === "up-to-date",
            validInputs: directInputKeysOf(identifierText, inputIdentifiersByDependent, keyByIdentifier),
        });
    }
    const legacyState = readLegacyBootstrapState({
        graphSchemeString,
        lastNodeIndex,
        nodes: observedNodes,
    });
    if (isJournalError(legacyState)) {
        return legacyState;
    }
    return {
        materializedNodes: entries.length,
        retainsJournalRecords,
        legacyState,
    };
}

/**
 * The direct legacy inputs of one persisted node.
 *
 * The replica stores validity as the inverse relation: `valid[D]` names the dependents
 * whose current values were validated against `D`'s current value, so the direct inputs
 * of a node are the entries which name it, not the entries it names. Reading the relation
 * the other way round turns every edge into its reverse, which stages certificates over
 * the wrong inputs and makes a faithful canonical cut look forked at resume.
 *
 * @param {string} dependentText - The node whose inputs are wanted.
 * @param {Map<string, Set<string>>} inputIdentifiersByDependent - The inverted relation.
 * @param {Map<string, string>} keyByIdentifier
 * @returns {Array<string>}
 */
function directInputKeysOf(dependentText, inputIdentifiersByDependent, keyByIdentifier) {
    const inputs = inputIdentifiersByDependent.get(dependentText);
    if (inputs === undefined) {
        return [];
    }
    /** @type {Array<string>} */
    const keys = [];
    for (const input of inputs) {
        const key = keyByIdentifier.get(input);
        if (key !== undefined) {
            keys.push(key);
        }
    }
    return keys;
}

/**
 * @param {unknown} serializedLookup
 * @returns {Array<[NodeIdentifier, NodeKeyString]> | undefined}
 */
function identifierEntriesOf(serializedLookup) {
    if (!Array.isArray(serializedLookup)) {
        return undefined;
    }
    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const entries = [];
    for (const entry of serializedLookup) {
        if (!Array.isArray(entry) || entry.length !== 2) {
            return undefined;
        }
        const identifier = nodeIdentifierFromString(entry[0]);
        const key = stringToNodeKeyString(entry[1]);
        if (identifier instanceof Error || key instanceof Error) {
            return undefined;
        }
        entries.push([identifier, key]);
    }
    return entries;
}

/**
 * @param {SchemaStorage} storage
 * @returns {Promise<boolean>}
 */
async function journalRecordsRetained(storage) {
    for await (const key of storage.journal.keys()) {
        void key;
        return true;
    }
    return false;
}

module.exports = {
    journalRecordsRetained,
    readPreJournalSourceState,
};
