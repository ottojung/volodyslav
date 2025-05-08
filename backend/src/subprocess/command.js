const { resolvePath } = require("./resolve_executable_path");
const { callSubprocess } = require("./call");

/**
 * @typedef {CommandClass} Command
 */

/**
 * @class
 */
class CommandClass {
    /** @type {string} */
    command;

    /**
     * @param {string} command - The command to execute.
     */
    constructor(command) {
        this.command = command;
    }

    /**
     * Executes the command with the given arguments and options.
     *
     * @param {string[]} args - The arguments to pass to the command.
     * @returns {Promise<{ stdout: string, stderr: string }>} - The result of the subprocess execution.
     */
    async call(...args) {
        const commandPath = await resolvePath(this.command);
        const options = {};
        return callSubprocess(commandPath, args, options);
    }

    /**
     * Ensures that the command executable exists in the PATH.
     *
     * @returns {Promise<void>} - Resolves if the command is available, rejects if not.
     * @throws {CommandUnavailable} - If the command is unavailable.
     */
    async ensureAvailable() {
        await resolvePath(this.command);
    }
}

/**
 * Registers a subprocess command.
 *
 * @param {string} command - The command to register.
 * @returns {Command}
 */
function registerCommand(command) {
    return new CommandClass(command);
}

module.exports = { 
    registerCommand,
};
