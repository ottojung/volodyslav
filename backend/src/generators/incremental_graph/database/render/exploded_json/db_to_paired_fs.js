const path = require('path');
const { keyToRelativePath, relativePathToKey } = require('../../encoding');
const { projectValueRootToVirtualFiles } = require('./projection');
const { virtualKeyToPhysicalPath, makeKindtreeVirtualKey, makeRenderedVirtualKey } = require('./virtual_file_key');
const { walkRegularFiles } = require('./filesystem_tree');
/** @typedef {import('../../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../../../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {{creator:FileCreator,writer:FileWriter,reader:FileReader,checker:FileChecker,deleter:FileDeleter,scanner:DirScanner}} PairedFsCapabilities */

/** @param {string} rawPath @param {string} sourceSublevel @param {string} snapshotSublevel @returns {string} */
function rawPathToValueRoot(rawPath, sourceSublevel, snapshotSublevel) {
    const prefix = sourceSublevel + '/';
    return snapshotSublevel + '/' + rawPath.slice(prefix.length);
}
/** @param {string} valueRoot @param {string} sourceSublevel @param {string} snapshotSublevel @returns {string} */
function valueRootToRawKey(valueRoot, sourceSublevel, snapshotSublevel) {
    return relativePathToKey(sourceSublevel + '/' + valueRoot.slice(snapshotSublevel.length + 1));
}
/** @param {PairedFsCapabilities} capabilities @param {string} managedRoot @param {string} absPath @returns {Promise<void>} */
async function preparePathForRegularFile(capabilities, managedRoot, absPath) {
    const relativeParent = path.relative(managedRoot, path.dirname(absPath));
    let current = managedRoot;
    if (!await capabilities.checker.directoryExists(current)) await capabilities.creator.createDirectory(current);
    for (const segment of relativeParent === '' ? [] : relativeParent.split(path.sep)) {
        current = path.join(current, segment);
        if (await capabilities.checker.fileExists(current)) await capabilities.deleter.deleteFile(current);
        if (!await capabilities.checker.directoryExists(current)) await capabilities.creator.createDirectory(current);
    }
    if (await capabilities.checker.directoryExists(absPath)) await capabilities.deleter.deleteDirectory(absPath);
}
/** @param {PairedFsCapabilities} capabilities @param {RootDatabase} rootDatabase @param {{snapshotRoot:string,sourceSublevel:string,snapshotSublevel:string}} options @returns {import('../../unification/core').UnificationAdapter} */
function makeDbToPairedFsAdapter(capabilities, rootDatabase, options) {
    const rawPrefix = `!${options.sourceSublevel}!`;
    const sourceVirtualToRaw = new Map();
    return {
        async *listSourceKeys() {
            const valueRoots = [];
            for await (const rawKey of rootDatabase._rawKeysForSublevel(options.sourceSublevel)) valueRoots.push({ rawKey, valueRoot: rawPathToValueRoot(keyToRelativePath(rawKey), options.sourceSublevel, options.snapshotSublevel) });
            valueRoots.sort((a, b) => a.valueRoot < b.valueRoot ? -1 : a.valueRoot > b.valueRoot ? 1 : 0);
            for (const item of valueRoots) {
                const value = await rootDatabase._rawGetInSublevel(options.sourceSublevel, item.rawKey.slice(rawPrefix.length));
                for (const entry of projectValueRootToVirtualFiles(item.valueRoot, value)) { sourceVirtualToRaw.set(entry.key, item.rawKey); yield entry.key; }
            }
        },
        async *listTargetKeys() {
            const keys = [];
            const kindRoot = path.join(options.snapshotRoot, 'kindtree', options.snapshotSublevel);
            for (const file of await walkRegularFiles(capabilities, kindRoot)) {
                const rel = path.relative(kindRoot, file).split(path.sep).join('/');
                keys.push(makeKindtreeVirtualKey(`${options.snapshotSublevel}/${rel}`));
            }
            const renderedRoot = path.join(options.snapshotRoot, 'rendered', options.snapshotSublevel);
            const depth = options.sourceSublevel === '_meta' ? 1 : 2;
            for (const file of await walkRegularFiles(capabilities, renderedRoot)) {
                const segments = path.relative(renderedRoot, file).split(path.sep);
                const valueRoot = [options.snapshotSublevel, ...segments.slice(0, depth)].join('/');
                const descendant = segments.slice(depth).join('/');
                keys.push(makeRenderedVirtualKey(valueRoot, descendant));
            }
            keys.sort(); for (const key of keys) yield key;
        },
        async readSource(virtualKey) {
            const rawKey = sourceVirtualToRaw.get(virtualKey);
            if (rawKey === undefined) return undefined;
            const value = await rootDatabase._rawGetInSublevel(options.sourceSublevel, rawKey.slice(rawPrefix.length));
            return projectValueRootToVirtualFiles(rawPathToValueRoot(keyToRelativePath(rawKey), options.sourceSublevel, options.snapshotSublevel), value).find((entry) => entry.key === virtualKey)?.content;
        },
        async readTarget(virtualKey) { const abs = virtualKeyToPhysicalPath(options.snapshotRoot, virtualKey); return await capabilities.checker.fileExists(abs) ? await capabilities.reader.readFileAsText(abs) : undefined; },
        equals(first, second) { return first === second; },
        async putTarget(virtualKey, content) {
            if (typeof content !== 'string') throw new Error(`Expected virtual file text for '${virtualKey}'`);
            const abs = virtualKeyToPhysicalPath(options.snapshotRoot, virtualKey);
            const managedRoot = path.join(options.snapshotRoot, virtualKey.includes('\x00k\x00') ? 'kindtree' : 'rendered');
            await preparePathForRegularFile(capabilities, managedRoot, abs);
            const file = await capabilities.creator.createFile(abs); await capabilities.writer.writeFile(file, content);
        },
        async deleteTarget(virtualKey) { const abs = virtualKeyToPhysicalPath(options.snapshotRoot, virtualKey); if (await capabilities.checker.fileExists(abs)) await capabilities.deleter.deleteFile(abs); },
    };
}
module.exports = { makeDbToPairedFsAdapter, rawPathToValueRoot, valueRootToRawKey, preparePathForRegularFile };
