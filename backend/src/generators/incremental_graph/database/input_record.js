/**
 * Shared utility for reading persisted inputs records.
 *
 * The canonical storage format for `inputs[N]` is `NodeIdentifier[]`.
 * This module validates that the stored record matches the expected shape.
 * Malformed records are rejected with a thrown error.
 */

/**
 * @param {unknown} record
 * @returns {import('./types').NodeIdentifier[]}
 */
function readInputRecord(record) {
    if (record === undefined) return [];
    if (Array.isArray(record)) return record;
    throw new Error(
        `Malformed inputs record: expected NodeIdentifier[] or undefined, got ${typeof record}`
    );
}

module.exports = { readInputRecord };
