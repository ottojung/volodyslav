/**
 * Filesystem scanning module for the incremental-graph database.
 *
 * Provides the new scanSublevelFromSnapshot() for the exploded JSON format,
 * and the legacy scanFromFilesystem() for backward compatibility.
 */

const path = require('path');
const { validateTopLevelSublevel } = require('./sublevel');
const { makeFsToDbAdapter, unifyStores } = require('../unification');
const { makePairedFsToDbAdapter } = require('./exploded_json/paired_fs_to_db');

/** @typedef {import('../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../../logger').Logger} Logger */

/** @typedef {import('../../../../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../../../../filesystem/writer').FileWriter} FileWriter */

/**
 * Capabilities required by scanFromFilesystem / scanSublevelFromSnapshot.
 * @typedef {object} ScanCapabilities
 * @property {FileReader} reader
 * @property {FileChecker} checker
 * @property {DirScanner} scanner
 * @property {Logger} logger
 */

class ScanInputDirMissingError extends Error {
    constructor(inputDir, sublevel) {
        super(
            `scanFromFilesystem: input directory does not exist: ${inputDir} (sublevel: ${sublevel})`
        );
        this.name = 'ScanInputDirMissingError';
        this.inputDir = inputDir;
        this.sublevel = sublevel;
    }
}

function isScanInputDirMissingError(object) {
    return object instanceof ScanInputDirMissingError;
}

/**
 * Scan a paired snapshot into one database sublevel.
 *
 * Reads from snapshotRoot/kindtree/snapshotSublevel/ and
 * snapshotRoot/rendered/snapshotSublevel/ and reconstructs complete DB
 * values into targetSublevel.
 *
 * @param {ScanCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {{ snapshotRoot: string, targetSublevel: string, snapshotSublevel: string }} options
 * @returns {Promise<void>}
 */
async function scanSublevelFromSnapshot(capabilities, rootDatabase, options) {
    const { snapshotRoot, targetSublevel, snapshotSublevel } = options;
    const validatedTarget = validateTopLevelSublevel(targetSublevel);
    const validatedSnapshot = validateTopLevelSublevel(snapshotSublevel);

    const kindtreeDir = path.join(snapshotRoot, 'kindtree', validatedSnapshot);
    if (!await capabilities.checker.directoryExists(kindtreeDir)) {
        // Fall back to legacy one-file-JSON scan
        const renderedDir = path.join(snapshotRoot, 'rendered', validatedSnapshot);
        if (await capabilities.checker.directoryExists(renderedDir)) {
            capabilities.logger.logInfo(
                { snapshotRoot },
                'Kindtree directory missing; falling back to legacy JSON scan'
            );
            return await scanFromFilesystem(capabilities, rootDatabase, renderedDir, validatedTarget);
        }
        // Both are missing - empty source is valid, just create the adapter to handle it
    }

    const adapter = makePairedFsToDbAdapter(
        capabilities, rootDatabase,
        snapshotRoot, validatedSnapshot, validatedTarget
    );
    const stats = await unifyStores(adapter);

    capabilities.logger.logInfo(
        { snapshotRoot, targetSublevel: validatedTarget, snapshotSublevel: validatedSnapshot, ...stats },
        'Scanned paired snapshot into database'
    );
}

/**
 * Legacy scan: reads a directory tree of JSON files back into one database sublevel.
 *
 * @param {ScanCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {string} inputDir - Absolute path to the snapshot directory to scan.
 * @param {string} sublevel - Top-level database sublevel to write into.
 * @returns {Promise<void>}
 */
async function scanFromFilesystem(capabilities, rootDatabase, inputDir, sublevel) {
    const validatedSublevel = validateTopLevelSublevel(sublevel);

    if (!await capabilities.checker.directoryExists(inputDir)) {
        throw new ScanInputDirMissingError(inputDir, validatedSublevel);
    }

    const adapter = makeFsToDbAdapter(capabilities, rootDatabase, inputDir, validatedSublevel);
    const stats = await unifyStores(adapter);

    capabilities.logger.logInfo(
        { inputDir, sublevel: validatedSublevel, count: stats.sourceCount, ...stats },
        'Scanned database from filesystem'
    );
}

module.exports = {
    scanSublevelFromSnapshot,
    scanFromFilesystem,
    ScanInputDirMissingError,
    isScanInputDirMissingError,
};
