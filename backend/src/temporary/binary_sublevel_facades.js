/** @typedef {import('./database').TemporaryDatabase} TemporaryDatabase */

class TemporarySublevelPathError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "TemporarySublevelPathError";
    }
}

/**
 * @param {unknown} object
 * @returns {object is TemporarySublevelPathError}
 */
function isTemporarySublevelPathError(object) {
    return object instanceof TemporarySublevelPathError;
}

class TemporaryBinarySublevelFacadeClass {
    /**
     * @private
     * @type {() => Promise<TemporaryDatabase>}
     */
    _getDatabase;

    /**
     * @private
     * @type {string[]}
     */
    _jsonPath;

    /**
     * @private
     * @type {string[]}
     */
    _binaryPath;

    /**
     * @param {() => Promise<TemporaryDatabase>} getDatabase
     * @param {string[]} jsonPathSegments
     * @param {string[]} binaryPathSegments
     */
    constructor(getDatabase, jsonPathSegments, binaryPathSegments) {
        this._getDatabase = getDatabase;
        this._jsonPath = jsonPathSegments;
        this._binaryPath = binaryPathSegments;
    }

    /**
     * @returns {Promise<import('./database').TemporaryBinarySublevel>}
     */
    async _resolveSublevel() {
        const db = await this._getDatabase();
        const firstJson = this._jsonPath[0];
        if (firstJson === undefined) {
            throw new TemporarySublevelPathError("Temporary sublevel path must not be empty");
        }
        let jsonSublevel = db.getSublevel(firstJson);
        for (const segment of this._jsonPath.slice(1)) {
            jsonSublevel = jsonSublevel.getSublevel(segment);
        }
        const firstBinary = this._binaryPath[0];
        if (firstBinary === undefined) {
            throw new TemporarySublevelPathError("Temporary binary sublevel path must not be empty");
        }
        let binarySublevel = jsonSublevel.getBinarySublevel(firstBinary);
        for (const segment of this._binaryPath.slice(1)) {
            binarySublevel = binarySublevel.getSublevel(segment);
        }
        return binarySublevel;
    }

    /**
     * @param {string} name
     * @returns {TemporaryBinarySublevelFacadeClass}
     */
    getSublevel(name) {
        return new TemporaryBinarySublevelFacadeClass(this._getDatabase, this._jsonPath, [...this._binaryPath, name]);
    }

    /**
     * @param {import('./database/types').TempKey} key
     * @returns {Promise<Buffer | undefined>}
     */
    async get(key) {
        const sublevel = await this._resolveSublevel();
        return sublevel.get(key);
    }

    /**
     * @param {import('./database/types').TempKey} key
     * @param {Buffer} value
     * @returns {Promise<void>}
     */
    async put(key, value) {
        const sublevel = await this._resolveSublevel();
        await sublevel.put(key, value);
    }

    /**
     * @param {import('./database/types').TempKey} key
     * @returns {Promise<void>}
     */
    async del(key) {
        const sublevel = await this._resolveSublevel();
        await sublevel.del(key);
    }

    /**
     * @param {Array<{type: 'put', key: import('./database/types').TempKey, value: Buffer} | {type: 'del', key: import('./database/types').TempKey}>} operations
     * @returns {Promise<void>}
     */
    async batch(operations) {
        const sublevel = await this._resolveSublevel();
        await sublevel.batch(operations);
    }

    /**
     * @returns {Promise<import('./database/types').TempKey[]>}
     */
    async listKeys() {
        const sublevel = await this._resolveSublevel();
        return sublevel.listKeys();
    }

    /**
     * @returns {Promise<void>}
     */
    async clear() {
        const sublevel = await this._resolveSublevel();
        await sublevel.clear();
    }
}

class TemporaryRootBinarySublevelFacadeClass {
    /**
     * @private
     * @type {() => Promise<TemporaryDatabase>}
     */
    _getDatabase;

    /**
     * @private
     * @type {string[]}
     */
    _path;

    /**
     * @param {() => Promise<TemporaryDatabase>} getDatabase
     * @param {string[]} pathSegments
     */
    constructor(getDatabase, pathSegments) {
        this._getDatabase = getDatabase;
        this._path = pathSegments;
    }

    /**
     * @returns {Promise<import('./database').TemporaryBinarySublevel>}
     */
    async _resolveSublevel() {
        const db = await this._getDatabase();
        const first = this._path[0];
        if (first === undefined) {
            throw new TemporarySublevelPathError("Temporary binary sublevel path must not be empty");
        }
        let sublevel = db.getBinarySublevel(first);
        for (const segment of this._path.slice(1)) {
            sublevel = sublevel.getSublevel(segment);
        }
        return sublevel;
    }

    /**
     * @param {string} name
     * @returns {TemporaryRootBinarySublevelFacadeClass}
     */
    getSublevel(name) {
        return new TemporaryRootBinarySublevelFacadeClass(this._getDatabase, [...this._path, name]);
    }

    /**
     * @param {import('./database/types').TempKey} key
     * @returns {Promise<Buffer | undefined>}
     */
    async get(key) {
        const sublevel = await this._resolveSublevel();
        return sublevel.get(key);
    }

    /**
     * @param {import('./database/types').TempKey} key
     * @param {Buffer} value
     * @returns {Promise<void>}
     */
    async put(key, value) {
        const sublevel = await this._resolveSublevel();
        await sublevel.put(key, value);
    }

    /**
     * @param {import('./database/types').TempKey} key
     * @returns {Promise<void>}
     */
    async del(key) {
        const sublevel = await this._resolveSublevel();
        await sublevel.del(key);
    }

    /**
     * @param {Array<{type: 'put', key: import('./database/types').TempKey, value: Buffer} | {type: 'del', key: import('./database/types').TempKey}>} operations
     * @returns {Promise<void>}
     */
    async batch(operations) {
        const sublevel = await this._resolveSublevel();
        await sublevel.batch(operations);
    }

    /**
     * @returns {Promise<import('./database/types').TempKey[]>}
     */
    async listKeys() {
        const sublevel = await this._resolveSublevel();
        return sublevel.listKeys();
    }

    /**
     * @returns {Promise<void>}
     */
    async clear() {
        const sublevel = await this._resolveSublevel();
        await sublevel.clear();
    }
}

/**
 * @param {() => Promise<TemporaryDatabase>} getDatabase
 * @param {string[]} pathSegments
 * @returns {TemporaryRootBinarySublevelFacadeClass}
 */
function makeRootBinarySublevelFacade(getDatabase, pathSegments) {
    return new TemporaryRootBinarySublevelFacadeClass(getDatabase, pathSegments);
}

/**
 * @param {() => Promise<TemporaryDatabase>} getDatabase
 * @param {string[]} jsonPathSegments
 * @param {string[]} binaryPathSegments
 * @returns {TemporaryBinarySublevelFacadeClass}
 */
function makeNestedBinarySublevelFacade(getDatabase, jsonPathSegments, binaryPathSegments) {
    return new TemporaryBinarySublevelFacadeClass(getDatabase, jsonPathSegments, binaryPathSegments);
}

module.exports = {
    makeRootBinarySublevelFacade,
    makeNestedBinarySublevelFacade,
    TemporarySublevelPathError,
    isTemporarySublevelPathError,
};
