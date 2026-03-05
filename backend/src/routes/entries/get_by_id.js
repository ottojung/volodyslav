const { getEntryById } = require("../../entry");
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
 * @typedef {import('../../generators').Interface} Interface
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
 * @property {Interface} interface - The incremental graph interface capability.
 */

/**
 * Handles the GET /entries/:id logic.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Capabilities} capabilities
 * @param {import('../../request_identifier').RequestIdentifier} reqId
 */
async function handleEntryGetById(req, res, capabilities, reqId) {
    const { id } = req.params;

    if (typeof id !== 'string' || id.trim() === '') {
        res.status(400).json({ error: 'Invalid entry id' });
        return;
    }

    try {
        const entry = await getEntryById(capabilities, id);

        if (entry === null) {
            res.status(404).json({ error: 'Entry not found' });
            return;
        }

        res.json({ entry: serialize(capabilities, entry) });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                error: message,
                error_name: error instanceof Error ? error.name : "Unknown",
                stack: error instanceof Error ? error.stack : undefined,
                entry_id: id,
                client_ip: req.ip
            },
            `Failed to fetch entry by id: ${message}`,
        );

        res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = { handleEntryGetById };
