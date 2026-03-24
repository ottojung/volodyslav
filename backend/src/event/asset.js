const path = require("path");

/** @typedef {import('./structure').Event} Event */
/** @typedef {import('../filesystem/file_ref').FileRef} FileRef */

/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 * @property {import('../datetime').Datetime} datetime - Datetime utilities.
 */

class AssetClass {
    /** @type {Event} */
    event;

    /** @type {FileRef} */
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
     * @param {FileRef} file
     */
    constructor(event, file) {
        this.event = event;
        this.file = file;
        if (this.__brand !== undefined) {
            throw new Error("Asset is a nominal type and should not be instantiated directly");
        }
    }
}

/** @typedef {AssetClass} Asset */

/**
 * Primary constructor for Asset.
 * @param {Event} event
 * @param {FileRef} file
 * @returns {Asset}
 */
function make(event, file) {
    const ret = new AssetClass(event, file);
    return ret;
}

/**
 * Computes the target directory path for an asset based on its event's date and ID.
 * @param {Capabilities} capabilities
 * @param {Event} event
 * @returns {string}
 */
function targetDir(capabilities, event) {
    const baseDir = capabilities.environment.eventLogAssetsDirectory();
    
    // Extract date components using proper DateTime methods
    const date = event.date;
    const year = date.year;
    const month = date.month.toString().padStart(2, '0');
    const day = date.day.toString().padStart(2, '0');
    
    const firstPart = `${year}-${month}`;
    const secondPart = `${day}`;
    const thirdPart = `${event.id.identifier}`;
    return path.join(baseDir, firstPart, secondPart, thirdPart);
}

/**
 * @param {Capabilities} capabilities
 * @param {Asset} asset
 * @returns {string}
 */
function targetPath(capabilities, asset) {
    const dir = targetDir(capabilities, asset.event);
    return path.join(dir, asset.file.filename);
}

module.exports = {
    targetDir,
    targetPath,
    make,
};
