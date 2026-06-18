// @ts-nocheck
const { serializeNodeKey, deserializeNodeKey } = require("./node_key");
const { stringToNodeName, nodeKeyStringToString } = require("./types");
const { nodeIdentifierToString } = require("./node_identifier");
const { normalizeInputEdges } = require("./input_edges");

/** @typedef {import("../types").NodeDef} NodeDef */
/** @typedef {import("../types").ConstValue} ConstValue */
/** @typedef {import("./types").NodeIdentifier} NodeIdentifier */
/** @typedef {import("./types").NodeKeyString} NodeKeyString */
/** @typedef {import("./identifier_lookup").IdentifierLookup} IdentifierLookup */
/** @typedef {import("./identifier_lookup").TransactionIdentifierLookup} TransactionIdentifierLookup */
/** @typedef {{kind: "arg", index: number} | {kind: "const", value: ConstValue}} GraphSchemeTemplateArg */
/** @typedef {{head: string, args: GraphSchemeTemplateArg[]}} GraphSchemeInputTemplate */
/** @typedef {{head: string, arity: number, inputTemplates: GraphSchemeInputTemplate[]}} GraphSchemeNode */
/** @typedef {{format: 1, nodes: GraphSchemeNode[]}} GraphScheme */

const GRAPH_SCHEME_KEY = "graph_scheme";
const GRAPH_SCHEME_FORMAT = 1;

class GraphSchemeError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "GraphSchemeError";
    }
}

/** @param {unknown} object @returns {object is GraphSchemeError} */
function isGraphSchemeError(object) {
    return object instanceof GraphSchemeError;
}

/** @param {import("../expr").ParsedExpr} inputExpr @param {Map<string, number>} varToPosition @returns {GraphSchemeInputTemplate} */
function templateFromExpr(inputExpr, varToPosition) {
    return {
        head: inputExpr.name,
        args: inputExpr.args.map((arg) => {
            const index = varToPosition.get(arg.value);
            if (index === undefined) {
                throw new GraphSchemeError(`Input variable ${arg.value} is not present in output`);
            }
            return { kind: "arg", index };
        }),
    };
}

/** @param {import("../types").CompiledNode[]} compiledNodes @returns {GraphScheme} */
function buildGraphSchemeFromNodeDefs(compiledNodes) {
    const nodes = compiledNodes.map((compiledNode) => {
        const varToPosition = new Map();
        for (let index = 0; index < compiledNode.outputExpr.args.length; index++) {
            const arg = compiledNode.outputExpr.args[index];
            if (arg !== undefined) varToPosition.set(arg.value, index);
        }
        return {
            head: String(compiledNode.head),
            arity: compiledNode.arity,
            inputTemplates: compiledNode.inputExprs.map((inputExpr) => templateFromExpr(inputExpr, varToPosition)),
        };
    }).sort((a, b) => a.head.localeCompare(b.head));
    return parseGraphScheme({ format: GRAPH_SCHEME_FORMAT, nodes });
}

/** @param {unknown} arg @param {GraphSchemeNode} node @returns {void} */
function validateTemplateArg(arg, node) {
    if (!arg || typeof arg !== "object") throw new GraphSchemeError(`Invalid graph_scheme template arg for ${node.head}`);
    if (arg.kind === "arg") {
        if (!Number.isInteger(arg.index) || arg.index < 0 || arg.index >= node.arity) {
            throw new GraphSchemeError(`Invalid graph_scheme arg index for ${node.head}: ${arg.index}`);
        }
        return;
    }
    if (arg.kind === "const") return;
    throw new GraphSchemeError(`Invalid graph_scheme template arg kind for ${node.head}: ${arg.kind}`);
}

/** @param {unknown} value @returns {GraphScheme} */
function parseGraphScheme(value) {
    if (typeof value === "string") {
        value = JSON.parse(value);
    }
    if (!value || typeof value !== "object" || value.format !== GRAPH_SCHEME_FORMAT || !Array.isArray(value.nodes)) {
        throw new GraphSchemeError("Invalid graph_scheme record");
    }
    const heads = new Set();
    const nodes = value.nodes.map((node) => {
        if (!node || typeof node !== "object" || typeof node.head !== "string" || !Number.isInteger(node.arity) || node.arity < 0 || !Array.isArray(node.inputTemplates)) {
            throw new GraphSchemeError("Invalid graph_scheme node record");
        }
        if (heads.has(node.head)) throw new GraphSchemeError(`Duplicate graph_scheme head: ${node.head}`);
        heads.add(node.head);
        const inputTemplates = node.inputTemplates.map((template) => {
            if (!template || typeof template !== "object" || typeof template.head !== "string" || !Array.isArray(template.args)) {
                throw new GraphSchemeError(`Invalid graph_scheme input template for ${node.head}`);
            }
            const args = template.args.map((arg) => {
                validateTemplateArg(arg, node);
                return arg.kind === "arg" ? { kind: "arg", index: arg.index } : { kind: "const", value: arg.value };
            });
            return { head: template.head, args };
        });
        return { head: node.head, arity: node.arity, inputTemplates };
    }).sort((a, b) => a.head.localeCompare(b.head));
    for (const node of nodes) {
        for (const template of node.inputTemplates) {
            if (!heads.has(template.head)) throw new GraphSchemeError(`Unknown graph_scheme input head: ${template.head}`);
        }
    }
    return { format: GRAPH_SCHEME_FORMAT, nodes };
}

/** @param {GraphScheme} graphScheme @returns {GraphScheme} */
function serializeGraphScheme(graphScheme) {
    return parseGraphScheme(graphScheme);
}

/** @param {GraphScheme} graphScheme @param {NodeKeyString} outputNodeKeyString @returns {NodeKeyString[]} */
function deriveInputPositions(graphScheme, outputNodeKeyString) {
    const scheme = parseGraphScheme(graphScheme);
    const output = deserializeNodeKey(outputNodeKeyString);
    const node = scheme.nodes.find((candidate) => candidate.head === output.head);
    if (!node) throw new GraphSchemeError(`Missing graph_scheme node for head: ${output.head}`);
    if (output.args.length !== node.arity) throw new GraphSchemeError(`Arity mismatch for graph_scheme node ${output.head}`);
    return node.inputTemplates.map((template) => serializeNodeKey({
        head: stringToNodeName(template.head),
        args: template.args.map((arg) => arg.kind === "arg" ? output.args[arg.index] : arg.value),
    }));
}

/** @param {IdentifierLookup | TransactionIdentifierLookup | {nodeKeyToId: (key: NodeKeyString) => NodeIdentifier | undefined}} identifierLookup @param {NodeKeyString} key @returns {NodeIdentifier | undefined} */
function lookupKeyToId(identifierLookup, key) {
    if (typeof identifierLookup.nodeKeyToId === "function") return identifierLookup.nodeKeyToId(key);
    return identifierLookup.keyToId.get(nodeKeyStringToString(key));
}

/** @param {IdentifierLookup | TransactionIdentifierLookup | {nodeIdToKey: (id: NodeIdentifier) => NodeKeyString | undefined}} identifierLookup @param {NodeIdentifier} id @returns {NodeKeyString | undefined} */
function lookupIdToKey(identifierLookup, id) {
    if (typeof identifierLookup.nodeIdToKey === "function") return identifierLookup.nodeIdToKey(id);
    return identifierLookup.idToKey.get(nodeIdentifierToString(id));
}

/** @param {GraphScheme} graphScheme @param {IdentifierLookup | TransactionIdentifierLookup} identifierLookup @param {NodeIdentifier} outputIdentifier @returns {NodeIdentifier[]} */
function deriveInputEdges(graphScheme, identifierLookup, outputIdentifier) {
    const outputKey = lookupIdToKey(identifierLookup, outputIdentifier);
    if (outputKey === undefined) throw new GraphSchemeError(`Missing semantic node key for identifier ${nodeIdentifierToString(outputIdentifier)}`);
    const inputPositions = deriveInputPositions(graphScheme, outputKey);
    const inputIdentifiers = inputPositions.map((inputKey) => {
        const id = lookupKeyToId(identifierLookup, inputKey);
        if (id === undefined) throw new GraphSchemeError(`Missing identifier for dependency ${String(inputKey)}`);
        return id;
    });
    return normalizeInputEdges(inputIdentifiers);
}

/** @param {GraphScheme} graphScheme @param {IdentifierLookup | TransactionIdentifierLookup} identifierLookup @param {NodeIdentifier} outputIdentifier @returns {NodeKeyString[]} */
function semanticInputKeys(graphScheme, identifierLookup, outputIdentifier) {
    const outputKey = lookupIdToKey(identifierLookup, outputIdentifier);
    if (outputKey === undefined) throw new GraphSchemeError(`Missing semantic node key for identifier ${nodeIdentifierToString(outputIdentifier)}`);
    return deriveInputPositions(graphScheme, outputKey);
}

module.exports = { GRAPH_SCHEME_KEY, GraphSchemeError, isGraphSchemeError, buildGraphSchemeFromNodeDefs, serializeGraphScheme, parseGraphScheme, deriveInputPositions, deriveInputEdges, normalizeInputEdges, semanticInputKeys };
