/**
 * Logger utility for the DescriptionEntry component
 * This allows for controlled logging that can be mocked during tests
 */

export const logger = {
    /**
     * Log an error message.
     * @param {*} message
     * @param {...*} args
     */
    error: (message, ...args) => {
        console.error(message, ...args);
    },
    /**
     * Log a warning message.
     * @param {*} message
     * @param {...*} args
     */
    warn: (message, ...args) => {
        console.warn(message, ...args);
    },
    /**
     * Log an info message.
     * @param {*} message
     * @param {...*} args
     */
    info: (message, ...args) => {
        console.info(message, ...args);
    },
    /**
     * Log a debug message.
     * @param {*} message
     * @param {...*} args
     */
    debug: (message, ...args) => {
        console.debug(message, ...args);
    }
};
