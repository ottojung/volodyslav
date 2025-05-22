/**
 * The purpose of this module is provide better error messages for the
 * users of Volodyslav.
 *
 * It is a wrapper around the main entry point of the application.
 * It catches any User errors that are thrown and logs them to the console.
 *
 */

/** @typedef {import('./logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {Logger} logger - A logger instance.
 */

/**
 * @template T
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {() => Promise<T>} fn - The function to be wrapped.
 * @param {Array<(err: unknown) => boolean>} [errorsList] - The list of predicates to check errors against.
 * @returns {Promise<T>} - The wrapped function.
 */
async function gentleCall(capabilities, fn, errorsList) {
    const userErrors = require("./user_errors");

    if (errorsList === undefined) {
        errorsList = userErrors;
    }

    try {
        return await fn();
    } catch (e) {
        if (errorsList.some((predicate) => predicate(e))) {
            // If the error is a user error, log it to the console.
            const message =
                e instanceof Object && e !== null && "message" in e
                    ? String(e.message)
                    : String(e);
            capabilities.logger.logError({}, message);
            process.exit(1);
        } else {
            throw e;
        }
    }
}

/**
 * @template T
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {() => Promise<T>} fn - The function to be wrapped.
 * @param {Array<(err: unknown) => boolean>} [errorsList] - The list of predicates to check errors against.
 * @returns {() => Promise<T>}
 */
function gentleWrap(capabilities, fn, errorsList) {
    return () => gentleCall(capabilities, fn, errorsList);
}

module.exports = {
    gentleWrap,
    gentleCall,
};
