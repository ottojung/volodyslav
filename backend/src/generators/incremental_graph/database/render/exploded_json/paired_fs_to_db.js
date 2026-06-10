const path = require('path');
const { relativePathToKey } = require('../../encoding');
const { parseTypeSchema } = require('./schema_codec');
const { scanExplodedJsonProjection } = require('./value_codec');
const { jsonStructuralEquals } = require('./value_equality');
const { walkRegularFiles } = require('./filesystem_tree');
const { MissingKindtreeRootError, ExtraRenderedFileError, DuplicateDecodedValueRootError } = require('./errors');
/** @typedef {import('../../root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {{reader:FileReader,checker:FileChecker,scanner:DirScanner}} PairedScanCapabilities */

/** @param {string} relativeValueRoot @param {string} targetSublevel @returns {string} */
function schemaRelativePathToRawKey(relativeValueRoot, targetSublevel) { return relativePathToKey(`${targetSublevel}/${relativeValueRoot}`); }

/** @param {PairedScanCapabilities} capabilities @param {RootDatabase} rootDatabase @param {{snapshotRoot:string,targetSublevel:string,snapshotSublevel:string}} options @returns {Promise<import('../../unification/core').UnificationAdapter>} */
async function makePairedFsToDbAdapter(capabilities, rootDatabase, options) {
    const kindRoot = path.join(options.snapshotRoot, 'kindtree', options.snapshotSublevel);
    const renderedRoot = path.join(options.snapshotRoot, 'rendered', options.snapshotSublevel);
    const kindExists = await capabilities.checker.directoryExists(kindRoot);
    const renderedFiles = await walkRegularFiles(capabilities, renderedRoot);
    if (!kindExists && renderedFiles.length > 0) throw new MissingKindtreeRootError(kindRoot, renderedRoot);
    const renderedContent = new Map();
    for (const file of renderedFiles) renderedContent.set(path.relative(renderedRoot, file).split(path.sep).join('/'), await capabilities.reader.readFileAsText(file));
    const claimed = new Set();
    const values = new Map();
    const roots = new Map();
    for (const schemaFile of await walkRegularFiles(capabilities, kindRoot)) {
        const relativeRoot = path.relative(kindRoot, schemaFile).split(path.sep).join('/');
        const rawKey = schemaRelativePathToRawKey(relativeRoot, options.targetSublevel);
        const previous = roots.get(rawKey);
        if (previous !== undefined) throw new DuplicateDecodedValueRootError(rawKey, previous, schemaFile);
        roots.set(rawKey, schemaFile);
        const schema = parseTypeSchema(await capabilities.reader.readFileAsText(schemaFile));
        const value = scanExplodedJsonProjection(schema, (descendantPath) => {
            const relativeLeaf = descendantPath === '' ? relativeRoot : `${relativeRoot}/${descendantPath}`;
            const content = renderedContent.get(relativeLeaf);
            if (content !== undefined) claimed.add(relativeLeaf);
            return content;
        });
        values.set(rawKey, value);
    }
    for (const relativeFile of renderedContent.keys()) if (!claimed.has(relativeFile)) throw new ExtraRenderedFileError(relativeFile);
    const rawPrefix = `!${options.targetSublevel}!`;
    return {
        async *listSourceKeys() { for (const key of [...values.keys()].sort()) yield key; },
        async *listTargetKeys() { for await (const key of rootDatabase._rawKeysForSublevel(options.targetSublevel)) yield key; },
        async readSource(key) { return values.get(key); },
        async readTarget(key) { return await rootDatabase._rawGetInSublevel(options.targetSublevel, key.slice(rawPrefix.length)); },
        equals: jsonStructuralEquals,
        async putTarget(key, value) { await rootDatabase._rawPut(key, value); },
        async deleteTarget(key) { await rootDatabase._rawDel(key); },
        async flush() { await rootDatabase._rawSync(); },
    };
}
module.exports = { makePairedFsToDbAdapter };
