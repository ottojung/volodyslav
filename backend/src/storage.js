const multer = require("multer");
const { fromRequest, makeDirectory } = require("./request_identifier");

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/creator').FileCreator} Creator */
/** @typedef {import('./filesystem/checker').FileChecker} Checker */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {Creator} creator - A file system creator instance.
 * @property {Checker} checker - A file system checker instance.
 */

/**
 * Multer storage engine to save uploaded files to disk
 * @param {Capabilities} capabilities
 * @returns {import('multer').StorageEngine}
 */
function makeStorage(capabilities) {
    return multer.diskStorage({
        /**
         * @param {import('express').Request} req
         * @param {Express.Multer.File} _file
         * @param {(error: Error|null, destination: string) => void} cb
         */
        destination: async (req, _file, cb) => {
            const reqId = fromRequest(req);
            const targetDir = await makeDirectory(capabilities, reqId);
            cb(null, targetDir);
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
 * @param {Capabilities} capabilities
 */
function makeUpload(capabilities) {
    const storage = makeStorage(capabilities);
    return multer({ storage });
}

// Export multer upload middleware using disk storage
module.exports = { makeUpload };
