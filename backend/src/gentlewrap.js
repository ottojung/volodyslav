/**
 * The purpose of this module is provide better error messages for the
 * users of Volodyslav.
 *
 * It is a wrapper around the main entry point of the application.
 * It catches any User errors that are thrown and logs them to the console.
 *
 */

const { logError } = require("./logger");
const userErrors = require("./user_errors");

/**
 * @template T
 * @param {() => Promise<T>} fn - The function to be wrapped.
 * @param {Array<(err: Error) => boolean>} [errorsList] - The list of predicates to check errors against.
 * @returns {Promise<T>} - The wrapped function.
 */
async function gentleCall(fn, errorsList) {
    if (errorsList === undefined) {
        errorsList = userErrors;
    }

    try {
        return await fn();
    } catch (e) {
        if (
            e instanceof Error &&
            errorsList.some((predicate) => predicate(e))
        ) {
            // If the error is a user error, log it to the console.
            logError({}, e.message);
            process.exit(1);
        } else {
            throw e;
        }
    }
}

/**
 * @template T
 * @param {() => Promise<T>} fn - The function to be wrapped.
 * @param {Array<(err: Error) => boolean>} [errorsList] - The list of predicates to check errors against.
 * @returns {() => Promise<T>}
 */
function gentleWrap(fn, errorsList) {
    return () => gentleCall(fn, errorsList);
}

module.exports = {
    gentleWrap,
    gentleCall,
};
