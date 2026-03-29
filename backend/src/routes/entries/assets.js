/**
 * Handler for GET /entries/:id/assets
 *
 * Returns the list of asset files associated with an entry.
 * Files are stored in the assets directory at:
 *   $assetsDir/${year}-${month}/${day}/${entryId}/
 */

const path = require("path");
const { getEntryById } = require("../../entry");
const { isDirScannerError } = require("../../filesystem").dirscanner;
const { targetDir } = require("../../event").asset;

/** @typedef {import('../../environment').Environment} Environment */
/** @typedef {import('../../logger').Logger} Logger */
/** @typedef {import('../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../../request_identifier').RequestIdentifier} RequestIdentifier */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {DirScanner} scanner - A directory scanner instance.
 * @property {import('../../filesystem/appender').FileAppender} appender - A file appender instance.
 * @property {import('../../filesystem/creator').FileCreator} creator - A directory creator instance.
 * @property {import('../../filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('../../datetime').Datetime} datetime - Datetime utilities.
 * @property {import('../../subprocess/command').Command} git - A command instance for Git operations.
 * @property {import('../../random/seed').NonDeterministicSeed} seed - A random number generator.
 * @property {import('../../filesystem/deleter').FileDeleter} deleter - A file deleter instance.
 * @property {import('../../filesystem/copier').FileCopier} copier - A file copier instance.
 * @property {import('../../filesystem/writer').FileWriter} writer - A file writer instance.
 * @property {import('../../sleeper').SleepCapability} sleeper - A sleeper instance.
 * @property {import('../../generators').Interface} interface - The incremental graph interface.
 */

/**
 * @typedef {object} AssetInfo
 * @property {string} filename - The filename of the asset.
 * @property {string} url - The URL path to access the asset (relative to /api).
 * @property {'image'|'audio'|'other'} mediaType - The media type of the asset.
 */

/**
 * Determines the media type of a file from its extension.
 * @param {string} filename
 * @returns {'image'|'audio'|'other'}
 */
function mediaTypeFromFilename(filename) {
    const ext = path.extname(filename).toLowerCase();
    const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp", ".tiff", ".tif"];
    const audioExtensions = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".weba", ".webm"];
    if (imageExtensions.includes(ext)) {
        return "image";
    }
    if (audioExtensions.includes(ext)) {
        return "audio";
    }
    return "other";
}

/**
 * Computes the URL path for an asset file (relative to /api).
 * @param {import('../../event/structure').Event} entry
 * @param {string} filename
 * @returns {string}
 */
function assetUrlPath(entry, filename) {
    const date = entry.date;
    const year = date.year;
    const month = date.month.toString().padStart(2, "0");
    const day = date.day.toString().padStart(2, "0");
    const encodedFilename = encodeURIComponent(filename);
    return `/assets/${year}-${month}/${day}/${entry.id.identifier}/${encodedFilename}`;
}

/**
 * Handles the GET /entries/:id/assets logic.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Capabilities} capabilities
 * @param {RequestIdentifier} reqId
 * @returns {Promise<void>}
 */
async function handleEntryAssets(req, res, capabilities, reqId) {
    const { id } = req.params;

    if (typeof id !== "string" || id.trim() === "") {
        res.status(400).json({ error: "Invalid entry id" });
        return;
    }

    try {
        const entry = await getEntryById(capabilities, id);

        if (entry === null) {
            res.status(404).json({ error: "Entry not found" });
            return;
        }

        const dirPath = targetDir(capabilities, entry);

        const dirProof = await capabilities.checker.directoryExists(dirPath);

        if (dirProof === null) {
            res.json({ assets: [] });
            return;
        }

        const files = await capabilities.scanner.scanDirectory(dirPath);

        /** @type {AssetInfo[]} */
        const assets = [];

        for (const file of files) {
            const proof = await capabilities.checker.fileExists(file.path);

            if (proof === null) {
                continue;
            }

            const filename = path.basename(file.path);
            assets.push({
                filename,
                url: assetUrlPath(entry, filename),
                mediaType: mediaTypeFromFilename(filename),
            });
        }

        res.json({ assets });
    } catch (error) {
        if (isDirScannerError(error)) {
            res.json({ assets: [] });
            return;
        }

        const message = error instanceof Error ? error.message : String(error);

        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                error: message,
                error_name: error instanceof Error ? error.name : "Unknown",
                stack: error instanceof Error ? error.stack : undefined,
                entry_id: id,
                client_ip: req.ip,
            },
            `Failed to fetch assets for entry ${id}: ${message}`,
        );

        res.status(500).json({ error: "Internal server error" });
    }
}

module.exports = { handleEntryAssets };
