/**
 * Logger utility for the DescriptionEntry component
 * This allows for controlled logging that can be mocked during tests
 */

export const logger = {
    error: (/** @type {any} */ message, /** @type {any[]} */ ...args) => {
        console.error(message, ...args);
    },
    warn: (/** @type {any} */ message, /** @type {any[]} */ ...args) => {
        console.warn(message, ...args);
    },
    info: (/** @type {any} */ message, /** @type {any[]} */ ...args) => {
        console.info(message, ...args);
    },
    debug: (/** @type {any} */ message, /** @type {any[]} */ ...args) => {
        console.debug(message, ...args);
    }
};
