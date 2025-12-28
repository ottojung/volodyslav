
class UnchangedClass {}

/** @typedef {UnchangedClass} Unchanged */

/** @type {Unchanged | null} */
let instance = null;

/**
 *
 * @param {unknown} value
 * @returns {value is Unchanged}
 */
function isUnchanged(value) {
    return value instanceof UnchangedClass;
}

function makeUnchanged() {
    if (instance === null) {
        instance = new UnchangedClass();
    }
    return instance;
}

module.exports = {
    isUnchanged,
    makeUnchanged,
};
