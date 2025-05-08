const { CommandUnavailable } = require("./subprocess/command_unavailable");
const { termuxNotification } = require("./executables");


class NotificationsUnavailable extends CommandUnavailable {
    constructor() {
        super(
            "Notifications unavailable. Termux notification executable not found in $PATH. Please ensure that Termux:API is installed and available in your $PATH."
        );
    }
}

/**
 * Ensures that the termux-notification executable exists in the PATH.
 */
async function ensureNotificationsAvailable() {
    try {
        await termuxNotification.ensureAvailable();
    } catch (error) {
        if (error instanceof CommandUnavailable) {
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
    ensureNotificationsAvailable,
    notifyAboutError,
    notifyAboutWarning,
};
