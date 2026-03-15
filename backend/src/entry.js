const { transaction } = require("./event_log_storage");
const event = require("./event");
const eventId = event.id;
const asset = event.asset;
const { getType, getDescription } = require("./event");
const creatorMake = require("./creator");

/**
 * Error thrown when entry data validation fails due to user input issues.
 * This should result in a 400 Bad Request response.
 */
class EntryValidationError extends Error {
    /**
     * @param {string} message - The validation error message
     */
    constructor(message) {
        super(message);
        this.name = "EntryValidationError";
    }
}

/**
 * Factory for EntryValidationError.
 * @param {string} message - The validation error message
 * @returns {EntryValidationError}
 */
function makeEntryValidationError(message) {
    return new EntryValidationError(message);
}

/**
 * Type guard for EntryValidationError.
 * @param {unknown} object
 * @returns {object is EntryValidationError}
 */
function isEntryValidationError(object) {
    return object instanceof EntryValidationError;
}

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
/** @typedef {import('./sleeper').SleepCapability} SleepCapability */
/** @typedef {import('./generators').Interface} Interface */

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
 * @property {import('./datetime').Datetime} datetime - Datetime utilities.
 * @property {SleepCapability} sleeper - A sleeper instance for delays.
 * @property {Interface} interface - The incremental graph interface capability.
 */

/**
 * @typedef {object} EntryData
 * @property {string} original - The original, raw input for the event
 * @property {string} input - The processed input for the event
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
    const date = capabilities.datetime.now();

    /** @type {import('./event/structure').Event} */
    const event = {
        id,
        date,
        original: entryData.original,
        input: entryData.input,
        creator,
    };

    const assets = files.map((file) => asset.make(event, file));

    await transaction(capabilities, async (eventLogStorage) => {
        eventLogStorage.addEntry(event, assets);
    });

    capabilities.logger.logInfo(
        {
            eventId: eventId.toString(event.id),
            type: getType(event),
            fileCount: files.length,
        },
        `Entry created: ${getType(event)} with ${files.length} file(s)`
    );

    return event;
}

/**
 * @typedef {object} PaginationParams
 * @property {number} page - The current page number (1-based)
 * @property {number} limit - The number of items per page
 * @property {'dateAscending'|'dateDescending'} [order] - The order to sort entries by date
 * @property {string} [search] - Optional regex to filter entries by type or description
 */

/**
 * @typedef {object} PaginationResult
 * @property {import('./event/structure').Event[]} results - The paginated entries (Event structures)
 * @property {boolean} hasMore - Whether there are more pages available
 * @property {number} page - Current page number
 * @property {number} limit - Items per page
 * @property {'dateAscending'|'dateDescending'} order - The order entries were sorted by
 */

/**
 * Retrieves entries from the event log with pagination support.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {PaginationParams} pagination - Pagination parameters.
 * @returns {Promise<PaginationResult>} - The paginated entries result.
 */
async function getEntries(capabilities, pagination) {
    const { page, limit, order = 'dateDescending', search } = pagination;

    if (!Number.isInteger(page) || page < 1) {
        throw new EntryValidationError('page must be a positive integer');
    }
    if (!Number.isInteger(limit) || limit < 1) {
        throw new EntryValidationError('limit must be a positive integer');
    }
    if (!['dateAscending', 'dateDescending'].includes(order)) {
        throw new EntryValidationError('order must be either "dateAscending" or "dateDescending"');
    }

    /** @type {RegExp|null} */
    let searchRegex = null;
    if (search !== undefined && search !== '') {
        try {
            searchRegex = new RegExp(search, 'i');
        } catch {
            throw new EntryValidationError('search must be a valid regular expression');
        }
    }

    // ── Lazy iteration over sorted events ─────────────────────────────────────
    // For page 1 with no search filter the iterator serves its first
    // SORTED_EVENTS_CACHE_SIZE results from a small cache node, avoiding a
    // full read of the potentially-large sorted list.
    const entriesToSkip = (page - 1) * limit;
    let skipped = 0;

    /** @type {import('./event/structure').Event[]} */
    const results = [];

    for await (const entry of capabilities.interface.getSortedEvents(order)) {
        if (searchRegex !== null) {
            if (!searchRegex.test(getType(entry)) && !searchRegex.test(getDescription(entry))) {
                continue;
            }
        }

        if (skipped < entriesToSkip) {
            skipped++;
            continue;
        }

        results.push(entry);
        // Collect one extra entry to cheaply detect whether a next page exists.
        if (results.length >= limit + 1) {
            break;
        }
    }

    const hasMore = results.length > limit;
    if (hasMore) {
        results.pop();
    }

    capabilities.logger.logDebug(
        {
            page,
            limit,
            order,
            resultCount: results.length,
            hasMore,
        },
        `Retrieved entries: page ${page}, ${results.length} entries, order: ${order}`
    );

    return {
        results,
        hasMore,
        page,
        limit,
        order,
    };
}

/**
 * Deletes an entry from the event log by its id.
 *
 * @param {Capabilities} capabilities - The capabilities to use.
 * @param {import('./event/id').EventId} id - Identifier of the entry to delete.
 * @returns {Promise<void>} - Resolves when deletion is complete.
 */
async function deleteEntry(capabilities, id) {
    await transaction(capabilities, async (storage) => {
        storage.deleteEntry(id);
    });

    capabilities.logger.logInfo(
        { eventId: id },
        'Entry deleted'
    );
}

/**
 * Retrieves a single entry from the event log by its id.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {string} id - The identifier of the entry to retrieve.
 * @returns {Promise<import('./event/structure').Event|null>} - The entry, or null if not found.
 */
async function getEntryById(capabilities, id) {
    return await capabilities.interface.getEvent(id);
}

module.exports = {
    createEntry,
    getEntries,
    getEntryById,
    deleteEntry,
    makeEntryValidationError,
    isEntryValidationError,
};
