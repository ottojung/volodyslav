/** 
 * The purpose of this module is provide better error messages for the
 * users of Volodyslav.
 * 
 * It is a wrapper around the main entry point of the application.
 * It catches any User errors that are thrown and logs them to the console.
 * 
 */

const { logError } = require("./logger");

/**
 * @param {Function} fn - The function to be wrapped.
 * @param {Array<(err: Error) => boolean>} errorsList - The list of predicates to check errors against.
 * @returns {Function} - The wrapped function.
 */
function gentleWrap(fn, errorsList) {
    /**
     * Custom error class for user errors.
     * The type of the ...args is:
     * @param {...*} args - The arguments passed to the wrapped function.
     */
    function wrapped(...args) {
        try {
            return fn(...args);
        } catch (e) {
            if (e instanceof Error && errorsList.some(predicate => predicate(e))) {
                // If the error is a user error, log it to the console.
                logError({ message: e.message }, e.message);
                process.exit(1);
            } else {
                throw e;
            }
        }
    }

    return wrapped;
}

module.exports = gentleWrap;
