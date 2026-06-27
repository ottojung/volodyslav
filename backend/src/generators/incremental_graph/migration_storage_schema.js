/**
 * Schema and identifier compatibility helpers for MigrationStorage.
 */

const {
    deserializeNodeKey,
    stringToNodeKeyString,
    IDENTIFIERS_KEY,
    nodeIdentifierToString,
    deriveInputPositions,
} = require("./database");
const { makeSchemaCompatibilityError } = require("./migration_errors");

/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./migration_storage').ReadableMigrationStorage} ReadableMigrationStorage */

/**
 * @typedef {{ kind: 'keep' }} KeepDecision
 * @typedef {{ kind: 'override', value: (nodeKey: NodeIdentifier) => Promise<ComputedValue> }} OverrideDecision
 * @typedef {{ kind: 'invalidate' }} InvalidateDecision
 * @typedef {{ kind: 'delete' }} DeleteDecision
 * @typedef {"up-to-date" | "potentially-outdated"} CreatedFreshness
 * @typedef {{ kind: 'create', nodeKeyString: string, value: (nodeKey: NodeIdentifier) => Promise<ComputedValue>, freshness: CreatedFreshness }} CreateDecision
 * @typedef {KeepDecision | OverrideDecision | InvalidateDecision | DeleteDecision | CreateDecision} Decision
 */

/**
 * Read the persisted identifiers_keys_map and return it as an index Map.
 * @param {ReadableMigrationStorage} prevStorage
 * @returns {Promise<Map<string, string>>}
 */
async function loadIdentifiersKeysIndex(prevStorage) {
    const index = new Map();
    const entries = prevStorage.global !== undefined
        ? await prevStorage.global.get(IDENTIFIERS_KEY)
        : undefined;
    if (Array.isArray(entries)) {
        for (const [id, nodeKeyJson] of entries) {
            index.set(String(id), String(nodeKeyJson));
        }
    }
    return index;
}

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
    loadIdentifiersKeysIndex,
    resolveNodeKeyFromIndex,
    checkSchemaCompatibility,
    assertKeepInputPositionsCompatible,
};
