const path = require('path');
const { eventLogAssetsDirectory } = require('../environment');

class AssetClass {
    /** @type {import('./structure').Event} */
    event;

    /** @type {string} */
    filepath;

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
        this.filepath = path;
    }
}

/** @typedef {AssetClass} Asset */

/**
 * Primary constructor for Asset.
 * @param {import('./structure').Event} event
 * @param {string} filepath
 * @returns {Asset}
 */
function make(event, filepath) {
    return new AssetClass(event, filepath);
}

/**
 * @param {Asset} asset
 * @returns {string}
 */
function targetPath(asset) {
    const baseDir = eventLogAssetsDirectory();
    const date = asset.event.date;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const firstPart = `${year}-${month}`;
    const secondPart = `${day}`;
    const thirdPart = `${asset.event.id.identifier}`;
    const filename = path.basename(asset.filepath);
    return path.join(baseDir, firstPart, secondPart, thirdPart, filename);
}

module.exports = {
    targetPath,
    make,
};
