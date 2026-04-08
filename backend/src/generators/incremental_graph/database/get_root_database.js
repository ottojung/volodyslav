/**
 * Root database initialization utilities.
 *
 * Boot sequence (executed by getRootDatabase):
 *
 *  1. If the live LevelDB directory does not exist yet, attempt to restore
 *     its contents from the locally-rendered git snapshot
 *     (workingDirectory/generators-database/rendered/).
 *     This handles the case where the LevelDB was deleted or is absent on a
 *     fresh machine but a rendered snapshot already exists on disk.
 *
 *  2. Open/create the LevelDB via makeRootDatabase, which:
 *       a. Reads _meta/format; if it does not match FORMAT_MARKER, throws
 *          (satisfies "format mismatch → crash").
 *       b. If _meta/format is absent (truly empty database), writes the
 *          current FORMAT_MARKER and replica pointer.
 *
 *  3. The caller (internalEnsureInitializedWithMigration in lifecycle.js) then
 *     invokes runMigrationUnsafe, which reads x/meta.version and migrates when
 *     the stored version differs from the current application version
 *     (satisfies "version mismatch → migrate").
 */

const path = require('path');
const { pathToLiveDatabase, pathToRenderedDatabase } = require('./gitstore');
const { makeRootDatabase } = require('./root_database');
const { relativePathToKey, parseValue } = require('./render/encoding');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');

/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * Thrown when the database cannot be opened or created.
 */
class DatabaseInitializationError extends Error {
    /**
     * @param {string} message
     * @param {string} databasePath
     * @param {Error} [cause]
     */
    constructor(message, databasePath, cause) {
        super(message);
        this.name = 'DatabaseInitializationError';
        this.databasePath = databasePath;
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is DatabaseInitializationError}
 */
function isDatabaseInitializationError(object) {
    return object instanceof DatabaseInitializationError;
}

/**
 * Recursively collects the absolute paths of every file under `dir` using the
 * capabilities pattern.  Directories are traversed but not included.
 *
 * @param {DatabaseCapabilities} capabilities
 * @param {string} dir - Root directory to walk.
 * @returns {Promise<string[]>}
 */
async function walkFilesRecursively(capabilities, dir) {
    const children = await capabilities.scanner.scanDirectory(dir);
    /** @type {string[]} */
    const files = [];
    for (const child of children) {
        if (await capabilities.checker.directoryExists(child.path)) {
            const nested = await walkFilesRecursively(capabilities, child.path);
            files.push(...nested);
        } else if (await capabilities.checker.fileExists(child.path)) {
            files.push(child.path);
        }
    }
    return files;
}

/**
 * Reads every file under `inputDir` and writes the corresponding raw
 * key/value pairs into the already-opened `rawDb` under the given `sublevel`
 * prefix.  Keys are constructed with `relativePathToKey(sublevel + '/' + relPath)`.
 *
 * This is a thin, RootDatabase-free variant of scanFromFilesystem: it writes
 * directly to the Level instance so it can be used before the format-marker
 * check has taken place (i.e., before a RootDatabase has been constructed).
 *
 * @param {DatabaseCapabilities} capabilities
 * @param {import('abstract-level').AbstractLevel<any,any,any>} rawDb
 * @param {string} inputDir
 * @param {string} sublevel
 * @returns {Promise<number>} Number of entries written.
 */
async function rawScanDir(capabilities, rawDb, inputDir, sublevel) {
    const allFiles = await walkFilesRecursively(capabilities, inputDir);
    const sublevelPathPrefix = sublevel + '/';

    /** @type {Array<{ key: string, value: unknown }>} */
    const entries = [];
    for (const absPath of allFiles) {
        const relPath = path.relative(inputDir, absPath).split(path.sep).join('/');
        const key = relativePathToKey(sublevelPathPrefix + relPath);
        const content = await capabilities.reader.readFileAsText(absPath);
        const value = parseValue(content);
        entries.push({ key, value });
    }

    for (let i = 0; i < entries.length; i += RAW_BATCH_CHUNK_SIZE) {
        const chunk = entries.slice(i, i + RAW_BATCH_CHUNK_SIZE);
        await rawDb.batch(chunk.map((e) => ({ type: /** @type {'put'} */ ('put'), key: e.key, value: e.value })));
    }
    return entries.length;
}

/**
 * Attempts to populate a freshly-created (empty) LevelDB from the
 * locally-rendered git snapshot.
 *
 * The rendered snapshot lives at `workingDirectory/generators-database/rendered/`
 * and contains two subdirectories used here:
 *
 *  - `_meta/`  -> scanned as the `_meta` sublevel (includes the format marker
 *                 and current_replica pointer).
 *  - `r/`      -> scanned as the active-replica sublevel (`x` or `y`),
 *                 determined by reading `_meta/current_replica`.
 *
 * If the snapshot directory does not exist, or is missing the required files,
 * this function returns `false` without touching the database.  Any error
 * during the scan is propagated to the caller.
 *
 * @param {DatabaseCapabilities} capabilities
 * @param {string} databasePath - Path to the live LevelDB directory.
 * @returns {Promise<boolean>} `true` if data was written, `false` if no snapshot found.
 */
async function tryRestoreFromLocalSnapshot(capabilities, databasePath) {
    const snapshotDir = pathToRenderedDatabase(capabilities);

    if (!await capabilities.checker.directoryExists(snapshotDir)) {
        capabilities.logger.logInfo(
            { snapshotDir },
            'No local snapshot directory found; starting with a fresh database'
        );
        return false;
    }

    const metaDir = path.join(snapshotDir, '_meta');
    const rDir = path.join(snapshotDir, 'r');
    const currentReplicaFile = path.join(metaDir, 'current_replica');

    if (!await capabilities.checker.directoryExists(metaDir)) {
        capabilities.logger.logInfo(
            { snapshotDir },
            'Snapshot is missing _meta directory; skipping local-snapshot restore'
        );
        return false;
    }
    if (!await capabilities.checker.fileExists(currentReplicaFile)) {
        capabilities.logger.logInfo(
            { currentReplicaFile },
            'Snapshot is missing _meta/current_replica; skipping local-snapshot restore'
        );
        return false;
    }
    if (!await capabilities.checker.directoryExists(rDir)) {
        capabilities.logger.logInfo(
            { rDir },
            'Snapshot is missing r/ directory; skipping local-snapshot restore'
        );
        return false;
    }

    const raw = await capabilities.reader.readFileAsText(currentReplicaFile);
    let replica;
    try {
        replica = JSON.parse(raw);
    } catch {
        capabilities.logger.logWarning(
            { currentReplicaFile },
            'Snapshot _meta/current_replica is not valid JSON; skipping local-snapshot restore'
        );
        return false;
    }

    if (replica !== 'x' && replica !== 'y') {
        capabilities.logger.logWarning(
            { currentReplicaFile, replica },
            'Snapshot _meta/current_replica has unexpected value; skipping local-snapshot restore'
        );
        return false;
    }

    const rawDb = capabilities.levelDatabase.initialize(databasePath);
    try {
        await rawDb.open();
        const metaCount = await rawScanDir(capabilities, rawDb, metaDir, '_meta');
        const replicaCount = await rawScanDir(capabilities, rawDb, rDir, replica);
        capabilities.logger.logInfo(
            { databasePath, replica, metaCount, replicaCount },
            'Restored live database from local snapshot'
        );
    } finally {
        await rawDb.close();
    }

    return true;
}

/**
 * Gets or creates a RootDatabase instance for the generators module.
 * The database is stored in the Volodyslav data directory.
 *
 * Boot sequence:
 *  1. If the LevelDB directory is new (did not previously exist), attempt
 *     to restore it from the locally-rendered git snapshot so that existing
 *     data is not silently discarded.
 *  2. Open the LevelDB via makeRootDatabase, which enforces the format marker
 *     (crashes on mismatch) and reads the active-replica pointer.
 *
 * @param {DatabaseCapabilities} capabilities - The capabilities object
 * @returns {Promise<import('./root_database').RootDatabase>} The root database instance
 * @throws {DatabaseInitializationError} If database initialization fails
 */
async function getRootDatabase(capabilities) {
    const databasePath = pathToLiveDatabase(capabilities);

    const directoryAlreadyExists = !!(await capabilities.checker.directoryExists(databasePath));
    if (directoryAlreadyExists) {
        capabilities.logger.logInfo({ databasePath }, 'Database directory exists');
    } else {
        capabilities.logger.logInfo({ databasePath }, 'Database directory does not exist, will be created');
    }

    // Ensure the LevelDB directory exists before LevelDB opens.
    try {
        await capabilities.creator.createDirectory(databasePath);
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new DatabaseInitializationError(
            `Failed to create data directory: ${err.message}`,
            databasePath,
            err
        );
    }

    // When the LevelDB is brand-new, attempt to restore from the locally-rendered
    // snapshot before makeRootDatabase runs its format-marker check.  This ensures
    // that a deleted or absent LevelDB is recovered from on-disk data rather than
    // silently starting as an empty database.
    if (!directoryAlreadyExists) {
        try {
            await tryRestoreFromLocalSnapshot(capabilities, databasePath);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            capabilities.logger.logWarning(
                { databasePath, error: err.message, stack: err.stack },
                'Failed to restore from local snapshot; proceeding with empty database'
            );
        }
    }

    // Open or create the database
    try {
        const db = await makeRootDatabase(capabilities, databasePath);
        capabilities.logger.logDebug({ databasePath }, 'Root database opened');
        return db;
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new DatabaseInitializationError(
            `Failed to open root database: ${err.message}`,
            databasePath,
            err
        );
    }
}

module.exports = {
    DatabaseInitializationError,
    isDatabaseInitializationError,
    getRootDatabase,
};
