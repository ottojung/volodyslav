const multer = require("multer");
const { fromRequest, makeDirectory } = require("./request_identifier");

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/creator').FileCreator} Creator */
/** @typedef {import('./filesystem/checker').FileChecker} Checker */
/** @typedef {import('./environment').Environment} Environment */

/**
 * Minimal capabilities needed for storage operations
 * @typedef {object} StorageCapabilities
 * @property {Creator} creator - A file system creator instance
 * @property {Environment} environment - An environment instance
 */

/**
 * Multer storage engine to save uploaded files to disk
 * @param {StorageCapabilities} capabilities - The minimal capabilities needed for storage operations
 * @returns {import('multer').StorageEngine}
 */
function makeStorage(capabilities) {
    return multer.diskStorage({
        /**
         * @param {import('express').Request} req
         * @param {Express.Multer.File} _file
         * @param {(error: Error|null, destination: string) => void} cb
         */
        destination: (req, _file, cb) => {
            let reqId;
            try {
                reqId = fromRequest(req);
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                cb(error, "");
                return;
            }

            makeDirectory(capabilities, reqId)
                .then((targetDir) => cb(null, targetDir))
                .catch((err) => cb(err, ""));
        },

        /**
         * @param {import('express').Request} _req
         * @param {Express.Multer.File} file
         * @param {(error: Error|null, filename: string) => void} cb
         */
        filename: (_req, file, cb) => cb(null, file.originalname),
    });
}

/**
 * @param {StorageCapabilities} capabilities
 */
function makeUpload(capabilities) {
    const storage = makeStorage(capabilities);
    return multer({ storage });
}

// Export multer upload middleware using disk storage
module.exports = { makeUpload };
