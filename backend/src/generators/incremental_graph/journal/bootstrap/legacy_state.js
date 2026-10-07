/**
 * The validated persisted pre-Journal state a bootstrap transition reads.
 *
 * `incremental-graph-journal-migrations.md` §1 makes the supported pre-Journal
 * source a boundary question rather than a data-repair question: bootstrap records
 * the already-persisted supported legacy graph, and a source which is not
 * supported fails before any history is authored. This module is that boundary.
 *
 * A persisted replica is read as the weak shape storage actually holds, and this
 * module converts it once into a nominal `LegacyBootstrapState` whose every
 * property has been checked. Everything below it works with that validated value,
 * so no later pass re-derives whether the source is supported.
 *
 * The identifier check is the fail-closed consequence of
 * `incremental-graph-journal-types.md` §Persisted identifier form across the
 * bootstrap and migration boundary: an identifier the record layer will refuse
 * makes the whole source unsupported, and it is rejected here, before Pass C1, as
 * `JournalVersionCompatibilityError`. It is never repaired by re-minting,
 * re-spelling or normalizing, because re-minting an identifier changes the
 * identity of a materialized node, which §1 defines bootstrap as not doing.
 *
 * This module is pure. It performs no I/O and consults no clock: everything it
 * reports about the source is what the source persisted.
 */

const {
    compareNodeKeyStringByNodeKey,
    deserializeNodeKey,
    nodeIdentifierToString,
    nodeKeyStringToString,
    stringToNodeKeyString,
} = require("../../database");
const { makeJournalVersionCompatibilityError } = require("../errors");
const { isNodeKey, nodeKeyToCanonicalString } = require("../basis");
const {
    isCanonicalTimestamp,
    isComputedValue,
    isNodeIdentifier,
    isPlainRecord,
    ownedComputedValue,
} = require("../record_fields");

/** @typedef {import('../errors').AnyJournalError} JournalError */
/** @typedef {import('../types').NodeKey} NodeKey */
/** @typedef {import('../../database/types').ComputedValue} ComputedValue */
/** @typedef {import('../../database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('../../database/types').NodeKeyString} NodeKeyString */

const STATE_MEMBERS = ["graphSchemeString", "lastNodeIndex", "nodes"];
const NODE_MEMBERS = [
    "nodeKeyString",
    "nodeIdentifier",
    "payload",
    "createdAt",
    "modifiedAt",
    "upToDate",
    "validInputs",
];

/**
 * This replica is not a supported pre-Journal bootstrap source.
 * @param {string} detail
 * @returns {JournalError}
 */
function unsupportedSource(detail) {
    return makeJournalVersionCompatibilityError(
        detail,
        "a supported pre-Journal source",
        "a replica outside the supported pre-Journal source boundary"
    );
}

/**
 * One materialized legacy node as the source replica persists it.
 *
 * The properties that this class carries are:
 * - `nodeKeyString` is the canonical persisted semantic identity of the node, and
 *   `node` is the key it parses back to;
 * - `nodeIdentifier` is the identifier text the source replica already persists
 *   for this node, transported unchanged;
 * - `payload`, `createdAt` and `modifiedAt` are the persisted occurrence fields;
 * - `upToDate` is the persisted freshness of that occurrence;
 * - `directInputKeys` are the keys of the direct legacy inputs `D` for which
 *   legacy validity contains the edge `D -> K`, in canonical persisted order.
 *
 * The proof of those properties is guaranteed by:
 * - `readLegacyBootstrapState(observed)`: rejects a node which is not a plain
 *   record with exactly `NODE_MEMBERS`, a `nodeKeyString` which is not the exact
 *   canonical serialization of the key it parses to, an identifier outside the
 *   domain the record layer accepts, a non-canonical timestamp, a payload the
 *   record layer would refuse, a non-boolean freshness flag, and a `validInputs`
 *   member which is not a canonical node key text or names one input twice.
 *
 * @param {NodeKeyString} nodeKeyString
 * @param {NodeIdentifier} nodeIdentifier
 * @param {ComputedValue} payload
 * @param {string} createdAt
 * @param {string} modifiedAt
 * @param {boolean} upToDate
 * @param {ReadonlyArray<NodeKey>} directInputKeys
 */
class LegacyNodeClass {
    /**
     * @param {NodeKeyString} nodeKeyString
     * @param {NodeIdentifier} nodeIdentifier
     * @param {ComputedValue} payload
     * @param {string} createdAt
     * @param {string} modifiedAt
     * @param {boolean} upToDate
     * @param {ReadonlyArray<NodeKey>} directInputKeys
     */
    constructor(
        nodeKeyString,
        nodeIdentifier,
        payload,
        createdAt,
        modifiedAt,
        upToDate,
        directInputKeys
    ) {
        this.nodeKeyString = nodeKeyString;
        this.node = deserializeNodeKey(nodeKeyString);
        this.nodeIdentifier = nodeIdentifier;
        this.payload = payload;
        this.createdAt = createdAt;
        this.modifiedAt = modifiedAt;
        this.upToDate = upToDate;
        this.directInputKeys = Object.freeze(directInputKeys.slice());
        Object.freeze(this);
    }
}

/** @typedef {LegacyNodeClass} LegacyNode */

/**
 * @param {unknown} value
 * @returns {value is LegacyNode}
 */
function isLegacyNode(value) {
    return value instanceof LegacyNodeClass;
}

/**
 * The supported pre-Journal persisted state, validated once.
 *
 * The properties that this class carries are:
 * - `nodes` is every materialized legacy node in ascending canonical persisted
 *   NodeKey order, so Pass C2 and Pass C3 have a deterministic order which is a
 *   function of the persisted state alone;
 * - `nodesByKey` resolves a canonical node key text to that node, and no two
 *   nodes share one physical identifier, so `identifiers_keys_map`-shaped state
 *   with a collision is rejected rather than journalled;
 * - `lastNodeIndex` is the source replica's durable allocation watermark;
 * - `graphSchemeString` is the persisted graph interpretation the source ran
 *   under.
 *
 * The proof of those properties is guaranteed by:
 * - `readLegacyBootstrapState(observed)`: reads exactly `STATE_MEMBERS`, validates
 *   each node through the rejection list documented on `LegacyNodeClass`, rejects a
 *   repeated canonical node key and two nodes sharing one identifier, sorts the
 *   surviving nodes canonically, and stores them into a frozen
 *   `LegacyBootstrapStateClass`.
 *
 * @param {ReadonlyArray<LegacyNode>} nodes
 * @param {number} lastNodeIndex
 * @param {string} graphSchemeString
 */
class LegacyBootstrapStateClass {
    /**
     * @param {ReadonlyArray<LegacyNode>} nodes
     * @param {number} lastNodeIndex
     * @param {string} graphSchemeString
     */
    constructor(nodes, lastNodeIndex, graphSchemeString) {
        this.nodes = nodes;
        this.lastNodeIndex = lastNodeIndex;
        this.graphSchemeString = graphSchemeString;
        /** @type {Map<string, LegacyNode>} */
        this.nodesByKey = new Map(nodes.map((node) => [nodeKeyStringToString(node.nodeKeyString), node]));
        Object.freeze(this);
    }

    /**
     * The materialized legacy node at this canonical identity, if the source
     * persists one.
     * @param {string} nodeKeyString
     * @returns {LegacyNode | undefined}
     */
    nodeAt(nodeKeyString) {
        return this.nodesByKey.get(nodeKeyString);
    }
}

/** @typedef {LegacyBootstrapStateClass} LegacyBootstrapState */

/**
 * @param {unknown} value
 * @returns {value is LegacyBootstrapState}
 */
function isLegacyBootstrapState(value) {
    return value instanceof LegacyBootstrapStateClass;
}

/**
 * @param {string} nodeKeyString
 * @returns {NodeKey | JournalError}
 */
function readNodeKey(nodeKeyString) {
    /** @type {unknown} */
    let parsed;
    try {
        parsed = deserializeNodeKey(stringToNodeKeyString(nodeKeyString));
    } catch (error) {
        return unsupportedSource(
            "the pre-Journal source persists the node key " +
                JSON.stringify(nodeKeyString) +
                ", which is not a canonical semantic node key text"
        );
    }
    if (!isNodeKey(parsed) || nodeKeyToCanonicalString(parsed) !== nodeKeyString) {
        return unsupportedSource(
            "the pre-Journal source persists the node key " +
                JSON.stringify(nodeKeyString) +
                ", which is not in canonical persisted form"
        );
    }
    return parsed;
}

/**
 * @param {Record<string, unknown>} observed
 * @param {string} label
 * @returns {LegacyNode | JournalError}
 */
function readLegacyNode(observed, label) {
    if (!isPlainRecord(observed)) {
        return unsupportedSource("the pre-Journal source persists " + label + " as something which is not a node");
    }
    for (const key of Object.keys(observed)) {
        if (!NODE_MEMBERS.includes(key)) {
            return unsupportedSource(
                "the pre-Journal source persists the unknown field " +
                    JSON.stringify(key) +
                    " on " +
                    label
            );
        }
    }
    const nodeKeyString = observed["nodeKeyString"];
    if (typeof nodeKeyString !== "string") {
        return unsupportedSource(label + " does not persist a canonical node key");
    }
    const nodeKey = readNodeKey(nodeKeyString);
    if (nodeKey instanceof Error) {
        return nodeKey;
    }
    const nodeIdentifier = observed["nodeIdentifier"];
    if (!isNodeIdentifier(nodeIdentifier)) {
        return unsupportedSource(
            "the pre-Journal source persists the identifier " +
                JSON.stringify(nodeIdentifier) +
                " for " +
                label +
                ", which is outside the supported NodeIdentifier domain, so this replica is not a " +
                "supported bootstrap source; the identifier is not re-minted or normalized, because " +
                "that would change which physical identity a materialized node has"
        );
    }
    const payload = observed["payload"];
    if (!isComputedValue(payload)) {
        return unsupportedSource(label + " does not persist a readable payload");
    }
    const createdAt = observed["createdAt"];
    const modifiedAt = observed["modifiedAt"];
    if (!isCanonicalTimestamp(createdAt) || !isCanonicalTimestamp(modifiedAt)) {
        return unsupportedSource(label + " does not persist canonical whole-millisecond timestamps");
    }
    const upToDate = observed["upToDate"];
    if (typeof upToDate !== "boolean") {
        return unsupportedSource(label + " does not persist a freshness flag");
    }
    const validInputs = observed["validInputs"];
    if (!Array.isArray(validInputs)) {
        return unsupportedSource(label + " does not persist its direct legacy inputs");
    }
    /** @type {NodeKey[]} */
    const directInputKeys = [];
    for (const input of validInputs) {
        if (typeof input !== "string") {
            return unsupportedSource(label + " persists a direct legacy input which is not a node key text");
        }
        const inputKey = readNodeKey(input);
        if (inputKey instanceof Error) {
            return inputKey;
        }
        if (!directInputKeys.some((seen) => nodeKeyToCanonicalString(seen) === input)) {
            directInputKeys.push(inputKey);
        }
    }
    directInputKeys.sort((left, right) =>
        compareNodeKeyStringByNodeKey(
            stringToNodeKeyString(nodeKeyToCanonicalString(left)),
            stringToNodeKeyString(nodeKeyToCanonicalString(right))
        )
    );
    return new LegacyNodeClass(
        stringToNodeKeyString(nodeKeyString),
        nodeIdentifier,
        ownedComputedValue(payload),
        createdAt,
        modifiedAt,
        upToDate,
        directInputKeys
    );
}

/**
 * Read and validate a persisted pre-Journal replica as a supported bootstrap
 * source.
 *
 * Every rejection here is fail-closed and happens before any bootstrap history
 * exists, because an unjournallable source must not reach Pass C1.
 *
 * @param {unknown} observed - The weak shape persisted storage holds.
 * @returns {LegacyBootstrapState | JournalError}
 */
function readLegacyBootstrapState(observed) {
    if (!isPlainRecord(observed)) {
        return unsupportedSource("the pre-Journal source state is not an object");
    }
    for (const key of Object.keys(observed)) {
        if (!STATE_MEMBERS.includes(key)) {
            return unsupportedSource(
                "the pre-Journal source state carries the unknown field " + JSON.stringify(key)
            );
        }
    }
    const graphSchemeString = observed["graphSchemeString"];
    if (typeof graphSchemeString !== "string" || graphSchemeString.length === 0) {
        return unsupportedSource("the pre-Journal source does not persist its graph scheme string");
    }
    const lastNodeIndex = observed["lastNodeIndex"];
    if (typeof lastNodeIndex !== "number" || !Number.isSafeInteger(lastNodeIndex) || lastNodeIndex < 0) {
        return unsupportedSource(
            "the pre-Journal source does not persist a usable last_node_index, got " +
                JSON.stringify(lastNodeIndex)
        );
    }
    const observedNodes = observed["nodes"];
    if (!Array.isArray(observedNodes)) {
        return unsupportedSource("the pre-Journal source does not persist its node set");
    }
    /** @type {LegacyNode[]} */
    const nodes = [];
    /** @type {Set<string>} */
    const seenKeys = new Set();
    /** @type {Map<string, string>} */
    const byIdentifier = new Map();
    for (const observedNode of observedNodes) {
        const node = readLegacyNode(observedNode, "a pre-Journal node");
        if (node instanceof Error) {
            return node;
        }
        const key = nodeKeyStringToString(node.nodeKeyString);
        if (seenKeys.has(key)) {
            return unsupportedSource("the pre-Journal source materializes the node " + key + " more than once");
        }
        const identifierText = nodeIdentifierToString(node.nodeIdentifier);
        const incumbent = byIdentifier.get(identifierText);
        if (incumbent !== undefined) {
            return unsupportedSource(
                "the pre-Journal source materializes the nodes " +
                    incumbent +
                    " and " +
                    key +
                    " with one physical identifier, which the allocation contract does not permit"
            );
        }
        seenKeys.add(key);
        byIdentifier.set(identifierText, key);
        nodes.push(node);
    }
    nodes.sort((left, right) => compareNodeKeyStringByNodeKey(left.nodeKeyString, right.nodeKeyString));
    return new LegacyBootstrapStateClass(nodes, lastNodeIndex, graphSchemeString);
}

module.exports = {
    isLegacyBootstrapState,
    isLegacyNode,
    readLegacyBootstrapState,
};