const path = require('path');
const { eventLogAssetsDirectory } = require('../environment');

class AssetClass {
    /** @type {import('./structure').Event} */
    event;

    /** @type {ExistingFile} */
    file;

    /**
     * This is a value that is never actually assigned.
     * Its purpose is to make `RequestIdentifier` a nominal type.
     * @private
     * @type {undefined}
     */
    __brand;

    /**
     * @param {import('./structure').Event} event
     * @param {ExistingFile} file
     */
    constructor(event, file) {
        this.event = event;
        this.file = file;
    }
}

/** @typedef {AssetClass} Asset */
/** @typedef {import('../filesystem/file').ExistingFile} ExistingFile */

/**
 * Primary constructor for Asset.
 * @param {import('./structure').Event} event
 * @param {ExistingFile} file
 * @returns {Asset}
 */
function make(event, file) {
    return new AssetClass(event, file);
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
    const filename = path.basename(asset.file.path);
    return path.join(baseDir, firstPart, secondPart, thirdPart, filename);
}

module.exports = {
    targetPath,
    make,
};
