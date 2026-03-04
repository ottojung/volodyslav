/**
 * Shared mutex functor for gitstore operations.
 *
 * Both checkpoint() and transaction() acquire the per-workingPath mutex via
 * this functor so that the two entry points are mutually exclusive for any
 * given local repository path.
 */

const { makeUniqueFunctor } = require("../unique_functor");

/** @typedef {import('../unique_functor').UniqueTerm} UniqueTerm */

/**
 * Module-level functor for gitstore operations.
 * Instantiate with [workingPath] to get a per-path mutex key.
 */
const gitStoreFunctor = makeUniqueFunctor("gitstore-operation");

/**
 * Returns a UniqueTerm that acts as the mutex key for the given workingPath.
 * Both checkpoint() and transaction() call this so they share the same lock.
 *
 * @param {string} workingPath
 * @returns {UniqueTerm}
 */
function gitStoreMutexKey(workingPath) {
    return gitStoreFunctor.instantiate([workingPath]);
}

module.exports = {
    gitStoreMutexKey,
};
