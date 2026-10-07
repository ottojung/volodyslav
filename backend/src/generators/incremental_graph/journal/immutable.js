/**
 * Deep immutability for the JSON-shaped values a record owns.
 *
 * A record is a persisted fact: its canonical meaning is decided once, when it is
 * built, and every later comparison of that meaning — a fork check, a canonical
 * encoding — must see the same bytes. Freezing only the record's own properties
 * would leave its `id`, `authorityTime`, `node`, `payload`, `basis` and `scope`
 * reachable and writable, so a caller holding one of those objects could change a
 * record's canonical meaning after the record had been validated, filed into a
 * replica and compared for forks.
 *
 * The values reached this way are JSON-shaped by definition — a `NodeKey` is a
 * node name plus `ConstValue` arguments, and a `ComputedValue` is a persisted
 * database entry — so every array and plain object reachable from them can be
 * rebuilt as a frozen copy.
 *
 * The copy is what makes the record independent of its caller: the caller keeps
 * an object it may still mutate, and the record keeps one it cannot. A record
 * which froze the caller's object instead would make the caller's own state
 * depend on whether a record had already been built from it.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * A detached, deeply frozen copy of a JSON-shaped value.
 *
 * Nominal values reached inside the copy — a `JournalAuthor`, a `JournalSequence`,
 * a `JournalRecordId`, a `ValidationBasisEntry`, an `InvalidateScope`, and the
 * `EventId` and `DateTime` a computor returns inside a payload — are not plain
 * objects, so they are carried by reference rather than rebuilt. Each of their
 * classes freezes itself at construction, which is what makes the reference the
 * copy carries safe, and rebuilding one would discard its nominal identity.
 *
 * The result is `unknown` rather than the argument's type because a copy is a
 * different object and therefore has to be re-accepted by the guard for the shape
 * it claims to have. The three `owned…` functions in this module do exactly that,
 * so no caller needs a cast to use the copy.
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFrozenCopy(value) {
    if (Array.isArray(value)) {
        return Object.freeze(value.map((element) => deepFrozenCopy(element)));
    }
    if (isPlainObject(value)) {
        /** @type {Record<string, unknown>} */
        const copy = {};
        for (const key of Object.keys(value)) {
            copy[key] = deepFrozenCopy(value[key]);
        }
        return Object.freeze(copy);
    }
    return value;
}

module.exports = {
    deepFrozenCopy,
};
