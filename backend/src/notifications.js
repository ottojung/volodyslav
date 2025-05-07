const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

class TermuxNotificationError extends Error {
    constructor() {
        super(
            "Termux notification executable not found in PATH. Please ensure that termux-notification is installed and available in your PATH."
        );
    }
}

/**
 * Internal function to resolve the path to the termux-notification executable.
 *
 * @returns {Promise<string|null>} - The path to the termux-notification executable or null if not found.
 */
async function resolveTermuxNotificationPathInternal() {
    try {
        const result = await execFileAsync(
            "command",
            ["-v", "termux-notification"],
            { encoding: "utf-8" }
        );
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
 * This function resolves the path to the termux-notification executable.
 *
 * @type {() => Promise<string|null>} - The path to the termux-notification executable or null if not found.
 */
const tryResolveTermuxNotificationPath = (() => {
    /** @type {string|null|undefined} */
    let memoizedTermuxNotificationPath = undefined;
    async function resolveTermuxNotificationPath() {
        if (memoizedTermuxNotificationPath === null) {
            memoizedTermuxNotificationPath =
                await resolveTermuxNotificationPathInternal();
        }
        return memoizedTermuxNotificationPath;
    }
    return resolveTermuxNotificationPath;
})();

async function resolveTermuxNotificationPath() {
    const path = await tryResolveTermuxNotificationPath();
    if (!path) {
        throw new TermuxNotificationError();
    }
    return path;
}

/**
 * Ensures that the termux-notification executable exists in the PATH.
 */
async function ensureNotificationsAvailable() {
    await resolveTermuxNotificationPath();
}

/**
 * Sends an error notification using termux-notification.
 * @param {string} message - The error message to display.
 */
async function notifyAboutError(message) {
    const termuxNotificationPath = await resolveTermuxNotificationPath();
    await execFileAsync(termuxNotificationPath, ["-t", "Error", "-c", message]);
}

/**
 * Sends a warning notification using termux-notification.
 * @param {string} message - The warning message to display.
 */
async function notifyAboutWarning(message) {
    const termuxNotificationPath = await resolveTermuxNotificationPath();
    await execFileAsync(termuxNotificationPath, ["-t", "Warning", "-c", message]);
}

module.exports = {
    ensureNotificationsAvailable,
    notifyAboutError,
    notifyAboutWarning,
};
