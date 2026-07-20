/**
 * Schema and identifier compatibility helpers for MigrationStorage.
 */

const {
    deserializeNodeKey,
    stringToNodeKeyString,
    nodeIdentifierToString,
    deriveInputPositions,
} = require("./database");
const { makeSchemaCompatibilityError } = require("./migration_errors");

/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').NodeName} NodeName */

/** @typedef {import('./migration_decisions').KeepDecision} KeepDecision */
/** @typedef {import('./migration_decisions').OverrideDecision} OverrideDecision */
/** @typedef {import('./migration_decisions').InvalidateDecision} InvalidateDecision */
/** @typedef {import('./migration_decisions').DeleteDecision} DeleteDecision */
/** @typedef {import('./migration_decisions').CreatedFreshness} CreatedFreshness */
/** @typedef {import('./migration_decisions').CreateDecision} CreateDecision */
/** @typedef {import('./migration_decisions').Decision} Decision */

/**
 * Resolve a node key to its parsed form using an indexed
 * `identifiers_keys_map` record or a create decision.
 *
 * Decisions take priority so that created nodes can also be resolved before
 * finalize().
 * @param {NodeIdentifier} nodeKey
 * @param {Map<string, string>} identifiersKeysIndex - idString -> nodeKeyString
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
 * Checks whether a node is compatible with the new schema.
 * Requires the node to be resolvable through the identifiers keys map or
 * through a create decision's stored nodeKeyString.
 * @param {NodeIdentifier} nodeKey
 * @param {Map<NodeName, CompiledNode>} newHeadIndex
 * @param {Map<string, string>} identifiersKeysIndex - idString -> nodeKeyString
 * @param {Map<NodeIdentifier, Decision>} [decisions]
 * @returns {Promise<void>}
 */
async function checkSchemaCompatibility(nodeKey, newHeadIndex, identifiersKeysIndex, decisions) {
    const parsed = resolveNodeKeyFromIndex(nodeKey, identifiersKeysIndex, decisions);
    if (parsed === undefined) throw makeSchemaCompatibilityError(nodeKey, "cannot resolve node key via identifiers_keys_map (missing entry) or create decisions");

    const head = parsed.head;
    const arity = parsed.args.length;
    const compiled = newHeadIndex.get(head);
    if (!compiled) throw makeSchemaCompatibilityError(nodeKey, `head '${head}' does not exist in the new schema`);
    if (compiled.arity !== arity) throw makeSchemaCompatibilityError(nodeKey, `arity mismatch: node has ${arity} argument(s) but new schema expects ${compiled.arity}`);
}

/**
 * Verify that the input positions for a node are unchanged between the old and new graph schemes.
 * @param {NodeIdentifier} nodeKey
 * @param {Map<string, string>} identifiersKeysIndex - idString -> nodeKeyString
 * @param {import('./database/graph_scheme').GraphScheme} oldGraphScheme
 * @param {import('./database/graph_scheme').GraphScheme} newGraphScheme
 * @returns {Promise<void>}
 */
async function assertKeepInputPositionsCompatible(nodeKey, identifiersKeysIndex, oldGraphScheme, newGraphScheme) {
    const nodeKeyString = identifiersKeysIndex.get(nodeIdentifierToString(nodeKey));
    if (nodeKeyString === undefined) {
        throw makeSchemaCompatibilityError(nodeKey, "cannot resolve node key via identifiers_keys_map");
    }
    const oldPositions = deriveInputPositions(oldGraphScheme, stringToNodeKeyString(nodeKeyString));
    const newPositions = deriveInputPositions(newGraphScheme, stringToNodeKeyString(nodeKeyString));
    if (oldPositions.length !== newPositions.length || oldPositions.some((value, index) => String(value) !== String(newPositions[index]))) {
        throw makeSchemaCompatibilityError(nodeKey, "input positions changed in the new schema");
    }
}

module.exports = {
    resolveNodeKeyFromIndex,
    checkSchemaCompatibility,
    assertKeepInputPositionsCompatible,
};
