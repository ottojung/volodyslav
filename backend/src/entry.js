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
 */

/**
 * @typedef {object} EntryData
 * @property {string} [date] - ISO date string, defaults to current time
 * @property {string} type - The type of entry (e.g., "note", "diary", "todo")
 * @property {string} description - The content/description of the entry
 * @property {Record<string, string>} [modifiers] - Additional key-value modifiers
 */

/**
 * Creates a new entry in the event log.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {EntryData} entryData - The entry data from the HTTP request.
 * @param {ExistingFile} [file] - Optional file attachment.
 * @returns {Promise<import('./event/structure').Event>} - The created event.
 */
async function createEntry(capabilities, entryData, file) {
    const creator = await creatorMake(capabilities);
    const id = eventId.make(capabilities);
    const date = entryData.date ? new Date(entryData.date) : new Date();

    /** @type {import('./event/structure').Event} */
    const event = {
        id,
        date,
        original: entryData.description,
        input: entryData.description,
        modifiers: entryData.modifiers || {},
        type: entryData.type,
        description: entryData.description,
        creator,
    };

    const assets = file ? [asset.make(event, file)] : [];

    await transaction(capabilities, async (eventLogStorage) => {
        eventLogStorage.addEntry(event, assets);
    });

    capabilities.logger.logInfo(
        {
            eventId: event.id,
            type: event.type,
            hasFile: !!file,
        },
        `Entry created: ${event.type}`
    );

    return event;
}

module.exports = { createEntry };
