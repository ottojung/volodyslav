const path = require('path');
const { eventLogAssetsDirectory } = require('../environment');

class AssetClass {
    /** @type {import('./id').EventId} */
    identifier;

    /** @type {string} */
    path;

    /**
     * This is a value that is never actually assigned.
     * Its purpose is to make `RequestIdentifier` a nominal type.
     * @private
     * @type {undefined}
     */
    __brand;

    /**
     * @param {import('./id').EventId} identifier
     * @param {string} path
     */
    constructor(identifier, path) {
        this.identifier = identifier;
        this.path = path;
    }
}

/** @typedef {AssetClass} Asset */

/**
 * Primary constructor for Asset.
 * @param {import('./id').EventId} identifier
 * @param {string} asset
 * @returns {Asset}
 */
function make(identifier, asset) {
    return new AssetClass(identifier, asset);
}

/**
 * @param {Asset} asset
 * @returns {string}
 */
function targetPath(asset) {
    const baseDir = eventLogAssetsDirectory();
    return path.join(baseDir, asset.identifier.identifier.toString());
}

module.exports = {
    targetPath,
    make,
};
