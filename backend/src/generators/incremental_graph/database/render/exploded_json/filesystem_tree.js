/**
 * @file Filesystem tree scanning and path resolution.
 *
 * Distinguishes missing, regular file, directory, and unsupported entry kinds.
 * Used for scan validation of the rendered/ tree.
 */

/**
 * @typedef {"missing"|"file"|"directory"|"unsupported"} EntryKind
 */

/**
 * @typedef {import('../../../../../filesystem/checker').FileChecker} FileChecker
 * @typedef {import('../../../../../filesystem/dirscanner').DirScanner} DirScanner
 */

/**
 * Determine the kind of an entry at a given path.
 *
 * @param {FileChecker} checker
 * @param {string} absPath
 * @returns {Promise<EntryKind>}
 */
async function entryKind(checker, absPath) {
    try {
        if (await checker.fileExists(absPath)) return "file";
        if (await checker.directoryExists(absPath)) return "directory";
    } catch (e) {
        return "unsupported";
    }
    return "missing";
}

/**
 * Prepare a path for a regular file: ensure all parent directories exist,
 * and if the target path is a directory, delete it recursively.
 *
 * @param {import('../../../../../filesystem/creator').FileCreator} creator
 * @param {import('../../../../../filesystem/checker').FileChecker} checker
 * @param {import('../../../../../filesystem/deleter').FileDeleter} deleter
 * @param {string} absPath - Absolute path of the target regular file.
 */
async function preparePathForRegularFile(creator, checker, deleter, absPath) {
    const path = require('path');
    const dir = path.dirname(absPath);
    // Walk from the managed root creating parent directories as needed
    const segments = dir.split(path.sep);
    let current = segments[0] || '/';
    for (let i = 1; i < segments.length; i++) {
        const segment = segments[i];
        if (segment === undefined) continue;
        current = path.join(current, segment);
        const kind = await entryKind(checker, current);
        if (kind === "file") {
            await deleter.deleteFile(current);
        }
        if (kind === "missing" || kind === "unsupported") {
            await creator.createDirectory(current);
        }
    }
    // If the target path is a directory, replace it
    const targetKind = await entryKind(checker, absPath);
    if (targetKind === "directory") {
        await deleter.deleteDirectory(absPath);
    }
}

module.exports = {
    entryKind,
    preparePathForRegularFile,
};
