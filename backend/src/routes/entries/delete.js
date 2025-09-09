const eventId = require("../../event/id");
const { deleteEntry } = require("../../entry");

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
 * Handles the DELETE /entries logic.
 * @param {import('express').Request} req
 * @param {import('express').Response} res - Responds with {success:boolean} on success or {error:string} on error
 * @param {Capabilities} capabilities
 * @param {import('../../request_identifier').RequestIdentifier} reqId - Request identifier for tracking
 */
async function handleEntryDelete(req, res, capabilities, reqId) {
    const rawId = req.query["id"];
    if (typeof rawId !== "string" || rawId.trim() === "") {
        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                error: "Missing id parameter",
                query: req.query,
                status_code: 400,
                client_ip: req.ip,
            },
            "Entry deletion failed - missing id",
        );
        return res.status(400).json({ error: "Missing id parameter" });
    }

    const idObj = eventId.fromString(String(rawId));

    try {
        await deleteEntry(capabilities, idObj);
        capabilities.logger.logInfo(
            {
                request_identifier: reqId.identifier,
                entry_id: idObj,
                status_code: 200,
                client_ip: req.ip,
            },
            "Entry deleted successfully",
        );
        return res.json({ success: true });
    } catch (error) {
        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                error: error instanceof Error ? error.message : String(error),
                error_name: error instanceof Error ? error.name : "Unknown",
                error_stack: error instanceof Error ? error.stack : undefined,
                client_ip: req.ip,
            },
            "Failed to delete entry",
        );
        return res.status(500).json({ error: "Internal server error" });
    }
}

module.exports = { handleEntryDelete };
