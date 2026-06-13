/**
 * Shared utility for normalising persisted inputs records.
 *
 * The canonical storage format for `inputs[N]` is `NodeIdentifier[]`.
 * Existing data may still be in the old `{inputs: string[], inputCounters: number[]}`
 * object format.  This module exposes a single pure function that accepts either
 * representation and returns a `NodeIdentifier[]`.
 *
 * Placed outside `graph_state.js` to avoid circular dependencies:
 * database/ submodules import this directly without requiring graph_state.
 */

const { unsafeStringToNodeIdentifier } = require('./types');

/**
 * @param {unknown} record
 * @returns {import('./types').NodeIdentifier[]}
 */
function normalizeInputRecord(record) {
    if (Array.isArray(record)) return record;
    if (typeof record === 'object' && record !== null) {
        for (const key of Object.keys(record)) {
            if (key === 'inputs') {
                const value = Reflect.get(record, key);
                if (Array.isArray(value)) {
                    /** @type {import('./types').NodeIdentifier[]} */
                    const result = [];
                    for (const v of value) {
                        result.push(unsafeStringToNodeIdentifier(String(v)));
                    }
                    return result;
                }
            }
        }
    }
    return [];
}

module.exports = { normalizeInputRecord };
