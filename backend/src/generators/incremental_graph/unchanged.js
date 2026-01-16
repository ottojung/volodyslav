
class UnchangedClass {}

/** @typedef {UnchangedClass} Unchanged */

/** @type {Unchanged} */
const instance = new UnchangedClass();

/**
 *
 * @param {unknown} value
 * @returns {value is Unchanged}
 */
function isUnchanged(value) {
    return value instanceof UnchangedClass;
}

function makeUnchanged() {
    return instance;
}

module.exports = {
    isUnchanged,
    makeUnchanged,
};
