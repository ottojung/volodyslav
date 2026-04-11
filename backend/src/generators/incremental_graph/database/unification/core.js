/**
 * Core gentle-unification engine.
 *
 * Computes and applies a minimal mutation plan from a source store to a target
 * store.  Each call advances both stores' key iterators in lockstep (a sorted
 * merge-join), reads values only for keys that exist in both stores, and issues
 * only the necessary puts and deletes.
 *
 * Memory policy: O(V) where V is the size of the largest single value read or
 * written by the core algorithm.  unifyStores() retains only the current
 * iterator items plus, at most, one source value and one target value at any
 * instant.  If an adapter materialises or buffers key lists, that memory usage
 * is an adapter concern rather than memory retained by unifyStores() itself.
 *
 * Atomicity: unifyStores() is intentionally NOT atomic.  A failure mid-run
 * may leave the target in a partially-updated state.  Atomicity is guaranteed
 * at a higher level by the replica-cutover mechanism: the target store is
 * always an *inactive* replica that is never read until cutover succeeds.
 * Callers must not rely on rollback behaviour from this function.
 *
 * Requirement: both listSourceKeys() and listTargetKeys() MUST yield keys in
 * ascending lexicographic order for the merge-join to produce correct results.
 *
 * Key ordering assumption: keys are compared with JS string operators (<, >),
 * which use UCS-2/UTF-16 code-unit order.  LevelDB iterates keys in UTF-8
 * byte order.  These orderings agree for all Unicode code points in the Basic
 * Multilingual Plane (U+0000–U+FFFF), which covers every character that can
 * appear in the internal NodeKey strings used here (ASCII alphanumerics plus
 * the separator byte \x00).  Adapters that sort in JS (e.g. db_to_fs, fs_to_db)
 * use Array.prototype.sort(), which also uses UCS-2 order and therefore
 * produces the same ordering as LevelDB for these keys.
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
 * No start/commit/rollback lifecycle methods: unification is intentionally
 * non-atomic (see module-level note).  Each putTarget/deleteTarget call may
 * write to the target immediately, or an adapter may buffer operations and
 * apply them all at once in the optional flush() method.
 *
 * @typedef {object} UnificationAdapter
 * @property {() => AsyncIterable<string>} listSourceKeys
 * @property {() => AsyncIterable<string>} listTargetKeys
 * @property {(key: string) => Promise<unknown>} readSource
 * @property {(key: string) => Promise<unknown>} readTarget
 * @property {(sourceValue: unknown, targetValue: unknown) => boolean} equals
 * @property {(key: string, value: unknown) => Promise<void>} putTarget
 * @property {(key: string) => Promise<void>} deleteTarget
 * @property {() => Promise<void>} [flush] - Optional: called after all puts/deletes to flush buffered writes.
 */

/**
 * Apply a minimal mutation plan from the source to the target store.
 *
 * Algorithm: sorted merge-join over two sorted key streams.
 *   - Advance both iterators in lockstep using string comparison.
 *   - source key < target key → source-only → put.
 *   - source key > target key → target-only → delete.
 *   - source key = target key → compare values; put only if different.
 *
 * Deletes are naturally processed before conflicting puts because sorted keys
 * ensure a stale prefix path (e.g. "values/foo") is encountered before the
 * new deeper path that would conflict with it (e.g. "values/foo/bar").
 *
 * This function is NOT atomic: a failure mid-run may leave the target
 * partially updated.  Atomicity is guaranteed at a higher level by the
 * replica-cutover mechanism (see module-level note).
 *
 * REQUIREMENT: both listSourceKeys() and listTargetKeys() MUST yield keys in
 * ascending lexicographic order.
 *
 * @param {UnificationAdapter} adapter
 * @returns {Promise<UnificationStats>}
 */
async function unifyStores(adapter) {
    const sourceIter = adapter.listSourceKeys()[Symbol.asyncIterator]();
    const targetIter = adapter.listTargetKeys()[Symbol.asyncIterator]();

    /**
     * Advance the source iterator, wrapping errors as UnificationListError.
     * @returns {Promise<IteratorResult<string>>}
     */
    const nextSource = async () => {
        try {
            return await sourceIter.next();
        } catch (err) {
            throw new UnificationListError('source', err);
        }
    };

    /**
     * Advance the target iterator, wrapping errors as UnificationListError.
     * @returns {Promise<IteratorResult<string>>}
     */
    const nextTarget = async () => {
        try {
            return await targetIter.next();
        } catch (err) {
            throw new UnificationListError('target', err);
        }
    };

    let sNext = await nextSource();
    let tNext = await nextTarget();

    let putCount = 0;
    let deleteCount = 0;
    let unchangedCount = 0;
    let sourceCount = 0;
    let targetCount = 0;

    try {
        while (!sNext.done || !tNext.done) {
            /** @type {number} */
            let cmp;
            if (sNext.done) {
                cmp = 1;
            } else if (tNext.done) {
                cmp = -1;
            } else {
                const sk = String(sNext.value);
                const tk = String(tNext.value);
                cmp = sk < tk ? -1 : sk > tk ? 1 : 0;
            }

            if (cmp < 0) {
                // Source-only key: put to target.
                sourceCount++;
                /** @type {unknown} */
                let sourceValue;
                try {
                    sourceValue = await adapter.readSource(sNext.value);
                } catch (err) {
                    throw new UnificationReadError('source', sNext.value, err);
                }
                try {
                    await adapter.putTarget(sNext.value, sourceValue);
                } catch (err) {
                    throw new UnificationWriteError(sNext.value, err);
                }
                putCount++;
                sNext = await nextSource();
            } else if (cmp > 0) {
                // Target-only key: delete from target.
                targetCount++;
                try {
                    await adapter.deleteTarget(tNext.value);
                } catch (err) {
                    throw new UnificationDeleteError(tNext.value, err);
                }
                deleteCount++;
                tNext = await nextTarget();
            } else {
                // Key present in both: compare values and put only if different.
                sourceCount++;
                targetCount++;
                /** @type {unknown} */
                let sourceValue;
                try {
                    sourceValue = await adapter.readSource(sNext.value);
                } catch (err) {
                    throw new UnificationReadError('source', sNext.value, err);
                }
                /** @type {unknown} */
                let targetValue;
                try {
                    targetValue = await adapter.readTarget(tNext.value);
                } catch (err) {
                    throw new UnificationReadError('target', tNext.value, err);
                }
                if (!adapter.equals(sourceValue, targetValue)) {
                    try {
                        await adapter.putTarget(sNext.value, sourceValue);
                    } catch (err) {
                        throw new UnificationWriteError(sNext.value, err);
                    }
                    putCount++;
                } else {
                    unchangedCount++;
                }
                sNext = await nextSource();
                tNext = await nextTarget();
            }
        }

        // Optional post-write hook: called after all puts/deletes to let the
        // adapter perform a final step (e.g. one fsync via rootDatabase._rawSync()).
        if (adapter.flush !== undefined) {
            try {
                await adapter.flush();
            } catch (err) {
                throw new UnificationWriteError('(flush)', err);
            }
        }
    } finally {
        // Ensure iterators are released on all exit paths (normal and error).
        await sourceIter.return?.();
        await targetIter.return?.();
    }

    return {
        sourceCount,
        targetCount,
        putCount,
        deleteCount,
        unchangedCount,
    };
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
};
