/**
 * Schema and identifier compatibility helpers for MigrationStorage.
 */

const {
    deserializeNodeKey,
    stringToNodeKeyString,
    nodeIdentifierToString,
    nodeKeyStringToString,
    deriveInputPositions,
} = require("./database");
const { makeSchemaCompatibilityError } = require("./migration_errors");

/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').NodeName} NodeName */

/** @typedef {import('./migration_decisions').KeepDecision} KeepDecision */
/** @typedef {import('./migration_decisions').ReplaceDecision} ReplaceDecision */
/** @typedef {import('./migration_decisions').InvalidateDecision} InvalidateDecision */
/** @typedef {import('./migration_decisions').DeleteDecision} DeleteDecision */
/** @typedef {import('./migration_decisions').CreatedFreshness} CreatedFreshness */
/** @typedef {import('./migration_decisions').CreateDecision} CreateDecision */
/** @typedef {import('./migration_decisions').Decision} Decision */

/**
 * Resolve a node key to its parsed form using an indexed
 * `identifiers_keys_map` record or a create decision.
 *
 * The index is the target key space: `incremental-graph-journal-migrations.md` §11
 * addresses the callback by `NodeIdentifier` but reasons about `Kt =
 * rewriteNodeKey(Ks)`, so a resolved key is the transported target key of the
 * materialization, not the source spelling the source replica persisted.
 *
 * Decisions take priority so that created nodes can also be resolved before
 * finalize().
 * @param {NodeIdentifier} nodeKey
 * @param {Map<string, string>} identifiersKeysIndex - idString -> targetNodeKeyString
 * @param {Map<NodeIdentifier, Decision>} [decisions]
 * @returns {import('./database/node_key').NodeKey | undefined}
 */
function resolveNodeKeyFromIndex(nodeKey, identifiersKeysIndex, decisions) {
    const nodeKeyStr = String(nodeKey);

    const decision = decisions?.get(nodeKey);
    if (decision?.kind === "create" && decision.nodeKeyString !== undefined) {
        return deserializeNodeKey(stringToNodeKeyString(decision.nodeKeyString));
    }

    const nodeKeyString = identifiersKeysIndex.get(nodeKeyStr);
    if (nodeKeyString === undefined) return undefined;
    return deserializeNodeKey(stringToNodeKeyString(nodeKeyString));
}

/**
 * Resolve a node key to its parsed form using the source replica's indexed
 * `identifiers_keys_map` record or a create decision.
 *
 * `incremental-graph-journal-migrations.md` §11 keeps `get` and the traversal
 * helpers addressing the previous replica, so they expose source-representation
 * data: this is the source spelling of the key, not the transported one.
 *
 * @param {NodeIdentifier} nodeKey
 * @param {Map<string, string>} sourceIndex - idString -> sourceNodeKeyString
 * @param {Map<NodeIdentifier, Decision>} [decisions]
 * @returns {import('./database/node_key').NodeKey | undefined}
 */
function resolveSourceNodeKeyFromIndex(nodeKey, sourceIndex, decisions) {
    const sourceKeyString = sourceIndex.get(String(nodeKey));
    if (sourceKeyString !== undefined) {
        return deserializeNodeKey(stringToNodeKeyString(sourceKeyString));
    }
    const decision = decisions?.get(nodeKey);
    if (decision?.kind === "create" && decision.nodeKeyString !== undefined) {
        return deserializeNodeKey(stringToNodeKeyString(decision.nodeKeyString));
    }
    return undefined;
}

/**
 * Checks whether a node is compatible with the new schema.
 *
 * The check is made against the transported target key, because §11 requires an
 * existing-node decision to hold for `Kt = rewriteNodeKey(Ks)`: a representation
 * rename whose target key is valid in the target schema is compatible even when the
 * source spelling was never a node of it.
 *
 * @param {NodeIdentifier} nodeKey
 * @param {Map<NodeName, CompiledNode>} newHeadIndex
 * @param {Map<string, string>} identifiersKeysIndex - idString -> targetNodeKeyString
 * @param {Map<NodeIdentifier, Decision>} [decisions]
 * @returns {Promise<void>}
 */
async function checkSchemaCompatibility(nodeKey, newHeadIndex, identifiersKeysIndex, decisions) {
    const parsed = resolveNodeKeyFromIndex(nodeKey, identifiersKeysIndex, decisions);
    if (parsed === undefined) throw makeSchemaCompatibilityError(nodeKey, "cannot resolve the target node key via identifiers_keys_map (missing entry) or create decisions");

    const head = parsed.head;
    const arity = parsed.args.length;
    const compiled = newHeadIndex.get(head);
    if (!compiled) throw makeSchemaCompatibilityError(nodeKey, `head '${head}' does not exist in the new schema`);
    if (compiled.arity !== arity) throw makeSchemaCompatibilityError(nodeKey, `arity mismatch: node has ${arity} argument(s) but new schema expects ${compiled.arity}`);
}

/**
 * Verify that the input positions for a node are unchanged between the old and new graph schemes.
 *
 * Both sides are compared in the target NodeKey representation: the source positions
 * are transported through the same codec which transported the node's own key, so a
 * representation-only rename of an input is not reported as a changed position.
 *
 * @param {NodeIdentifier} nodeKey
 * @param {Map<string, string>} identifiersKeysIndex - idString -> targetNodeKeyString
 * @param {Map<string, string>} sourceIndex - idString -> sourceNodeKeyString
 * @param {import('./database/graph_scheme').GraphScheme} oldGraphScheme
 * @param {import('./database/graph_scheme').GraphScheme} newGraphScheme
 * @param {(sourceNodeKeyString: import('./database/types').NodeKeyString) => import('./database/types').NodeKeyString | import('./migration_codec').CodecRejection} transport
 * @returns {Promise<void>}
 */
async function assertKeepInputPositionsCompatible(nodeKey, identifiersKeysIndex, sourceIndex, oldGraphScheme, newGraphScheme, transport) {
    const identifierString = nodeIdentifierToString(nodeKey);
    const targetKeyString = identifiersKeysIndex.get(identifierString);
    const sourceKeyString = sourceIndex.get(identifierString);
    if (targetKeyString === undefined || sourceKeyString === undefined) {
        throw makeSchemaCompatibilityError(nodeKey, "cannot resolve node key via identifiers_keys_map");
    }
    const oldPositionKeys = deriveInputPositions(oldGraphScheme, stringToNodeKeyString(sourceKeyString));
    /** @type {Array<import('./database/types').NodeKeyString>} */
    const transportedPositions = [];
    for (const position of oldPositionKeys) {
        const transported = transport(position);
        if (transported instanceof Error) {
            throw makeSchemaCompatibilityError(
                nodeKey,
                "the source->target codec could not transport an input position of this node"
            );
        }
        transportedPositions.push(transported);
    }
    const oldPositions = transportedPositions.map((position) => nodeKeyStringToString(position));
    const newPositions = deriveInputPositions(newGraphScheme, stringToNodeKeyString(targetKeyString))
        .map((position) => nodeKeyStringToString(position));
    if (oldPositions.length !== newPositions.length || oldPositions.some((value, index) => value !== newPositions[index])) {
        throw makeSchemaCompatibilityError(nodeKey, "input positions changed in the new schema");
    }
}

module.exports = {
    resolveNodeKeyFromIndex,
    resolveSourceNodeKeyFromIndex,
    checkSchemaCompatibility,
    assertKeepInputPositionsCompatible,
};
