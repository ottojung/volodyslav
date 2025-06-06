const path = require("path");

/** @typedef {import('./structure').Event} Event */
/** @typedef {import('../filesystem/file').ExistingFile} ExistingFile */

/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 */

class AssetClass {
    /** @type {Event} */
    event;

    /** @type {ExistingFile} */
    file;

    /**
     * This is a value that is never actually assigned.
     * Its purpose is to make `Asset` a nominal type.
     * @type {undefined}
     * @private
     */
    __brand;

    /**
     * @param {import('./structure').Event} event
     * @param {ExistingFile} file
     */
    constructor(event, file) {
        this.event = event;
        this.file = file;
        if (this.__brand !== undefined) {
            throw new Error();
        }
    }
}

/** @typedef {AssetClass} Asset */

/**
 * Primary constructor for Asset.
 * @param {Event} event
 * @param {ExistingFile} file
 * @returns {Asset}
 */
function make(event, file) {
    const ret = new AssetClass(event, file);
    return ret;
}

/**
 * @param {Capabilities} capabilities
 * @param {Asset} asset
 * @returns {string}
 */
function targetPath(capabilities, asset) {
    const baseDir = capabilities.environment.eventLogAssetsDirectory();
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
