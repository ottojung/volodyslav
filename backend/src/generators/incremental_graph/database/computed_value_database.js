/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
const { findInvalidPersistenceSafeValue } = require("./persistence_safe_value");

/**
 * @typedef {object} StoredComputedValue
 * @property {ComputedValue} value
 */

/**
 * Level reserves top-level null to mean “no value”. This adapter stores every
 * semantic ComputedValue in a one-field JSON record so semantic null remains a
 * present value while callers and rendered snapshots continue to observe the
 * raw ComputedValue.
 */
class ComputedValueDatabaseClass {
    /** @type {import('./types').SimpleSublevel<StoredComputedValue, NodeIdentifier>} */
    sublevel;

    /**
     * @param {import('./types').SimpleSublevel<StoredComputedValue, NodeIdentifier>} sublevel
     */
    constructor(sublevel) {
        this.sublevel = sublevel;
    }

    /** @param {NodeIdentifier} key @returns {Promise<ComputedValue | undefined>} */
    async get(key) {
        const stored = await this.sublevel.get(key);
        return stored === undefined ? undefined : stored.value;
    }

    /** @param {NodeIdentifier} key @param {ComputedValue} value @returns {Promise<void>} */
    async put(key, value) {
        requirePersistenceSafeComputedValue(value);
        await this.sublevel.put(key, { value });
    }

    /** @param {NodeIdentifier} key @param {ComputedValue} value @returns {Promise<void>} */
    async noFlushPut(key, value) {
        requirePersistenceSafeComputedValue(value);
        const options = { sync: false, keyEncoding: undefined };
        await this.sublevel.put(key, { value }, options);
    }

    /** @param {NodeIdentifier} key @returns {Promise<void>} */
    async del(key) {
        await this.sublevel.del(key);
    }

    /** @param {NodeIdentifier} key @returns {Promise<void>} */
    async noFlushDel(key) {
        const options = { sync: false, keyEncoding: undefined };
        await this.sublevel.del(key, options);
    }

    /**
     * @param {NodeIdentifier} key
     * @param {ComputedValue} value
     * @returns {import('./typed_database').DatabasePutOperation<StoredComputedValue, NodeIdentifier>}
     */
    putOp(key, value) {
        requirePersistenceSafeComputedValue(value);
        return { sublevel: this.sublevel, type: "put", key, value: { value } };
    }

    /**
     * @param {NodeIdentifier} key
     * @returns {import('./typed_database').DatabaseDelOperation<StoredComputedValue, NodeIdentifier>}
     */
    delOp(key) {
        return { sublevel: this.sublevel, type: "del", key };
    }

    /** @returns {AsyncIterable<NodeIdentifier>} */
    async *keys() {
        for await (const key of this.sublevel.keys()) yield key;
    }

    /** @returns {Promise<void>} */
    async clear() {
        await this.sublevel.clear();
    }
}

/** @param {ComputedValue} value @returns {void} */
function requirePersistenceSafeComputedValue(value) {
    const invalid = findInvalidPersistenceSafeValue(value, "computedValue");
    if (invalid !== undefined) throw invalid;
}

/**
 * @param {import('./types').SimpleSublevel<StoredComputedValue, NodeIdentifier>} sublevel
 * @returns {ComputedValueDatabase}
 */
function makeComputedValueDatabase(sublevel) {
    return new ComputedValueDatabaseClass(sublevel);
}

module.exports = { makeComputedValueDatabase };

/**
 * @typedef {object} ComputedValueDatabase
 * @property {(key: NodeIdentifier) => Promise<ComputedValue | undefined>} get
 * @property {(key: NodeIdentifier, value: ComputedValue) => Promise<void>} put
 * @property {(key: NodeIdentifier, value: ComputedValue) => Promise<void>} noFlushPut
 * @property {(key: NodeIdentifier) => Promise<void>} del
 * @property {(key: NodeIdentifier) => Promise<void>} noFlushDel
 * @property {(key: NodeIdentifier, value: ComputedValue) => import('./typed_database').DatabasePutOperation<StoredComputedValue, NodeIdentifier>} putOp
 * @property {(key: NodeIdentifier) => import('./typed_database').DatabaseDelOperation<StoredComputedValue, NodeIdentifier>} delOp
 * @property {() => AsyncIterable<NodeIdentifier>} keys
 * @property {() => Promise<void>} clear
 */
