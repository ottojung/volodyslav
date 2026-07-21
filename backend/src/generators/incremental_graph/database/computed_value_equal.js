const { dequal } = require('dequal');

/** @typedef {import('./types').ComputedValue} ComputedValue */

/**
 * Compare computed values using the graph cache's semantic old-value equality.
 *
 * Equality decides only whether two cached values would provide the same
 * semantic `oldValue` to a computor. It does not establish freshness,
 * provenance, or validity-proof transport.
 * @param {ComputedValue} left
 * @param {ComputedValue} right
 * @returns {boolean}
 */
function isEqual(left, right) {
    return dequal(left, right);
}

module.exports = { isEqual };
