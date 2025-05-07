const { callSubprocess } = require("./subprocess");
const memoizeOne = require("memoize-one").default;

class NotificationsUnavailable extends Error {
    constructor() {
        super(
            "Notifications unavailable. Termux notification executable not found in $PATH. Please ensure that Termux:API is installed and available in your $PATH."
        );
    }
}

/**
 * Internal function to resolve the path to the termux-notification executable.
 *
 * @returns {Promise<string|null>} - The path to the termux-notification executable or null if not found.
 */
async function tryResolveTermuxNotificationPathInternal() {
    try {
        const result = await callSubprocess(
            "command",
            ["-v", "termux-notification"],
            {},
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
const tryResolveTermuxNotificationPath = memoizeOne(tryResolveTermuxNotificationPathInternal);

async function resolveTermuxNotificationPath() {
    const path = await tryResolveTermuxNotificationPath();
    if (!path) {
        throw new NotificationsUnavailable();
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
    await callSubprocess(termuxNotificationPath, ["-t", "Error", "-c", message], {});
}

/**
 * Sends a warning notification using termux-notification.
 * @param {string} message - The warning message to display.
 */
async function notifyAboutWarning(message) {
    const termuxNotificationPath = await resolveTermuxNotificationPath();
    await callSubprocess(termuxNotificationPath, [
        "-t",
        "Warning",
        "-c",
        message,
    ], {});
}

module.exports = {
    ensureNotificationsAvailable,
    notifyAboutError,
    notifyAboutWarning,
};
