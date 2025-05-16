const path = require("path");
const { eventLogAssetsDirectory } = require("../environment");

class AssetClass {
    /** 
     * @type {import('./structure').Event}
     * @private
     */
    _event;

    get event() {
        return this._event;
    }    

    /**
     * @type {ExistingFile}
     * @private
     */
    _file;

    get file() {
        return this._file;
    }

    /**
     * @param {import('./structure').Event} event
     * @param {ExistingFile} file
     */
    constructor(event, file) {
        this._event = event;
        this._file = file;
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
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
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
