/**
 * Logger utility for the DescriptionEntry component
 * This allows for controlled logging that can be mocked during tests
 */

export const logger = {
    error: (/** @type {unknown} */ message, /** @type {unknown[]} */ ...args) => {
        console.error(message, ...args);
    },
    warn: (/** @type {unknown} */ message, /** @type {unknown[]} */ ...args) => {
        console.warn(message, ...args);
    },
    info: (/** @type {unknown} */ message, /** @type {unknown[]} */ ...args) => {
        console.info(message, ...args);
    },
    debug: (/** @type {unknown} */ message, /** @type {unknown[]} */ ...args) => {
        console.debug(message, ...args);
    }
};
