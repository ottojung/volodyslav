/**
 * Filesystem rendering module for the incremental-graph database.
 *
 * Provides the new renderSublevelToSnapshot() for the exploded JSON format,
 * and the legacy renderToFilesystem() for backward compatibility.
 *
 * The new format renders to paired kindtree/ and rendered/ trees under a
 * snapshot root. The legacy format renders to a single directory of JSON files.
 */

const path = require('path');
const { validateTopLevelSublevel } = require('./sublevel');
const { makeDbToFsAdapter, unifyStores } = require('../unification');
const { makeDbToPairedFsAdapter } = require('./exploded_json');

/** @typedef {import('../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../../../../logger').Logger} Logger */

/**
 * Capabilities required by renderToFilesystem / renderSublevelToSnapshot.
 * @typedef {object} RenderCapabilities
 * @property {FileCreator} creator
 * @property {FileWriter} writer
 * @property {FileReader} reader
 * @property {FileChecker} checker
 * @property {FileDeleter} deleter
 * @property {DirScanner} scanner
 * @property {Logger} logger
 */

/**
 * Render one database sublevel into the paired snapshot format.
 *
 * The snapshot contains sibling kindtree/ and rendered/ trees under
 * snapshotRoot/snapshotSublevel/.
 *
 * @param {RenderCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {{ snapshotRoot: string, sourceSublevel: string, snapshotSublevel: string }} options
 * @returns {Promise<void>}
 */
async function renderSublevelToSnapshot(capabilities, rootDatabase, options) {
    const { snapshotRoot, sourceSublevel, snapshotSublevel } = options;
    const validatedSource = validateTopLevelSublevel(sourceSublevel);
    const validatedSnapshot = validateTopLevelSublevel(snapshotSublevel);

    const renderedDir = path.join(snapshotRoot, 'rendered', validatedSnapshot);
    const kindtreeDir = path.join(snapshotRoot, 'kindtree', validatedSnapshot);

    // Ensure both output directory trees exist
    for (const dir of [renderedDir, kindtreeDir]) {
        if (!await capabilities.checker.directoryExists(dir)) {
            await capabilities.creator.createDirectory(dir);
        }
    }

    const adapter = makeDbToPairedFsAdapter(
        capabilities, rootDatabase,
        snapshotRoot, validatedSnapshot, validatedSource
    );
    const stats = await unifyStores(adapter);

    capabilities.logger.logInfo(
        { snapshotRoot, sourceSublevel: validatedSource, snapshotSublevel: validatedSnapshot, ...stats },
        'Rendered database sublevel to paired snapshot'
    );
}

/**
 * Legacy render: dumps every raw key/value pair from one top-level database
 * sublevel to a directory tree rooted at `outputDir`.
 *
 * @param {RenderCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {string} outputDir - Absolute path of the directory to write into.
 * @param {string} sublevel - Top-level database sublevel to render.
 * @returns {Promise<void>}
 */
async function renderToFilesystem(capabilities, rootDatabase, outputDir, sublevel) {
    const validatedSublevel = validateTopLevelSublevel(sublevel);

    if (!await capabilities.checker.directoryExists(outputDir)) {
        await capabilities.creator.createDirectory(outputDir);
    }

    const adapter = makeDbToFsAdapter(capabilities, rootDatabase, outputDir, validatedSublevel);
    const stats = await unifyStores(adapter);

    capabilities.logger.logInfo(
        { outputDir, sublevel: validatedSublevel, count: stats.sourceCount, ...stats },
        'Rendered database to filesystem'
    );
}

module.exports = {
    renderSublevelToSnapshot,
    renderToFilesystem,
};
