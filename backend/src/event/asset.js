const path = require('path');
const { eventLogAssetsDirectory } = require('../environment');

class AssetClass {
    /** @type {import('./structure').Event} */
    event;

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
     * @param {import('./structure').Event} event
     * @param {string} path
     */
    constructor(event, path) {
        this.event = event;
        this.path = path;
    }
}

/** @typedef {AssetClass} Asset */

/**
 * Primary constructor for Asset.
 * @param {import('./structure').Event} event
 * @param {string} asset
 * @returns {Asset}
 */
function make(event, asset) {
    return new AssetClass(event, asset);
}

/**
 * @param {Asset} asset
 * @returns {string}
 */
function targetPath(asset) {
    const baseDir = eventLogAssetsDirectory();
    return path.join(baseDir, asset.event.id.identifier);
}

module.exports = {
    targetPath,
    make,
};
