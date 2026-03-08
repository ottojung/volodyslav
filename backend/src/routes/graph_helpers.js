const { isMissingTimestamp } = require("../generators");

/** @typedef {import('../generators/incremental_graph/types').ConstValue} ConstValue */
/** @typedef {import('../datetime').DateTime} DateTime */
/**
 * @typedef {object} TimestampReader
 * @property {(head: string, args?: Array<ConstValue>) => Promise<DateTime>} getCreationTime
 * @property {(head: string, args?: Array<ConstValue>) => Promise<DateTime>} getModificationTime
 */
/**
 * @typedef {object} PullInterface
 * @property {(head: string, args?: Array<ConstValue>) => Promise<import('../generators/incremental_graph/types').FreshnessStatus>} debugGetFreshness
 * @property {(head: string, args?: Array<ConstValue>) => Promise<unknown>} pullGraphNode
 * @property {(head: string, args?: Array<ConstValue>) => Promise<DateTime>} getCreationTime
 * @property {(head: string, args?: Array<ConstValue>) => Promise<DateTime>} getModificationTime
 */

/**
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
 * @param {TimestampReader} graph
 * @param {string} head
 * @param {Array<ConstValue>} args
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
 * @param {import('express').Request} req
 * @returns {string}
 */
function getRawPathname(req) {
    const rawPath =
        typeof req.path === "string"
            ? req.path
            : typeof req.url === "string"
            ? req.url
            : typeof req.originalUrl === "string"
                ? req.originalUrl
                : "";
    const queryIndex = rawPath.indexOf("?");
    return queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
}

/**
 * @param {import('express').Request} req
 * @returns {Array<string> | null}
 */
function getArgsFromRequest(req) {
    const argsStr = req.params[0];
    if (argsStr === undefined) {
        return null;
    }
    const { head } = req.params;
    if (head === undefined) {
        return argsStr.split("/").filter((s) => s.length > 0);
    }

    const marker = `/graph/nodes/${encodeURIComponent(head)}/`;
    const markerIndex = getRawPathname(req).indexOf(marker);
    if (markerIndex === -1) {
        return argsStr.split("/").filter((s) => s.length > 0);
    }
    return getRawPathname(req)
        .slice(markerIndex + marker.length)
        .split("/")
        .filter((s) => s.length > 0)
        .map((segment) => decodeURIComponent(segment))
        .filter((s) => s.length > 0);
}

/**
 * @param {{ interface: PullInterface }} capabilities
 * @param {string} head
 * @param {Array<ConstValue>} args
 * @returns {Promise<object>}
 */
async function pullNode(capabilities, head, args) {
    const value = await capabilities.interface.pullGraphNode(head, args);
    const freshness = await capabilities.interface.debugGetFreshness(head, args);
    const { createdAt, modifiedAt } = await fetchTimestamps(capabilities.interface, head, args);
    return { head, args, freshness, value, createdAt, modifiedAt };
}

module.exports = {
    fetchTimestamps,
    formatArityMismatchMessage,
    getArgsFromRequest,
    pullNode,
};
