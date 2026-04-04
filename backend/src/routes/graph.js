const express = require("express");
const {
    fetchTimestamps,
    formatArityMismatchMessage,
    getArgsFromRequest,
    pullNode,
} = require("./graph_helpers");

/** @typedef {import('../generators').Interface} Interface */
/** @typedef {import('../generators/incremental_graph/types').CompiledNode} CompiledNode */
/** @typedef {import('../generators/incremental_graph/types').ConstValue} ConstValue */

/**
 * @typedef {object} GraphRouteInterface
 * @property {() => boolean} isInitialized
 * @property {() => Promise<void>} ensureInitialized
 * @property {() => Array<CompiledNode>} getSchemas
 * @property {(head: string) => CompiledNode | null} getSchemaByHead
 * @property {() => Promise<Array<[string, Array<ConstValue>]>>} listMaterializedNodes
 * @property {(head: string, bindings?: Record<string, ConstValue>) => Promise<import('../generators/incremental_graph/types').FreshnessStatus>} getFreshness
 * @property {(head: string, bindings?: Record<string, ConstValue>) => Promise<unknown>} getValue
 * @property {(head: string, bindings?: Record<string, ConstValue>) => Promise<unknown>} pullGraphNode
 * @property {(head: string, bindings?: Record<string, ConstValue>) => Promise<void>} invalidateGraphNode
 * @property {(head: string, bindings?: Record<string, ConstValue>) => Promise<import('../datetime').DateTime>} getCreationTime
 * @property {(head: string, bindings?: Record<string, ConstValue>) => Promise<import('../datetime').DateTime>} getModificationTime
 * @property {(head: string, args: Array<ConstValue>) => Record<string, ConstValue>} positionalToBindings
 */

/**
 * @typedef {object} Capabilities
 * @property {GraphRouteInterface} interface - The incremental graph interface capability.
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
 * Handles GET /graph/schemas — returns all node family definitions.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
async function handleGetSchemas(capabilities, _req, res) {
    await capabilities.interface.ensureInitialized();

    const schemas = capabilities.interface.getSchemas().map(formatSchema);
    res.json(schemas);
}

/**
 * Handles GET /graph/schemas/:head — returns a single schema entry.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleGetSchemaByHead(capabilities, req, res) {
    await capabilities.interface.ensureInitialized();

    const { head } = req.params;
    if (head === undefined) {
        res.status(400).json({ error: "Missing head parameter" });
        return;
    }

    const compiledNode = capabilities.interface.getSchemaByHead(head);
    if (compiledNode === null) {
        res.status(404).json({ error: `Unknown node: ${JSON.stringify(head)}` });
        return;
    }

    res.json(formatSchema(compiledNode));
}

/**
 * Handles GET /graph/nodes — lists all materialized instances with freshness.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
async function handleGetNodes(capabilities, _req, res) {
    await capabilities.interface.ensureInitialized();

    const materialized = await capabilities.interface.listMaterializedNodes();
    const result = [];
    for (const [head, args] of materialized) {
        const bindings = capabilities.interface.positionalToBindings(head, args);
        const freshness = await capabilities.interface.getFreshness(head, bindings);
        if (freshness !== "missing") {
            const { createdAt, modifiedAt } = await fetchTimestamps(capabilities.interface, head, bindings);
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
    await capabilities.interface.ensureInitialized();

    const { head } = req.params;
    if (head === undefined) {
        res.status(400).json({ error: "Missing head parameter" });
        return;
    }

    const compiledNode = capabilities.interface.getSchemaByHead(head);
    if (compiledNode === null) {
        res.status(404).json({ error: `Unknown node: ${JSON.stringify(head)}` });
        return;
    }

    if (compiledNode.arity === 0) {
        // Arity-0: return single instance with value
        const freshness = await capabilities.interface.getFreshness(head, {});
        if (freshness === "missing") {
            res.status(404).json({ error: `Node not materialized: ${JSON.stringify(head)}` });
            return;
        }
        const value = await capabilities.interface.getValue(head, {});
        const { createdAt, modifiedAt } = await fetchTimestamps(capabilities.interface, head, {});
        res.json({ head, args: [], freshness, value, createdAt, modifiedAt });
    } else {
        // Arity-N: return list of all materialized instances without values
        const materialized = await capabilities.interface.listMaterializedNodes();
        const result = [];
        for (const [nodeHead, args] of materialized) {
            if (nodeHead === head) {
                const bindings = capabilities.interface.positionalToBindings(nodeHead, args);
                const freshness = await capabilities.interface.getFreshness(nodeHead, bindings);
                if (freshness !== "missing") {
                    const { createdAt, modifiedAt } = await fetchTimestamps(capabilities.interface, nodeHead, bindings);
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
    await capabilities.interface.ensureInitialized();

    const { head } = req.params;
    if (head === undefined) {
        res.status(400).json({ error: "Missing head parameter" });
        return;
    }

    const compiledNode = capabilities.interface.getSchemaByHead(head);
    if (compiledNode === null) {
        res.status(404).json({ error: `Unknown node: ${JSON.stringify(head)}` });
        return;
    }

    const args = getArgsFromRequest(req);
    if (args === null) {
        res.status(400).json({ error: "Missing args parameter" });
        return;
    }

    if (compiledNode.arity !== args.length) {
        res.status(400).json({
            error: formatArityMismatchMessage(head, compiledNode.arity, args.length),
        });
        return;
    }

    const bindings = capabilities.interface.positionalToBindings(head, args);
    const freshness = await capabilities.interface.getFreshness(head, bindings);
    if (freshness === "missing") {
        const displayKey = `${head}(${args.join(",")})`;
        res.status(404).json({ error: `Node not materialized: ${JSON.stringify(displayKey)}` });
        return;
    }

    const value = await capabilities.interface.getValue(head, bindings);
    const { createdAt, modifiedAt } = await fetchTimestamps(capabilities.interface, head, bindings);
    res.json({ head, args, freshness, value, createdAt, modifiedAt });
}

/**
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handlePullNodeByHead(capabilities, req, res) {
    await capabilities.interface.ensureInitialized();
    const { head } = req.params;
    if (head === undefined) {
        res.status(400).json({ error: "Missing head parameter" });
        return;
    }
    const compiledNode = capabilities.interface.getSchemaByHead(head);
    if (compiledNode === null) {
        res.status(404).json({ error: `Unknown node: ${JSON.stringify(head)}` });
        return;
    }
    if (compiledNode.arity !== 0) {
        res.status(400).json({ error: formatArityMismatchMessage(head, compiledNode.arity, 0) });
        return;
    }
    res.json(await pullNode(capabilities, head, []));
}

/**
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handlePullNodeByHeadAndArgs(capabilities, req, res) {
    await capabilities.interface.ensureInitialized();
    const { head } = req.params;
    if (head === undefined) {
        res.status(400).json({ error: "Missing head parameter" });
        return;
    }
    const args = getArgsFromRequest(req);
    const compiledNode = capabilities.interface.getSchemaByHead(head);
    if (compiledNode === null) {
        res.status(404).json({ error: `Unknown node: ${JSON.stringify(head)}` });
        return;
    }
    if (args === null) {
        res.status(400).json({ error: "Missing args parameter" });
        return;
    }
    if (compiledNode.arity !== args.length) {
        res.status(400).json({ error: formatArityMismatchMessage(head, compiledNode.arity, args.length) });
        return;
    }
    res.json(await pullNode(capabilities, head, args));
}

/**
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleInvalidateNodeByHead(capabilities, req, res) {
    await capabilities.interface.ensureInitialized();
    const { head } = req.params;
    if (head === undefined) {
        res.status(400).json({ error: "Missing head parameter" });
        return;
    }
    const compiledNode = capabilities.interface.getSchemaByHead(head);
    if (compiledNode === null) {
        res.status(404).json({ error: `Unknown node: ${JSON.stringify(head)}` });
        return;
    }
    if (compiledNode.arity !== 0) {
        res.status(400).json({ error: formatArityMismatchMessage(head, compiledNode.arity, 0) });
        return;
    }
    await capabilities.interface.invalidateGraphNode(head, {});
    res.json({ success: true });
}

/**
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleInvalidateNodeByHeadAndArgs(capabilities, req, res) {
    await capabilities.interface.ensureInitialized();
    const { head } = req.params;
    if (head === undefined) {
        res.status(400).json({ error: "Missing head parameter" });
        return;
    }
    const compiledNode = capabilities.interface.getSchemaByHead(head);
    if (compiledNode === null) {
        res.status(404).json({ error: `Unknown node: ${JSON.stringify(head)}` });
        return;
    }
    const args = getArgsFromRequest(req);
    if (args === null) {
        res.status(400).json({ error: "Missing args parameter" });
        return;
    }
    if (compiledNode.arity !== args.length) {
        res.status(400).json({ error: formatArityMismatchMessage(head, compiledNode.arity, args.length) });
        return;
    }
    const bindings = capabilities.interface.positionalToBindings(head, args);
    await capabilities.interface.invalidateGraphNode(head, bindings);
    res.json({ success: true });
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

    router.post("/graph/nodes/:head/*", async (req, res) => {
        await handlePullNodeByHeadAndArgs(capabilities, req, res);
    });

    router.delete("/graph/nodes/:head/*", async (req, res) => {
        await handleInvalidateNodeByHeadAndArgs(capabilities, req, res);
    });

    router.get("/graph/nodes/:head", async (req, res) => {
        await handleGetNodesByHead(capabilities, req, res);
    });

    router.post("/graph/nodes/:head", async (req, res) => {
        await handlePullNodeByHead(capabilities, req, res);
    });

    router.delete("/graph/nodes/:head", async (req, res) => {
        await handleInvalidateNodeByHead(capabilities, req, res);
    });

    return router;
}

module.exports = { makeRouter };
