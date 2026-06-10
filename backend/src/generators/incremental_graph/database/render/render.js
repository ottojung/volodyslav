const { validateTopLevelSublevel } = require('./sublevel');
const { unifyStores } = require('../unification');
const path = require('path');
const { makeDbToPairedFsAdapter } = require('./exploded_json');
/** @typedef {import('../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../logger').Logger} Logger */
/** @typedef {import('../../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {{creator:FileCreator,writer:FileWriter,reader:FileReader,checker:FileChecker,deleter:FileDeleter,scanner:DirScanner,logger:Logger}} RenderCapabilities */
/** @param {RenderCapabilities} capabilities @param {RootDatabase} rootDatabase @param {{snapshotRoot:string,sourceSublevel:string,snapshotSublevel:string}} options @returns {Promise<void>} */
async function renderSublevelToSnapshot(capabilities, rootDatabase, options) {
    const sourceSublevel = validateTopLevelSublevel(options.sourceSublevel);
    const snapshotSublevel = validateTopLevelSublevel(options.snapshotSublevel);
    const adapter = makeDbToPairedFsAdapter(capabilities, rootDatabase, { snapshotRoot: options.snapshotRoot, sourceSublevel, snapshotSublevel });
    const stats = await unifyStores(adapter);
    await pruneEmptyDirectories(capabilities, path.join(options.snapshotRoot, 'rendered', snapshotSublevel));
    await pruneEmptyDirectories(capabilities, path.join(options.snapshotRoot, 'kindtree', snapshotSublevel));
    capabilities.logger.logInfo({ snapshotRoot: options.snapshotRoot, sourceSublevel, snapshotSublevel, ...stats }, 'Rendered database sublevel to paired snapshot');
}
/** @param {RenderCapabilities} capabilities @param {string} directory @returns {Promise<boolean>} */
async function pruneEmptyDirectories(capabilities, directory) {
    if (!await capabilities.checker.directoryExists(directory)) return true;
    for (const child of await capabilities.scanner.scanDirectory(directory)) {
        if (await capabilities.checker.directoryExists(child.path)) await pruneEmptyDirectories(capabilities, child.path);
    }
    if ((await capabilities.scanner.scanDirectory(directory)).length === 0) { await capabilities.deleter.deleteDirectory(directory); return true; }
    return false;
}

/** Compatibility entry point that renders a database sublevel into a paired snapshot with the same sublevel name. @param {RenderCapabilities} capabilities @param {RootDatabase} rootDatabase @param {string} snapshotRoot @param {string} sublevel @returns {Promise<void>} */
async function renderToFilesystem(capabilities, rootDatabase, snapshotRoot, sublevel) {
    await renderSublevelToSnapshot(capabilities, rootDatabase, {
        snapshotRoot,
        sourceSublevel: sublevel,
        snapshotSublevel: sublevel,
    });
}
module.exports = { renderSublevelToSnapshot, renderToFilesystem };
