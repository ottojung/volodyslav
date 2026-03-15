const { isMissingTimestamp } = require("../generators");

/** @typedef {import('../generators/incremental_graph/types').ConstValue} ConstValue */
/** @typedef {import('../datetime').DateTime} DateTime */

const GRAPH_NODE_PATH_PREFIX = "/graph/nodes/";

/**
 * Prefix used to distinguish non-string ConstValue arguments from plain strings
 * in URL path segments.  A segment starting with `~` holds a JSON-encoded
 * non-string value; `~~` is the escaped form for a plain string that starts
 * with `~`.  This mirrors the encoding used for filesystem paths in
 * `database/render.js`.
 */
const NON_STRING_ARG_PREFIX = "~";
const ESCAPED_STRING_ARG_PREFIX = NON_STRING_ARG_PREFIX + NON_STRING_ARG_PREFIX;

/**
 * Decodes a single URL path segment back to a ConstValue.
 *
 * Encoding rules (applied after `decodeURIComponent`):
 *   - `~~…`  → plain string starting with `~`
 *   - `~…`   → JSON-parsed non-string value (number, boolean, null, array, object)
 *   - anything else → plain string
 *
 * @param {string} segment - A decoded URL path segment.
 * @returns {ConstValue}
 */
function decodeUrlArg(segment) {
    if (segment.startsWith(ESCAPED_STRING_ARG_PREFIX)) {
        return segment.slice(1);
    }
    if (segment.startsWith(NON_STRING_ARG_PREFIX)) {
        return JSON.parse(segment.slice(NON_STRING_ARG_PREFIX.length));
    }
    return segment;
}

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
 * Extract the least-decoded pathname available from an Express request.
 * This prefers the rawer request URL fields and falls back to req.path only when
 * needed, then strips any query text. Returns an empty string only if none of
 * those request fields are available as strings.
 * @param {import('express').Request} req
 * @returns {string}
 */
function getRawPathname(req) {
    let rawPath = "";
    if (typeof req.url === "string") {
        rawPath = req.url;
    } else if (typeof req.originalUrl === "string") {
        rawPath = req.originalUrl;
    } else if (typeof req.path === "string") {
        rawPath = req.path;
    }
    const queryIndex = rawPath.indexOf("?");
    return queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
}

/**
 * @param {import('express').Request} req
 * @returns {Array<ConstValue> | null}
 */
function getArgsFromRequest(req) {
    const argsStr = req.params[0];
    if (argsStr === undefined) {
        return null;
    }
    const { head } = req.params;
    if (head === undefined) {
        return argsStr.split("/").filter((s) => s.length > 0).map(decodeUrlArg);
    }

    // Route params are already decoded by Express. Re-encode the decoded head so the
    // marker matches the raw URL format, then use it to find the raw wildcard tail
    // while preserving encoded slashes inside args like `foo%2Fbar`.
    const marker = `${GRAPH_NODE_PATH_PREFIX}${encodeURIComponent(head)}/`;
    const rawPathname = getRawPathname(req);
    const markerIndex = rawPathname.indexOf(marker);
    if (markerIndex === -1) {
        return argsStr.split("/").filter((s) => s.length > 0).map(decodeUrlArg);
    }
    return rawPathname
        .slice(markerIndex + marker.length)
        .split("/")
        .map((segment) => decodeUrlArg(decodeURIComponent(segment)))
        .filter((v) => v !== "");
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
