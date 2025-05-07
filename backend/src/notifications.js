const { execFile } = require("child_process");


/**
 * This function resolves the path to the termux-notification executable.
 *
 * @returns {string|null} - The path to the termux-notification executable or null if not found.
 */
const resolveTermuxNotificationPath = (() => {
    /** @type {Promise<string|null>|null} */
    let memoizedTermuxNotificationPath = null;

    /**
     * Internal function to resolve the path to the termux-notification executable.
     *
     * @returns {Promise<string|null>} - The path to the termux-notification executable or null if not found.
     */
    async function resolveTermuxNotificationPathInternal() {
        try {
            const process = execFile("command", ["-v", "termux-notification"], { encoding: "utf-8" });
            if (process.exitCode !== 0) {
                return null;
            }
            const stdout = process.stdout;
            if (stdout === null) {
                return null;
            }
            const text = stdout.read();
            return text.trim();
        } catch (error) {
            return null;
        }
    }

    return async function resolveTermuxNotificationPath() {
        if (memoizedTermuxNotificationPath === null) {
            memoizedTermuxNotificationPath = resolveTermuxNotificationPathInternal();
        }
        return memoizedTermuxNotificationPath;
    };
})();


class TermuxNotificationError extends Error {
    constructor() {
        super(
            "Termux notification executable not found in PATH. Please ensure that termux-notification is installed and available in your PATH."
        );
    }
}

/**
 * Ensures that the termux-notification executable exists in the PATH.
 */
function ensureTermuxNotificationExists() {
    const termuxNotificationPath = resolveTermuxNotificationPath();
    if (!termuxNotificationPath) {
        throw new TermuxNotificationError();
    }
}

/**
 * Sends an error notification using termux-notification.
 * @param {string} message - The error message to display.
 */
function notifyAboutError(message) {
    execFile("termux-notification", ["-t", "Error", "-c", message]);
}

/**
 * Sends a warning notification using termux-notification.
 * @param {string} message - The warning message to display.
 */
function notifyAboutWarning(message) {
    execFile("termux-notification", ["-t", "Warning", "-c", message]);
}

module.exports = {
    ensureTermuxNotificationExists,
    notifyAboutError,
    notifyAboutWarning,
};
