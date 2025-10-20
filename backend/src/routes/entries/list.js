const { getEntries } = require("../../entry");
const { serialize } = require("../../event");

/**
 * @typedef {import('../../environment').Environment} Environment
 * @typedef {import('../../logger').Logger} Logger
 * @typedef {import('../../random/seed').NonDeterministicSeed} NonDeterministicSeed
 * @typedef {import('../../filesystem/deleter').FileDeleter} FileDeleter
 * @typedef {import('../../filesystem/copier').FileCopier} FileCopier
 * @typedef {import('../../filesystem/writer').FileWriter} FileWriter
 * @typedef {import('../../filesystem/appender').FileAppender} FileAppender
 * @typedef {import('../../filesystem/creator').FileCreator} FileCreator
 * @typedef {import('../../filesystem/checker').FileChecker} FileChecker
 * @typedef {import('../../subprocess/command').Command} Command
 * @typedef {import('../../event/structure').SerializedEvent} SerializedEvent
 * @typedef {import('../../sleeper').SleepCapability} SleepCapability
 */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {import('../../filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('../../datetime').Datetime} datetime - Datetime utilities.
 * @property {SleepCapability} sleeper - A sleeper instance for delays.
 */

/**
 * @typedef {object} PaginationParams
 * @property {number} page - The current page number (1-based)
 * @property {number} limit - The number of items per page
 * @property {'dateAscending'|'dateDescending'} order - The order to sort entries by date
 */

/**
 * Parses pagination parameters from query string.
 *
 * @param {import('express').Request['query']} query - The request query object.
 * @returns {PaginationParams} - The parsed pagination parameters.
 */
function parsePaginationParams(query) {
    const pageRaw = query["page"];
    const limitRaw = query["limit"];
    const orderRaw = query["order"];

    const page = Math.max(
        1,
        parseInt(
            pageRaw !== undefined
                ? String(Array.isArray(pageRaw) ? pageRaw[0] : pageRaw)
                : "1",
            10
        ) || 1
    );

    const limit = Math.max(
        1,
        Math.min(
            100,
            parseInt(
                limitRaw !== undefined
                    ? String(Array.isArray(limitRaw) ? limitRaw[0] : limitRaw)
                    : "20",
                10
            ) || 20
        )
    );

    const orderStr = orderRaw !== undefined
        ? String(Array.isArray(orderRaw) ? orderRaw[0] : orderRaw)
        : "dateDescending";

    const order =
        orderStr === 'dateAscending' || orderStr === 'dateDescending'
            ? orderStr
            : 'dateDescending';

    return { page, limit, order };
}

/**
 * Builds the next page URL if more results exist.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {PaginationParams} pagination - The current pagination parameters.
 * @param {boolean} hasMore - Whether there are more results available.
 * @returns {string|null} - The next page URL or null if no more results.
 */
function buildNextPageUrl(req, pagination, hasMore) {
    if (!hasMore) {
        return null;
    }

    const url = new URL(
        req.protocol + "://" + req.get("host") + req.originalUrl.split("?")[0]
    );
    url.searchParams.set("page", String(pagination.page + 1));
    url.searchParams.set("limit", String(pagination.limit));
    url.searchParams.set("order", pagination.order);

    return url.toString();
}

/**
 * Handles the GET /entries logic.
 * @param {import('express').Request} req
 * @param {import('express').Response} res - Responds with EntriesListResponse on success or EntriesListErrorResponse on error
 * @param {Capabilities} capabilities
 * @param {import('../../request_identifier').RequestIdentifier} reqId - Request identifier for tracking
 */
async function handleEntriesGet(req, res, capabilities, reqId) {
    try {
        const pagination = parsePaginationParams(req.query);
        const result = await getEntries(capabilities, pagination);
        const next = buildNextPageUrl(req, pagination, result.hasMore);

        res.json({
            /** @type {Array<import('../../event/structure').SerializedEvent>} */
            results: result.results.map(event => serialize(capabilities, event)),
            next,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                error: message,
                error_name: error instanceof Error ? error.name : "Unknown",
                stack: error instanceof Error ? error.stack : undefined,
                query: req.query,
                client_ip: req.ip
            },
            `Failed to fetch entries: ${message}`,
        );

        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                status_code: 500,
                client_ip: req.ip
            },
            "Entries list request completed with status 500",
        );

        res.status(500).json({
            error: "Internal server error",
        });
    }
}

module.exports = {
    parsePaginationParams,
    buildNextPageUrl,
    handleEntriesGet,
};
