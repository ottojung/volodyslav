/**
 * Handler for GET /entries/:id/assets
 *
 * Returns the list of asset files associated with an entry.
 * Files are stored in the assets directory at:
 *   $assetsDir/${year}-${month}/${day}/${entryId}/
 *
 * The entry's assets directory is located by scanning the assets root for a
 * subdirectory matching the entry ID, which avoids acquiring the incremental
 * graph mutex (used by the additional-properties route for AI computation) and
 * allows both routes to run concurrently.
 */

const path = require("path");
const { isDirScannerError } = require("../../filesystem").dirscanner;

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
    const audioExtensions = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".weba"];
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
 * @param {string} assetsDir - The assets root directory.
 * @param {string} assetsDirPath - The full path to the entry's assets directory.
 * @param {string} filename
 * @returns {string}
 */
function assetUrlPath(assetsDir, assetsDirPath, filename) {
    const relDir = path.relative(assetsDir, assetsDirPath);
    const encodedFilename = encodeURIComponent(filename);
    // relDir uses the OS path separator; normalise to forward slashes for the URL.
    const urlDir = relDir.split(path.sep).join("/");
    return `/assets/${urlDir}/${encodedFilename}`;
}

/**
 * Searches the assets root directory for the subdirectory belonging to the
 * given entry ID.  The layout is `<assetsDir>/<YYYY-MM>/<DD>/<entryId>/`.
 * Scanning instead of looking up the entry's date avoids acquiring the
 * incremental-graph mutex, allowing this endpoint to run concurrently with
 * additional-properties requests.
 * @param {string} assetsDir
 * @param {string} entryId
 * @param {Capabilities} capabilities
 * @returns {Promise<string | null>} Full path to the entry's asset directory, or null if not found.
 */
async function findEntryAssetsDir(assetsDir, entryId, capabilities) {
    const assetsDirProof = await capabilities.checker.directoryExists(assetsDir);
    if (assetsDirProof === null) return null;

    let yearMonthEntries;
    try {
        yearMonthEntries = await capabilities.scanner.scanDirectory(assetsDir);
    } catch (error) {
        if (isDirScannerError(error)) return null;
        throw error;
    }

    for (const yearMonthEntry of yearMonthEntries) {
        const ymProof = await capabilities.checker.directoryExists(yearMonthEntry.path);
        if (ymProof === null) continue;

        let dayEntries;
        try {
            dayEntries = await capabilities.scanner.scanDirectory(yearMonthEntry.path);
        } catch (error) {
            if (isDirScannerError(error)) continue;
            throw error;
        }

        for (const dayEntry of dayEntries) {
            const entryDir = path.join(dayEntry.path, entryId);
            const entryDirProof = await capabilities.checker.directoryExists(entryDir);
            if (entryDirProof !== null) {
                return entryDir;
            }
        }
    }

    return null;
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
        const assetsDir = capabilities.environment.eventLogAssetsDirectory();
        const dirPath = await findEntryAssetsDir(assetsDir, id, capabilities);

        if (dirPath === null) {
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
                url: assetUrlPath(assetsDir, dirPath, filename),
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
