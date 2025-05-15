const { callSubprocess } = require("./call");
const memoize = require("@emotion/memoize").default;

class CommandUnavailable extends Error {
    /** @type {string} */
    command;

    /**
     * @param {string} command - The command that is unavailable.
     */
    constructor(command) {
        super(
            `Command ${command} unavailable, its executable not found in $PATH. Please ensure that respective program is installed and available in your $PATH.`
        );
        this.command = command;
    }
}

/**
 * @param {unknown} object
 * @returns {object is CommandUnavailable}
 */
function isCommandUnavailable(object) {
    return object instanceof CommandUnavailable;
}

/**
 * Internal function to resolve the path to the command executable.
 *
 * @param {string} command - The command to resolve.
 * @returns {Promise<string|null>} - The path to the command executable or null if not found.
 */
async function tryResolvePathInternal(command) {
    try {
        const result = await callSubprocess(`command -v ${command}`, { shell: true });
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
const tryResolvePath = memoize(tryResolvePathInternal);

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

module.exports = {
    resolvePath,
    isCommandUnavailable,
};
