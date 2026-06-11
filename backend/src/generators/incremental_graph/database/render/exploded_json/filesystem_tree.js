const path = require('path');
const { UnsupportedFilesystemEntryError } = require('./errors');
/** @typedef {import('../../../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {{checker: FileChecker, scanner: DirScanner}} TreeCapabilities */
/** @param {TreeCapabilities} capabilities @param {string} root @returns {Promise<string[]>} */
async function walkRegularFiles(capabilities, root) {
    if (!await capabilities.checker.directoryExists(root)) return [];
    /** @type {string[]} */
    const files = [];
    /** @param {string} directory @returns {Promise<void>} */
    async function visit(directory) {
        const children = await capabilities.scanner.scanDirectory(directory);
        for (const child of children) {
            if (await capabilities.checker.directoryExists(child.path)) await visit(child.path);
            else if (await capabilities.checker.fileExists(child.path)) files.push(child.path);
            else throw new UnsupportedFilesystemEntryError(child.path);
        }
    }
    await visit(root);
    return files.sort((first, second) => {
        const a = path.relative(root, first); const b = path.relative(root, second);
        return a < b ? -1 : a > b ? 1 : 0;
    });
}
module.exports = { walkRegularFiles };
