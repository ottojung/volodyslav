const { serializeNodeKey, deserializeNodeKey } = require("./node_key");
const { stringToNodeName, nodeNameToString, nodeKeyStringToString } = require("./types");
const { nodeIdentifierToString } = require("./node_identifier");
const { normalizeInputEdges } = require("./input_edges");

/** @typedef {import("../types").CompiledNode} CompiledNode */
/** @typedef {import("../expr").ParsedExpr} ParsedExpr */
/** @typedef {import("./types").NodeIdentifier} NodeIdentifier */
/** @typedef {import("./types").NodeKeyString} NodeKeyString */
/** @typedef {import("./identifier_lookup").IdentifierLookup} IdentifierLookup */
/** @typedef {import("./identifier_lookup").TransactionIdentifierLookup} TransactionIdentifierLookup */
/** @typedef {{head: string, args: number[]}} GraphSchemeInputTemplate */
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

class MissingGraphSchemeError extends GraphSchemeError {
    /** @param {string} sourceDescription */
    constructor(sourceDescription) {
        super(
            `Missing global/graph_scheme in ${sourceDescription}: ` +
            "the source replica is versioned but has no graph_scheme key. " +
            "This indicates corruption or an incomplete migration."
        );
        this.name = "MissingGraphSchemeError";
    }
}

/**
 * @param {unknown} object
 * @returns {object is GraphSchemeError}
 */
function isGraphSchemeError(object) {
    return object instanceof GraphSchemeError;
}

/**
 * @param {unknown} object
 * @returns {object is MissingGraphSchemeError}
 */
function isMissingGraphSchemeError(object) {
    return object instanceof MissingGraphSchemeError;
}

/**
 * @param {ParsedExpr} outputExpr
 * @returns {Map<string, number>}
 */
function outputVariablePositions(outputExpr) {
    /** @type {Map<string, number>} */
    const positions = new Map();
    for (let index = 0; index < outputExpr.args.length; index++) {
        const arg = outputExpr.args[index];
        if (arg !== undefined) {
            positions.set(arg.value, index);
        }
    }
    return positions;
}

/**
 * @param {ParsedExpr} inputExpr
 * @param {Map<string, number>} varToPosition
 * @returns {GraphSchemeInputTemplate}
 */
function templateFromExpr(inputExpr, varToPosition) {
    /** @type {number[]} */
    const args = [];
    for (const arg of inputExpr.args) {
        const index = varToPosition.get(arg.value);
        if (index === undefined) {
            throw new GraphSchemeError(`Input variable ${arg.value} is not present in output`);
        }
        args.push(index);
    }
    return { head: nodeNameToString(inputExpr.name), args };
}

/**
 * @param {CompiledNode[]} compiledNodes
 * @returns {GraphScheme}
 */
function buildGraphSchemeFromNodeDefs(compiledNodes) {
    const nodes = compiledNodes.map((compiledNode) => ({
        head: nodeNameToString(compiledNode.head),
        arity: compiledNode.arity,
        inputTemplates: compiledNode.inputExprs.map((inputExpr) =>
            templateFromExpr(inputExpr, outputVariablePositions(compiledNode.outputExpr))
        ),
    })).sort((a, b) => a.head.localeCompare(b.head));
    return parseGraphScheme({ format: GRAPH_SCHEME_FORMAT, nodes });
}

/**
 * @param {unknown} raw
 * @returns {GraphScheme}
 */
function parseGraphScheme(raw) {
    if (raw === undefined || raw === null) {
        throw new GraphSchemeError("Missing or null graph_scheme record: cannot derive dependencies without a stored graph_scheme");
    }
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object") {
        throw new GraphSchemeError("Invalid graph_scheme record");
    }
    if (!("format" in value) || value.format !== GRAPH_SCHEME_FORMAT || !("nodes" in value) || !Array.isArray(value.nodes)) {
        throw new GraphSchemeError("Invalid graph_scheme record");
    }
    /** @type {Set<string>} */
    const heads = new Set();
    /** @type {GraphSchemeNode[]} */
    const nodes = [];
    for (const node of value.nodes) {
        if (!node || typeof node !== "object") {
            throw new GraphSchemeError("Invalid graph_scheme node record");
        }
        if (!("head" in node) || typeof node.head !== "string" || !("arity" in node) || !Number.isInteger(node.arity) || node.arity < 0 || !("inputTemplates" in node) || !Array.isArray(node.inputTemplates)) {
            throw new GraphSchemeError("Invalid graph_scheme node record");
        }
        if (heads.has(node.head)) {
            throw new GraphSchemeError(`Duplicate graph_scheme head: ${node.head}`);
        }
        heads.add(node.head);
        /** @type {GraphSchemeInputTemplate[]} */
        const inputTemplates = [];
        for (const template of node.inputTemplates) {
            if (!template || typeof template !== "object" || !("head" in template) || typeof template.head !== "string" || !("args" in template) || !Array.isArray(template.args)) {
                throw new GraphSchemeError(`Invalid graph_scheme input template for ${node.head}`);
            }
            /** @type {number[]} */
            const args = [];
            for (const arg of template.args) {
                if (!Number.isInteger(arg) || arg < 0 || arg >= node.arity) {
                    throw new GraphSchemeError(`Invalid graph_scheme arg index for ${node.head}: ${String(arg)}`);
                }
                args.push(arg);
            }
            inputTemplates.push({ head: template.head, args });
        }
        nodes.push({ head: node.head, arity: node.arity, inputTemplates });
    }
    nodes.sort((a, b) => a.head.localeCompare(b.head));
    for (const node of nodes) {
        for (const template of node.inputTemplates) {
            if (!heads.has(template.head)) {
                throw new GraphSchemeError(`Unknown graph_scheme input head: ${template.head}`);
            }
        }
    }
    return { format: GRAPH_SCHEME_FORMAT, nodes };
}

/**
 * @param {GraphScheme} graphScheme
 * @returns {GraphScheme}
 */
function serializeGraphScheme(graphScheme) {
    return parseGraphScheme(graphScheme);
}

/**
 * @param {GraphScheme} graphScheme
 * @param {NodeKeyString} outputNodeKeyString
 * @returns {NodeKeyString[]}
 */
function deriveInputPositions(graphScheme, outputNodeKeyString) {
    const scheme = parseGraphScheme(graphScheme);
    const output = deserializeNodeKey(outputNodeKeyString);
    const outputHead = nodeNameToString(output.head);
    const node = scheme.nodes.find((candidate) => candidate.head === outputHead);
    if (node === undefined) {
        throw new GraphSchemeError(`Missing graph_scheme node for head: ${outputHead}`);
    }
    if (output.args.length !== node.arity) {
        throw new GraphSchemeError(`Arity mismatch for graph_scheme node ${outputHead}`);
    }
    return node.inputTemplates.map((template) => serializeNodeKey({
        head: stringToNodeName(template.head),
        args: template.args.map((argIndex) => {
            const arg = output.args[argIndex];
            if (arg === undefined) {
                throw new GraphSchemeError(`Missing argument ${argIndex} for graph_scheme node ${outputHead}`);
            }
            return arg;
        }),
    }));
}

/**
 * @param {IdentifierLookup | TransactionIdentifierLookup} identifierLookup
 * @param {NodeKeyString} key
 * @returns {NodeIdentifier | undefined}
 */
function lookupKeyToId(identifierLookup, key) {
    const direct = identifierLookup.keyToId.get(nodeKeyStringToString(key));
    if (direct !== undefined) return direct;
    if ("base" in identifierLookup) {
        return identifierLookup.base.keyToId.get(nodeKeyStringToString(key));
    }
    return undefined;
}

/**
 * @param {IdentifierLookup | TransactionIdentifierLookup} identifierLookup
 * @param {NodeIdentifier} id
 * @returns {NodeKeyString | undefined}
 */
function lookupIdToKey(identifierLookup, id) {
    const idString = nodeIdentifierToString(id);
    const direct = identifierLookup.idToKey.get(idString);
    if (direct !== undefined) return direct;
    if ("base" in identifierLookup) {
        return identifierLookup.base.idToKey.get(idString);
    }
    return undefined;
}

/**
 * @param {GraphScheme} graphScheme
 * @param {IdentifierLookup | TransactionIdentifierLookup} identifierLookup
 * @param {NodeIdentifier} outputIdentifier
 * @returns {NodeIdentifier[]}
 */
function deriveInputEdges(graphScheme, identifierLookup, outputIdentifier) {
    const outputKey = lookupIdToKey(identifierLookup, outputIdentifier);
    if (outputKey === undefined) {
        throw new GraphSchemeError(`Missing semantic node key for identifier ${nodeIdentifierToString(outputIdentifier)}`);
    }
    const inputPositions = deriveInputPositions(graphScheme, outputKey);
    const inputIdentifiers = inputPositions.map((inputKey) => {
        const id = lookupKeyToId(identifierLookup, inputKey);
        if (id === undefined) {
            throw new GraphSchemeError(`Missing identifier for dependency ${String(inputKey)}`);
        }
        return id;
    });
    return normalizeInputEdges(inputIdentifiers);
}

/**
 * @param {GraphScheme} graphScheme
 * @param {IdentifierLookup | TransactionIdentifierLookup} identifierLookup
 * @param {NodeIdentifier} outputIdentifier
 * @returns {NodeKeyString[]}
 */
function semanticInputKeys(graphScheme, identifierLookup, outputIdentifier) {
    const outputKey = lookupIdToKey(identifierLookup, outputIdentifier);
    if (outputKey === undefined) {
        throw new GraphSchemeError(`Missing semantic node key for identifier ${nodeIdentifierToString(outputIdentifier)}`);
    }
    return deriveInputPositions(graphScheme, outputKey);
}

module.exports = {
    GRAPH_SCHEME_KEY,
    GraphSchemeError,
    MissingGraphSchemeError,
    isGraphSchemeError,
    isMissingGraphSchemeError,
    buildGraphSchemeFromNodeDefs,
    serializeGraphScheme,
    parseGraphScheme,
    deriveInputPositions,
    deriveInputEdges,
    normalizeInputEdges,
    semanticInputKeys,
};
