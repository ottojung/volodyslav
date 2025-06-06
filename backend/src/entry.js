const { transaction } = require("./event_log_storage");
const eventId = require("./event/id");
const asset = require("./event/asset");
const creatorMake = require("./creator");

/** @typedef {import('./event/asset').Asset} Asset */
/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('./filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('./filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('./filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('./filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('./filesystem/file').ExistingFile} ExistingFile */
/** @typedef {import('./filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('./subprocess/command').Command} Command */
/** @typedef {import('./environment').Environment} Environment */
/** @typedef {import('./logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance.
 */

/**
 * @typedef {object} EntryData
 * @property {string} [date] - ISO date string, defaults to current time
 * @property {string} original - The original, raw input for the event
 * @property {string} input - The processed input for the event
 * @property {string} type - The type of entry (e.g., "note", "diary", "todo")
 * @property {string} [description] - The content/description of the entry
 * @property {Record<string, string>} [modifiers] - Additional key-value modifiers
 */

/**
 * Creates a new entry in the event log.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {EntryData} entryData - The entry data from the HTTP request.
 * @param {ExistingFile[]} [files] - Optional file attachments.
 * @returns {Promise<import('./event/structure').Event>} - The created event.
 */
async function createEntry(capabilities, entryData, files = []) {
    const creator = await creatorMake(capabilities);
    const id = eventId.make(capabilities);
    const date = entryData.date ? new Date(entryData.date) : new Date();

    /** @type {import('./event/structure').Event} */
    const event = {
        id,
        date,
        original: entryData.original,
        input: entryData.input,
        modifiers: entryData.modifiers || {},
        type: entryData.type,
        description: entryData.description,
        creator,
    };

    const assets = files.map((file) => asset.make(event, file));

    await transaction(capabilities, async (eventLogStorage) => {
        eventLogStorage.addEntry(event, assets);
    });

    capabilities.logger.logInfo(
        {
            eventId: event.id,
            type: event.type,
            fileCount: files.length,
        },
        `Entry created: ${event.type} with ${files.length} file(s)`
    );

    return event;
}

/**
 * @typedef {object} PaginationParams
 * @property {number} page - The current page number (1-based)
 * @property {number} limit - The number of items per page
 */

/**
 * @typedef {object} PaginationResult
 * @property {import('./event/structure').Event[]} results - The paginated entries (Event structures)
 * @property {number} total - Total number of entries
 * @property {boolean} hasMore - Whether there are more pages available
 * @property {number} page - Current page number
 * @property {number} limit - Items per page
 */

/**
 * Retrieves entries from the event log with pagination support.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {PaginationParams} pagination - Pagination parameters.
 * @returns {Promise<PaginationResult>} - The paginated entries result.
 */
async function getEntries(capabilities, pagination) {
    const { page, limit } = pagination;

    // Fetch all entries from storage
    const entries = await transaction(capabilities, async (storage) => {
        return await storage.getExistingEntries();
    });

    // Apply pagination
    const total = entries.length;
    const start = (page - 1) * limit;
    const end = start + limit;
    const results = entries.slice(start, end);
    const hasMore = end < total;

    capabilities.logger.logInfo(
        {
            total,
            page,
            limit,
            resultCount: results.length,
            hasMore,
        },
        `Retrieved entries: page ${page}, ${results.length}/${total} entries`
    );

    return {
        results,
        total,
        hasMore,
        page,
        limit,
    };
}

module.exports = { createEntry, getEntries };
