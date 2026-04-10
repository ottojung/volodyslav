/**
 * Core gentle-unification engine.
 *
 * Computes and applies a minimal mutation plan from a source store to a target
 * store.  Each call reads both stores' key sets once, compares values only for
 * keys that exist in both stores, and issues only the necessary puts and
 * deletes.
 *
 * Memory policy: O(|X| + |k1| + |k2|) where |X| is the size of the largest
 * single value, |k1| is the number of source keys, and |k2| is the number of
 * target keys.  Key sets are materialised once into Sets; values are read and
 * compared one at a time and are never accumulated.
 */

/**
 * Thrown when listing source or target keys fails.
 */
class UnificationListError extends Error {
    /**
     * @param {'source' | 'target'} side
     * @param {unknown} cause
     */
    constructor(side, cause) {
        super(`Failed to list ${side} keys: ${cause}`);
        this.name = 'UnificationListError';
        this.side = side;
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is UnificationListError}
 */
function isUnificationListError(object) {
    return object instanceof UnificationListError;
}

/**
 * Thrown when reading a value from the source or target fails.
 */
class UnificationReadError extends Error {
    /**
     * @param {'source' | 'target'} side
     * @param {string} key
     * @param {unknown} cause
     */
    constructor(side, key, cause) {
        super(`Failed to read ${side} key '${key}': ${cause}`);
        this.name = 'UnificationReadError';
        this.side = side;
        this.key = key;
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is UnificationReadError}
 */
function isUnificationReadError(object) {
    return object instanceof UnificationReadError;
}

/**
 * Thrown when writing (putting) a key to the target fails.
 */
class UnificationWriteError extends Error {
    /**
     * @param {string} key
     * @param {unknown} cause
     */
    constructor(key, cause) {
        super(`Failed to write target key '${key}': ${cause}`);
        this.name = 'UnificationWriteError';
        this.key = key;
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is UnificationWriteError}
 */
function isUnificationWriteError(object) {
    return object instanceof UnificationWriteError;
}

/**
 * Thrown when deleting a key from the target fails.
 */
class UnificationDeleteError extends Error {
    /**
     * @param {string} key
     * @param {unknown} cause
     */
    constructor(key, cause) {
        super(`Failed to delete target key '${key}': ${cause}`);
        this.name = 'UnificationDeleteError';
        this.key = key;
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is UnificationDeleteError}
 */
function isUnificationDeleteError(object) {
    return object instanceof UnificationDeleteError;
}

/**
 * Thrown when committing the adapter's buffered operations fails.
 */
class UnificationCommitError extends Error {
    /**
     * @param {unknown} cause
     */
    constructor(cause) {
        super(`Failed to commit unification: ${cause}`);
        this.name = 'UnificationCommitError';
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is UnificationCommitError}
 */
function isUnificationCommitError(object) {
    return object instanceof UnificationCommitError;
}

/**
 * Result statistics returned by unifyStores().
 *
 * @typedef {object} UnificationStats
 * @property {number} sourceCount - Number of keys in the source.
 * @property {number} targetCount - Number of keys in the target before unification.
 * @property {number} putCount - Number of keys written to the target.
 * @property {number} deleteCount - Number of keys deleted from the target.
 * @property {number} unchangedCount - Number of keys that were already equal and not rewritten.
 */

/**
 * Adapter interface that every unification adapter must implement.
 *
 * @typedef {object} UnificationAdapter
 * @property {() => AsyncIterable<string>} listSourceKeys
 * @property {() => AsyncIterable<string>} listTargetKeys
 * @property {(key: string) => Promise<unknown>} readSource
 * @property {(key: string) => Promise<unknown>} readTarget
 * @property {(sourceValue: unknown, targetValue: unknown) => boolean} equals
 * @property {(key: string, value: unknown) => Promise<void>} putTarget
 * @property {(key: string) => Promise<void>} deleteTarget
 * @property {(() => Promise<void>) | undefined} [begin]
 * @property {(() => Promise<void>) | undefined} [commit]
 * @property {(() => Promise<void>) | undefined} [rollback]
 */

/**
 * Apply a minimal mutation plan from the source to the target store.
 *
 * Algorithm:
 *   1. Materialise sourceKeys and targetKeys into Sets.
 *   2. For each source key:
 *      - If missing from target → put.
 *      - Else compare via adapter.equals(); if different → put, else skip.
 *   3. For each target key absent from source → delete.
 *   4. Call adapter.commit() if present.
 *
 * Calls adapter.rollback() (best-effort) if an error occurs after begin().
 *
 * @param {UnificationAdapter} adapter
 * @returns {Promise<UnificationStats>}
 */
async function unifyStores(adapter) {
    if (adapter.begin !== undefined) {
        await adapter.begin();
    }

    try {
        // ── Phase 1: materialise key sets ────────────────────────────────────
        /** @type {Set<string>} */
        const sourceKeys = new Set();
        try {
            for await (const key of adapter.listSourceKeys()) {
                sourceKeys.add(key);
            }
        } catch (err) {
            throw new UnificationListError('source', err);
        }

        /** @type {Set<string>} */
        const targetKeys = new Set();
        try {
            for await (const key of adapter.listTargetKeys()) {
                targetKeys.add(key);
            }
        } catch (err) {
            throw new UnificationListError('target', err);
        }

        let putCount = 0;
        let deleteCount = 0;
        let unchangedCount = 0;

        // ── Phase 2: puts ────────────────────────────────────────────────────
        for (const key of sourceKeys) {
            /** @type {unknown} */
            let sourceValue;
            try {
                sourceValue = await adapter.readSource(key);
            } catch (err) {
                throw new UnificationReadError('source', key, err);
            }

            if (targetKeys.has(key)) {
                /** @type {unknown} */
                let targetValue;
                try {
                    targetValue = await adapter.readTarget(key);
                } catch (err) {
                    throw new UnificationReadError('target', key, err);
                }

                if (!adapter.equals(sourceValue, targetValue)) {
                    try {
                        await adapter.putTarget(key, sourceValue);
                    } catch (err) {
                        throw new UnificationWriteError(key, err);
                    }
                    putCount++;
                } else {
                    unchangedCount++;
                }
            } else {
                try {
                    await adapter.putTarget(key, sourceValue);
                } catch (err) {
                    throw new UnificationWriteError(key, err);
                }
                putCount++;
            }
        }

        // ── Phase 3: deletes ─────────────────────────────────────────────────
        for (const key of targetKeys) {
            if (!sourceKeys.has(key)) {
                try {
                    await adapter.deleteTarget(key);
                } catch (err) {
                    throw new UnificationDeleteError(key, err);
                }
                deleteCount++;
            }
        }

        // ── Phase 4: commit ──────────────────────────────────────────────────
        if (adapter.commit !== undefined) {
            try {
                await adapter.commit();
            } catch (err) {
                throw new UnificationCommitError(err);
            }
        }

        return {
            sourceCount: sourceKeys.size,
            targetCount: targetKeys.size,
            putCount,
            deleteCount,
            unchangedCount,
        };
    } catch (err) {
        if (adapter.rollback !== undefined) {
            try {
                await adapter.rollback();
            } catch (_rollbackErr) {
                // Best-effort; swallow rollback errors.
            }
        }
        throw err;
    }
}

module.exports = {
    unifyStores,
    UnificationListError,
    isUnificationListError,
    UnificationReadError,
    isUnificationReadError,
    UnificationWriteError,
    isUnificationWriteError,
    UnificationDeleteError,
    isUnificationDeleteError,
    UnificationCommitError,
    isUnificationCommitError,
};
