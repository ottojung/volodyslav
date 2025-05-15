const { isCommandUnavailable } = require("./subprocess");
const { termuxNotification } = require("./executables");

class NotificationsUnavailable extends Error {
    constructor() {
        super(
            "Notifications unavailable. Termux notification executable not found in $PATH. Please ensure that Termux:API is installed and available in your $PATH."
        );
    }
}

/**
 * @param {unknown} object
 * @returns {object is NotificationsUnavailable}
 */
function isNotificationsUnavailable(object) {
    return object instanceof NotificationsUnavailable;
}

/**
 * Ensures that the termux-notification executable exists in the PATH.
 */
async function ensureNotificationsAvailable() {
    try {
        await termuxNotification.ensureAvailable();
    } catch (error) {
        if (isCommandUnavailable(error)) {
            throw new NotificationsUnavailable();
        }
        throw error;
    }
}

/**
 * Sends an error notification using termux-notification.
 * @param {string} message - The error message to display.
 */
async function notifyAboutError(message) {
    await termuxNotification.call("-t", "Error", "-c", message);
}

/**
 * Sends a warning notification using termux-notification.
 * @param {string} message - The warning message to display.
 */
async function notifyAboutWarning(message) {
    await termuxNotification.call("-t", "Warning", "-c", message);
}

module.exports = {
    isNotificationsUnavailable,
    ensureNotificationsAvailable,
    notifyAboutError,
    notifyAboutWarning,
};
