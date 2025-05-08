const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const memoizeOne = require("memoize-one").default;
const { CommandUnavailable } = require("./command_unavailable");

/**
 * Internal function to resolve the path to the command executable.
 *
 * @param {string} command - The command to resolve.
 * @returns {Promise<string|null>} - The path to the command executable or null if not found.
 */
async function tryResolvePathInternal(command) {
    try {
        const result = await callSubprocess("which", ["--", command], {});
        const stdout = result.stdout;
        if (!stdout || !stdout.trim()) {
            return null;
        }

        return stdout.trim();
    } catch (error) {
        return null;
    }
}

/**
 * This function resolves the path to the command executable.
 *
 * @type {(command: string) => Promise<string|null>} - The path to the command executable or null if not found.
 */
const tryResolvePath = memoizeOne(tryResolvePathInternal);

/**
 * Ensures that the command executable exists in the PATH.
 *
 * @param {string} command - The command to resolve.
 * @returns {Promise<string>} - The path to the command executable.
 * @throws {CommandUnavailable} - If the command is unavailable.
 */
async function resolvePath(command) {
    const path = await tryResolvePath(command);
    if (!path) {
        throw new CommandUnavailable(command);
    }
    return path;
}

/**
 * Executes a subprocess and returns a promise with the result.
 *
 * @param {string} command - The command to execute.
 * @param {string[]} args - The arguments to pass to the command.
 * @param {import('child_process').ExecFileOptions} options - Options for the subprocess.
 * @returns {Promise<{ stdout: string, stderr: string }>} - The result of the subprocess execution.
 */
const callSubprocess = promisify(execFile);

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
 * @typedef {CommandClass} Command
 */

/**
 * Registers a subprocess command.
 *
 * @param {string} command - The command to register.
 * @returns {Command}
 */
function registerCommand(command) {
    const commandClass = new CommandClass(command);
    return commandClass;
}

module.exports = { registerCommand };
