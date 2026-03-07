const express = require("express");
const { isMissingTimestamp } = require('../generators/incremental_graph');

/** @typedef {import('../generators').Interface} Interface */
/** @typedef {import('../generators/incremental_graph/types').CompiledNode} CompiledNode */

/**
 * @typedef {object} Capabilities
 * @property {Interface} interface - The incremental graph interface capability.
 */

/**
 * Formats a schema entry from a CompiledNode.
 * @param {CompiledNode} compiledNode
 * @returns {object}
 */
function formatSchema(compiledNode) {
    return {
        head: compiledNode.head,
        arity: compiledNode.arity,
        output: compiledNode.canonicalOutput,
        inputs: compiledNode.canonicalInputs,
        isDeterministic: compiledNode.source.isDeterministic,
        hasSideEffects: compiledNode.source.hasSideEffects,
    };
}

/**
 * Formats an arity mismatch error message according to the API spec.
 * @param {string} head
 * @param {number} expected
 * @param {number} received
 * @returns {string}
 */
function formatArityMismatchMessage(head, expected, received) {
    const argWord = expected === 1 ? "argument" : "arguments";
    return `Arity mismatch: ${JSON.stringify(head)} expects ${expected} ${argWord}, got ${received}`;
}

/**
 * Handles GET /graph/schemas — returns all node family definitions.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
async function handleGetSchemas(capabilities, _req, res) {
    const graph = capabilities.interface.incrementalGraph;
    if (graph === null) {
        res.status(503).json({ error: "Graph not yet initialized" });
        return;
    }

    const schemas = graph.debugGetSchemas().map(formatSchema);
    res.json(schemas);
}

/**
 * Handles GET /graph/schemas/:head — returns a single schema entry.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleGetSchemaByHead(capabilities, req, res) {
    const graph = capabilities.interface.incrementalGraph;
    if (graph === null) {
        res.status(503).json({ error: "Graph not yet initialized" });
        return;
    }

    const { head } = req.params;
    if (head === undefined) {
        res.status(400).json({ error: "Missing head parameter" });
        return;
    }

    const compiledNode = graph.debugGetSchemaByHead(head);
    if (compiledNode === null) {
        res.status(404).json({ error: `Unknown node: ${JSON.stringify(head)}` });
        return;
    }

    res.json(formatSchema(compiledNode));
}

/**
 * Fetches createdAt and modifiedAt for a node using the existing timestamp accessors.
 * Returns null values if no timestamps are recorded for the node.
 * @param {object} graph - The incremental graph instance.
 * @param {string} head - The node head name.
 * @param {Array<string>} args - The node arguments.
 * @returns {Promise<{createdAt: string | null, modifiedAt: string | null}>}
 */
async function fetchTimestamps(graph, head, args) {
    try {
        const createdAt = (await graph.getCreationTime(head, args)).toISOString();
        const modifiedAt = (await graph.getModificationTime(head, args)).toISOString();
        return { createdAt, modifiedAt };
    } catch (err) {
        if (isMissingTimestamp(err)) {
            return { createdAt: null, modifiedAt: null };
        }
        throw err;
    }
}

/**
 * Handles GET /graph/nodes — lists all materialized instances with freshness.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
async function handleGetNodes(capabilities, _req, res) {
    const graph = capabilities.interface.incrementalGraph;
    if (graph === null) {
        res.status(503).json({ error: "Graph not yet initialized" });
        return;
    }

    const materialized = await graph.debugListMaterializedNodes();
    const result = [];
    for (const [head, args] of materialized) {
        const freshness = await graph.debugGetFreshness(head, args);
        if (freshness !== "missing") {
            const { createdAt, modifiedAt } = await fetchTimestamps(graph, head, args);
            result.push({ head, args, freshness, createdAt, modifiedAt });
        }
    }
    res.json(result);
}

/**
 * Handles GET /graph/nodes/:head — arity-0: single instance with value;
 * arity-N: list of instances without values.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleGetNodesByHead(capabilities, req, res) {
    const graph = capabilities.interface.incrementalGraph;
    if (graph === null) {
        res.status(503).json({ error: "Graph not yet initialized" });
        return;
    }

    const { head } = req.params;
    if (head === undefined) {
        res.status(400).json({ error: "Missing head parameter" });
        return;
    }

    const compiledNode = graph.debugGetSchemaByHead(head);
    if (compiledNode === null) {
        res.status(404).json({ error: `Unknown node: ${JSON.stringify(head)}` });
        return;
    }

    if (compiledNode.arity === 0) {
        // Arity-0: return single instance with value
        const freshness = await graph.debugGetFreshness(head, []);
        if (freshness === "missing") {
            res.status(404).json({ error: `Node not materialized: ${JSON.stringify(head)}` });
            return;
        }
        const value = await graph.debugGetValue(head, []);
        const { createdAt, modifiedAt } = await fetchTimestamps(graph, head, []);
        res.json({ head, args: [], freshness, value, createdAt, modifiedAt });
    } else {
        // Arity-N: return list of all materialized instances without values
        const materialized = await graph.debugListMaterializedNodes();
        const result = [];
        for (const [nodeHead, args] of materialized) {
            if (nodeHead === head) {
                const freshness = await graph.debugGetFreshness(nodeHead, args);
                if (freshness !== "missing") {
                    const { createdAt, modifiedAt } = await fetchTimestamps(graph, nodeHead, args);
                    result.push({ head, args, freshness, createdAt, modifiedAt });
                }
            }
        }
        res.json(result);
    }
}

/**
 * Handles GET /graph/nodes/:head/* — single parameterized instance with value.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleGetNodeByHeadAndArgs(capabilities, req, res) {
    const graph = capabilities.interface.incrementalGraph;
    if (graph === null) {
        res.status(503).json({ error: "Graph not yet initialized" });
        return;
    }

    const { head } = req.params;
    if (head === undefined) {
        res.status(400).json({ error: "Missing head parameter" });
        return;
    }

    const compiledNode = graph.debugGetSchemaByHead(head);
    if (compiledNode === null) {
        res.status(404).json({ error: `Unknown node: ${JSON.stringify(head)}` });
        return;
    }

    // Extract args from wildcard path segments
    const argsStr = req.params[0];
    if (argsStr === undefined) {
        res.status(400).json({ error: "Missing args parameter" });
        return;
    }
    const args = argsStr.split("/").filter((s) => s.length > 0);

    if (compiledNode.arity !== args.length) {
        res.status(400).json({
            error: formatArityMismatchMessage(head, compiledNode.arity, args.length),
        });
        return;
    }

    const freshness = await graph.debugGetFreshness(head, args);
    if (freshness === "missing") {
        const displayKey = `${head}(${args.join(",")})`;
        res.status(404).json({ error: `Node not materialized: ${JSON.stringify(displayKey)}` });
        return;
    }

    const value = await graph.debugGetValue(head, args);
    const { createdAt, modifiedAt } = await fetchTimestamps(graph, head, args);
    res.json({ head, args, freshness, value, createdAt, modifiedAt });
}

/**
 * Creates an Express router for the graph inspection endpoints.
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();

    router.get("/graph/schemas", async (req, res) => {
        await handleGetSchemas(capabilities, req, res);
    });

    router.get("/graph/schemas/:head", async (req, res) => {
        await handleGetSchemaByHead(capabilities, req, res);
    });

    router.get("/graph/nodes", async (req, res) => {
        await handleGetNodes(capabilities, req, res);
    });

    // Must be defined before /graph/nodes/:head to ensure wildcard paths are handled correctly
    router.get("/graph/nodes/:head/*", async (req, res) => {
        await handleGetNodeByHeadAndArgs(capabilities, req, res);
    });

    router.get("/graph/nodes/:head", async (req, res) => {
        await handleGetNodesByHead(capabilities, req, res);
    });

    return router;
}

module.exports = { makeRouter };
