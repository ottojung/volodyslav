/**
 * FileRef: a first-class file abstraction that decouples file content from
 * filesystem paths.  A FileRef may be backed by an in-memory buffer (e.g. an
 * HTTP upload that has not yet been materialized to disk) or by an on-disk
 * file (e.g. a diary audio recording that already exists at a stable path).
 *
 * The canonical content accessor is `data()`.  The `path` field is optional
 * metadata – it MUST NOT be treated as the source of truth for content.
 *
 * Using FileRef at API boundaries prevents unnecessary temporary disk writes:
 * uploaded bytes can stay in memory (or in a temporary DB) until the final
 * assets storage write.
 */

const fs = require("fs").promises;
const path = require("path");

/**
 * @typedef {import('./file').ExistingFile} ExistingFile
 */

class FileRefClass {
    /**
     * Optional filesystem path.  Present when the content is backed by a
     * file on disk; undefined for purely in-memory refs.
     * @type {string | undefined}
     */
    path;

    /**
     * Returns the full file content as a Buffer.  May load from disk or
     * return a pre-loaded buffer depending on how the FileRef was created.
     * @type {() => Promise<Buffer>}
     */
    data;

    /**
     * Optional MIME type hint.
     * @type {string | undefined}
     */
    mimeType;

    /**
     * The basename used when writing this file to the assets directory.
     * Always set; never contains directory separators.
     * @type {string}
     */
    filename;

    /**
     * Nominal-typing brand – never actually assigned.
     * @private
     * @type {undefined}
     */
    __brand;

    /**
     * @param {string | undefined} filePath
     * @param {() => Promise<Buffer>} data
     * @param {string} filename
     * @param {string | undefined} mimeType
     */
    constructor(filePath, data, filename, mimeType) {
        this.path = filePath;
        this.data = data;
        this.filename = filename;
        this.mimeType = mimeType;
        if (this.__brand !== undefined) {
            throw new Error(
                "FileRef is a nominal type and should not be instantiated directly"
            );
        }
    }
}

/** @typedef {FileRefClass} FileRef */

/**
 * Type guard for FileRef.
 * @param {unknown} object
 * @returns {object is FileRef}
 */
function isFileRef(object) {
    return object instanceof FileRefClass;
}

/**
 * Create a FileRef backed by an in-memory buffer.
 * No filesystem I/O occurs until the buffer is explicitly written elsewhere.
 *
 * @param {string} filename - The basename for the file (no directory components).
 * @param {Buffer} buffer - The file content.
 * @param {string | undefined} [mimeType] - Optional MIME type.
 * @returns {FileRef}
 */
function makeFromBuffer(filename, buffer, mimeType) {
    return new FileRefClass(
        undefined,
        () => Promise.resolve(buffer),
        filename,
        mimeType
    );
}

/**
 * Create a FileRef from an existing on-disk file.
 * Content is read lazily from disk when `data()` is called.
 *
 * @param {ExistingFile} file - The on-disk file to wrap.
 * @returns {FileRef}
 */
function makeFromExistingFile(file) {
    const filename = path.basename(file.path);
    return new FileRefClass(
        file.path,
        () => fs.readFile(file.path),
        filename,
        undefined
    );
}

module.exports = {
    isFileRef,
    makeFromBuffer,
    makeFromExistingFile,
};
