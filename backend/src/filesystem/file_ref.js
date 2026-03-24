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

const path = require("path");

/**
 * @typedef {import('./file').ExistingFile} ExistingFile
 */

/**
 * Validate and return a safe basename for use as a FileRef filename.
 * Strips any leading directory components and rejects empty / dot names
 * to prevent path-traversal when `filename` is later joined to an assets
 * directory path.
 *
 * @param {string} filename
 * @returns {string}
 */
function validateFilename(filename) {
    const base = path.basename(filename);
    if (base === "" || base === "." || base === "..") {
        throw new Error(`Invalid filename for FileRef: "${filename}"`);
    }
    return base;
}

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
 * The filename is validated as a safe basename (no path separators, not "." or "..").
 *
 * @param {string} filename - The basename for the file (no directory components).
 * @param {Buffer} buffer - The file content.
 * @param {string | undefined} [mimeType] - Optional MIME type.
 * @returns {FileRef}
 */
function makeFromBuffer(filename, buffer, mimeType) {
    const safeFilename = validateFilename(filename);
    return new FileRefClass(
        undefined,
        () => Promise.resolve(buffer),
        safeFilename,
        mimeType
    );
}

/**
 * Create a FileRef with a custom data provider function.
 * This is the general-purpose factory used when the content source is neither
 * a plain buffer nor an existing file (e.g. a lazy LevelDB read).
 * The filename is validated as a safe basename.
 *
 * @param {string} filename - The basename for the file (no directory components).
 * @param {() => Promise<Buffer>} dataFn - Function that returns the file content.
 * @param {{path?: string, mimeType?: string}} [options] - Optional metadata.
 * @returns {FileRef}
 */
function makeFromData(filename, dataFn, options = {}) {
    const safeFilename = validateFilename(filename);
    return new FileRefClass(options.path, dataFn, safeFilename, options.mimeType);
}

/**
 * Create a FileRef from an existing on-disk file.
 * Content is read lazily from disk when `data()` is called, using the supplied
 * read function so that filesystem access is routed through capabilities.
 *
 * @param {ExistingFile} file - The on-disk file to wrap.
 * @param {(filePath: string) => Promise<Buffer>} readFileFn - Function that reads
 *   the file at `filePath` and returns its contents as a Buffer.
 *   Typically `(p) => capabilities.reader.readFileAsBuffer(p)`.
 * @returns {FileRef}
 */
function makeFromExistingFile(file, readFileFn) {
    const safeFilename = validateFilename(path.basename(file.path));
    return new FileRefClass(
        file.path,
        () => readFileFn(file.path),
        safeFilename,
        undefined
    );
}

module.exports = {
    isFileRef,
    makeFromBuffer,
    makeFromData,
    makeFromExistingFile,
};
