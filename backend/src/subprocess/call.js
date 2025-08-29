const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

class ProcessFailedError extends Error {
    /**
     * @param {string} message
     * @param {unknown} [originalError]
     */
    constructor(message, originalError) {
        super(message);
        this.name = "ProcessFailedError";
        this.originalError = originalError;
    }
}

/**
 * @param {unknown} object
 * @returns {object is ProcessFailedError}
 */
function isProcessFailedError(object) {
    return object instanceof ProcessFailedError;
}

const callSubprocessPromise = promisify(execFile);

/**
 * Executes a subprocess and returns a promise with the result.
 *
 * @param {string} command - The command to execute.
 * @param {string[]} args - The arguments to pass to the command.
 * @returns {Promise<{ stdout: string, stderr: string }>} - The result of the subprocess execution.
 * @throws {ProcessFailedError} - If the subprocess fails to execute.
 */
async function callSubprocess(command, args) {
    try {
        return await callSubprocessPromise(command, args);
    } catch (error) {
        throw new ProcessFailedError(`Failed to execute subprocess: ${command}`, error);
    }
}

/**
 * Executes a shell expression and returns a promise with the result.
 *
 * @param {string} expression - The shell expression to execute.
 * @returns {Promise<{ stdout: string, stderr: string }>} - The result of the subprocess execution.
 * @throws {ProcessFailedError} - If the subprocess fails to execute.
 */
async function callShellSubprocess(expression) {
    try {
        return await callSubprocessPromise(expression, [], { shell: true });
    } catch (error) {
        throw new ProcessFailedError(`Failed to execute shell subprocess: ${expression}`, error);
    }
}

module.exports = {
    callSubprocess,
    callShellSubprocess,
    isProcessFailedError,
};
