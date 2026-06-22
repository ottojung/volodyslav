const { serializeNodeKey, deserializeNodeKey } = require("./node_key");
const { stringToNodeName, nodeNameToString, nodeKeyStringToString } = require("./types");
const { nodeIdentifierToString } = require("./node_identifier");
const { normalizeInputEdges } = require("./input_edges");

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return value !== null && typeof value === "object";
}

/**
 * @param {IdentifierLookup | TransactionIdentifierLookup} lookup
 * @returns {lookup is TransactionIdentifierLookup}
 */
function hasBaseLookup(lookup) {
    return "base" in lookup;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isInteger(value) {
    return Number.isInteger(value);
}

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
        if (arg === undefined) {
            throw new GraphSchemeError("Input expression contains a missing argument");
        }
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
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!isRecord(parsed)) {
        throw new GraphSchemeError("Invalid graph_scheme record");
    }
    const format = parsed["format"];
    const rawNodes = parsed["nodes"];
    if (format !== GRAPH_SCHEME_FORMAT || !Array.isArray(rawNodes)) {
        throw new GraphSchemeError("Invalid graph_scheme record");
    }
    /** @type {Set<string>} */
    const heads = new Set();
    /** @type {GraphSchemeNode[]} */
    const nodes = [];
    for (const node of rawNodes) {
        if (!isRecord(node)) {
            throw new GraphSchemeError("Invalid graph_scheme node record");
        }
        const head = node["head"];
        const arity = node["arity"];
        const inputTemplates = node["inputTemplates"];
        if (typeof head !== "string" || !Array.isArray(inputTemplates)) {
            throw new GraphSchemeError("Invalid graph_scheme node record");
        }
        if (!isInteger(arity)) {
            throw new GraphSchemeError("Invalid graph_scheme node record");
        }
        if (arity < 0) {
            throw new GraphSchemeError("Invalid graph_scheme node record");
        }
        if (heads.has(head)) {
            throw new GraphSchemeError(`Duplicate graph_scheme head: ${head}`);
        }
        heads.add(head);
        /** @type {GraphSchemeInputTemplate[]} */
        const parsedInputTemplates = [];
        for (const template of inputTemplates) {
            if (!isRecord(template)) {
                throw new GraphSchemeError(`Invalid graph_scheme input template for ${head}`);
            }
            const templateHead = template["head"];
            const templateArgs = template["args"];
            if (typeof templateHead !== "string" || !Array.isArray(templateArgs)) {
                throw new GraphSchemeError(`Invalid graph_scheme input template for ${head}`);
            }
            /** @type {number[]} */
            const args = [];
            for (const arg of templateArgs) {
                if (!isInteger(arg)) {
                    throw new GraphSchemeError(`Invalid graph_scheme arg index for ${head}: ${String(arg)}`);
                }
                if (arg < 0 || arg >= arity) {
                    throw new GraphSchemeError(`Invalid graph_scheme arg index for ${head}: ${String(arg)}`);
                }
                args.push(arg);
            }
            parsedInputTemplates.push({ head: templateHead, args });
        }
        nodes.push({ head, arity, inputTemplates: parsedInputTemplates });
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
    if (hasBaseLookup(identifierLookup)) {
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
    if (hasBaseLookup(identifierLookup)) {
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

/**
 * Assert that the stored graph_scheme string matches the expected string exactly.
 *
 * This function enforces the invariant that global/graph_scheme is initialization
 * metadata, not mutable runtime state. No normalization, parsing, or reserialization
 * is performed. Formatting differences count as differences.
 *
 * For an initialized database, the stored scheme must exist and must byte-for-byte
 * equal the current scheme. Missing schemes fail.
 *
 * If the stored value is a parsed JSON object (from LevelDB's JSON encoding), it is
 * stringified with JSON.stringify for the comparison. This is not semantic
 * normalization — it is a storage-encoding conversion to the canonical string form.
 *
 * @param {unknown} stored - Raw value read from global storage.
 * @param {string} expected - The exact expected graph_scheme JSON string.
 * @param {string} contextDescription - Human-readable description for error messages.
 * @returns {void}
 */
function assertExactStoredGraphSchemeMatches(stored, expected, contextDescription) {
    if (stored === undefined) {
        throw new MissingGraphSchemeError(contextDescription);
    }
    const storedStr = typeof stored === 'string' ? stored : JSON.stringify(stored);
    if (storedStr !== expected) {
        throw new GraphSchemeError(
            `Exact graph_scheme string mismatch in ${contextDescription}: ` +
            `stored scheme does not match current graph scheme. ` +
            `Formatting differences count as differences.`
        );
    }
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
    assertExactStoredGraphSchemeMatches,
};
