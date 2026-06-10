const path = require('path');
const { validateTopLevelSublevel } = require('./sublevel');
const { unifyStores } = require('../unification');
const { makePairedFsToDbAdapter } = require('./exploded_json');
/** @typedef {import('../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../logger').Logger} Logger */
/** @typedef {import('../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {{reader:FileReader,checker:FileChecker,scanner:DirScanner,logger:Logger}} ScanCapabilities */
class ScanInputDirMissingError extends Error {
    /** @param {string} inputDir @param {string} sublevel */
    constructor(inputDir, sublevel) { super(`scanFromFilesystem: input directory does not exist: ${inputDir} (sublevel: ${sublevel})`); this.name = 'ScanInputDirMissingError'; this.inputDir = inputDir; this.sublevel = sublevel; }
}
/** @param {unknown} object @returns {object is ScanInputDirMissingError} */
function isScanInputDirMissingError(object) { return object instanceof ScanInputDirMissingError; }
/** @param {ScanCapabilities} capabilities @param {RootDatabase} rootDatabase @param {{snapshotRoot:string,targetSublevel:string,snapshotSublevel:string}} options @returns {Promise<void>} */
async function scanSublevelFromSnapshot(capabilities, rootDatabase, options) {
    const targetSublevel = validateTopLevelSublevel(options.targetSublevel);
    const snapshotSublevel = validateTopLevelSublevel(options.snapshotSublevel);
    const adapter = await makePairedFsToDbAdapter(capabilities, rootDatabase, { snapshotRoot: options.snapshotRoot, targetSublevel, snapshotSublevel });
    const stats = await unifyStores(adapter);
    capabilities.logger.logInfo({ snapshotRoot: options.snapshotRoot, targetSublevel, snapshotSublevel, ...stats }, 'Scanned database sublevel from paired snapshot');
}
/** @param {ScanCapabilities} capabilities @param {RootDatabase} rootDatabase @param {string} inputDir @param {string} sublevel @returns {Promise<void>} */
async function scanFromFilesystem(capabilities, rootDatabase, inputDir, sublevel) {
    if (!await capabilities.checker.directoryExists(inputDir)) throw new ScanInputDirMissingError(inputDir, sublevel);
    await scanSublevelFromSnapshot(capabilities, rootDatabase, { snapshotRoot: path.dirname(path.dirname(inputDir)), targetSublevel: sublevel, snapshotSublevel: path.basename(inputDir) });
}
module.exports = { scanSublevelFromSnapshot, scanFromFilesystem, isScanInputDirMissingError };
