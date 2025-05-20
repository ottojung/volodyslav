/**
 * The purpose of this module is provide better error messages for the
 * users of Volodyslav.
 *
 * It is a wrapper around the main entry point of the application.
 * It catches any User errors that are thrown and logs them to the console.
 *
 */

const userErrors = require("./user_errors");
/** @typedef {import("./logger").Logger} Logger */

/**
 * @template T
 * @param {() => Promise<T>} fn - The function to be wrapped.
 * @param {Logger} logger - The logger capability to use.
 * @param {Array<(err: unknown) => boolean>} [errorsList] - The list of predicates to check errors against.
 * @returns {Promise<T>} - The wrapped function.
 */
async function gentleCall(fn, logger, errorsList) {
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
            logger.logError({}, message);
            process.exit(1);
        } else {
            throw e;
        }
    }
}

/**
 * @template T
 * @param {() => Promise<T>} fn - The function to be wrapped.
 * @param {Logger} logger - The logger capability to use.
 * @param {Array<(err: unknown) => boolean>} [errorsList] - The list of predicates to check errors against.
 * @returns {() => Promise<T>}
 */
function gentleWrap(fn, logger, errorsList) {
    return () => gentleCall(fn, logger, errorsList);
}

module.exports = {
    gentleWrap,
    gentleCall,
};
