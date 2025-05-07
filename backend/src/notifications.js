const { execFile } = require('child_process');

/**
 * Sends an error notification using termux-notification.
 * @param {string} message - The error message to display.
 */
function notifyAboutError(message) {
    execFile('termux-notification', ['-t', 'Error', '-c', message]);
}

/**
 * Sends a warning notification using termux-notification.
 * @param {string} message - The warning message to display.
 */
function notifyAboutWarning(message) {
    execFile('termux-notification', ['-t', 'Warning', '-c', message]);
}

module.exports = {
    notifyAboutError,
    notifyAboutWarning
};
