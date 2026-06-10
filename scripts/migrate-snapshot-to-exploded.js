#!/usr/bin/env node
/**
 * Convert an old-format rendered-only JSON snapshot (single JSON file per DB
 * value) to the new paired exploded JSON format.
 *
 * Input:  old rendered-only snapshot root containing rendered/ with single
 *         JSON files for each DB value
 * Output: paired snapshot root with sibling kindtree/ and rendered/ trees
 *
 * The snapshot directory is modified IN PLACE. Callers should run this on a
 * git working tree or backed-up snapshot; the apply phase is not transactional
 * across the filesystem.
 *
 * Migration rules:
 * - rendered/ must exist and must be a directory. If rendered exists but is
 *   not a directory, the script fails.
 * - Every regular file under rendered/ must be at a valid old-format depth:
 *   _meta/<key>                  (depth 2)
 *   <replica>/<sublevel>/<key>   (depth 3)
 * - Regular files at other depths are invalid input.
 * - Every old value file must contain valid JSON that can be projected into
 *   the exploded format.
 * - Invalid JSON or unsupported values cause hard failure before mutation.
 * - Symlinks, special files, and other non-regular-file entries under rendered/
 *   are invalid input.
 * - Unreadable directories under rendered/ cause hard failure.
 * - If kindtree/ already contains regular files, the snapshot is treated as
 *   already migrated and the script is a no-op.
 * - kindtree/ containing only empty directories does not block migration.
 * - Empty rendered/ input (no regular files) produces a valid empty snapshot
 *   root: rendered/ is removed if empty, kindtree/ is absent, snapshotRoot
 *   remains. No marker files or manifests are created.
 * - The script uses a two-phase approach: preflight (validate all input and
 *   build a migration plan) then apply (delete old files, write new ones).
 * - Partial mixed states are not a supported repair target.
 * - Failed input does not partially mutate the snapshot.
 */

const path = require("path");
const fs = require("fs/promises");

const { parseValue } = require("../backend/src/generators/incremental_graph/database/encoding");
const { projectExplodedJsonValue } = require("../backend/src/generators/incremental_graph/database/render/exploded_json");

/**
 * Walk a directory recursively, returning all regular file paths relative
 * to baseDir.
 * @param {string} dir
 * @param {string} baseDir
 * @returns {Promise<string[]>}
 */
async function walkFiles(dir, baseDir) {
    const files = [];
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
        throw new Error(`Failed to read directory '${dir}': ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = await walkFiles(fullPath, baseDir);
            files.push(...nested);
        } else if (entry.isFile()) {
            files.push(path.relative(baseDir, fullPath));
        } else {
            const relPath = path.relative(baseDir, fullPath);
            throw new Error(
                `Unsupported entry '${relPath}' under rendered/: expected regular file or directory, got ${entry.isSymbolicLink() ? 'symlink' : 'special entry'}`
            );
        }
    }
    return files;
}

/**
 * Check whether kindtree/ contains at least one regular file (indicating
 * an already-migrated snapshot). Empty directories are not sufficient.
 * @param {string} kindtreeDir
 * @returns {Promise<boolean>}
 */
async function kindtreeHasRegularFiles(kindtreeDir) {
    let entries;
    try {
        entries = await fs.readdir(kindtreeDir, { withFileTypes: true });
    } catch (err) {
        if (/** @type {any} */ (err).code === 'ENOENT') return false;
        throw new Error(`Failed to read kindtree directory '${kindtreeDir}': ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const entry of entries) {
        const fullPath = path.join(kindtreeDir, entry.name);
        if (entry.isFile()) return true;
        if (entry.isDirectory()) {
            if (await kindtreeHasRegularFiles(fullPath)) return true;
        }
    }
    return false;
}

/**
 * @typedef {object} MigrationEntry
 * @property {string} valueRoot - The old-format value root path
 *   (_meta/<key> or <replica>/<sublevel>/<key>)
 * @property {string} oldAbsPath - Absolute path of the old single-JSON file
 * @property {import('../backend/src/generators/incremental_graph/database/render/exploded_json').ValueProjection} projection
 */

/**
 * @typedef {object} MigrationPlan
 * @property {MigrationEntry[]} entries - Entries to migrate
 * @property {boolean} emptyInput - Whether rendered/ had no regular files
 */

/**
 * Preflight: validate all input files and build a complete migration plan
 * without deleting or writing anything.
 *
 * @param {string} snapshotDir - Paired snapshot root
 * @returns {Promise<MigrationPlan>}
 */
async function buildMigrationPlan(snapshotDir) {
    const renderedDir = path.join(snapshotDir, "rendered");

    // Check rendered/ exists and is a directory
    let renderedStat;
    try {
        renderedStat = await fs.stat(renderedDir);
    } catch {
        throw new Error(`Snapshot directory does not contain rendered/: ${snapshotDir}`);
    }
    if (!renderedStat.isDirectory()) {
        throw new Error(`rendered/ is not a directory in snapshot: ${snapshotDir}`);
    }

    // Walk all files under rendered/
    const allFiles = await walkFiles(renderedDir, renderedDir);

    if (allFiles.length === 0) {
        return { entries: [], emptyInput: true };
    }

    /** @type {MigrationEntry[]} */
    const entries = [];

    for (const relPath of allFiles) {
        const parts = relPath.split("/");

        // Determine expected depth for old-format value files:
        // _meta/<key>          → 2 segments
        // <replica>/<sublevel>/<key> → 3 segments
        const depth = parts[0] === "_meta" ? 2 : 3;

        if (parts.length !== depth) {
            throw new Error(
                `Unexpected file depth in old-format snapshot: '${relPath}' has ${parts.length} segment(s), expected ${depth}. Old-format value files must be at depth ${depth === 2 ? '_meta/<key>' : '<replica>/<sublevel>/<key>'}`
            );
        }

        const valueRoot = parts.slice(0, depth).join("/");
        const absPath = path.join(renderedDir, relPath);
        const content = await fs.readFile(absPath, "utf-8");

        let value;
        try {
            value = parseValue(content);
        } catch (err) {
            throw new Error(
                `Invalid JSON in old-format file '${relPath}': ${err instanceof Error ? err.message : String(err)}`
            );
        }

        let projection;
        try {
            projection = projectExplodedJsonValue(value);
        } catch (err) {
            throw new Error(
                `Unsupported JSON value in old-format file '${relPath}': ${err instanceof Error ? err.message : String(err)}`
            );
        }

        entries.push({ valueRoot, oldAbsPath: absPath, projection });
    }

    return { entries, emptyInput: false };
}

/**
 * Apply the migration plan: delete old files and write kindtree schema files
 * and rendered primitive leaf files.
 *
 * @param {string} snapshotDir
 * @param {MigrationPlan} plan
 */
async function applyMigrationPlan(snapshotDir, plan) {
    const renderedDir = path.join(snapshotDir, "rendered");
    const kindtreeDir = path.join(snapshotDir, "kindtree");

    if (plan.emptyInput) {
        // No old-format files to migrate; clean up empty rendered/
        await cleanEmptyDirs(renderedDir);
        return;
    }

    for (const entry of plan.entries) {
        // Delete old single-file JSON value FIRST so its path can become
        // a directory
        await fs.unlink(entry.oldAbsPath);

        // Write kindtree schema file
        const kindtreeAbsPath = path.join(kindtreeDir, entry.valueRoot);
        await fs.mkdir(path.dirname(kindtreeAbsPath), { recursive: true });
        await fs.writeFile(kindtreeAbsPath, entry.projection.schemaText, "utf-8");

        // Write rendered leaf files
        for (const leaf of entry.projection.leaves) {
            const leafParts = leaf.descendantPath
                ? leaf.descendantPath.split("/")
                : [];
            const leafAbsPath = path.join(renderedDir, entry.valueRoot, ...leafParts);
            await fs.mkdir(path.dirname(leafAbsPath), { recursive: true });
            await fs.writeFile(leafAbsPath, leaf.content, "utf-8");
        }
    }

    // Clean up empty directories under rendered/
    await cleanEmptyDirs(renderedDir);
}

/**
 * Migrate an old-format snapshot to the new paired format.
 * Modifies the directory IN PLACE.
 *
 * @param {string} snapshotDir - Root of the snapshot (containing rendered/).
 */
async function migrateSnapshot(snapshotDir) {
    // Check if already migrated: kindtree/ contains at least one regular file
    const kindtreeDir = path.join(snapshotDir, "kindtree");
    if (await kindtreeHasRegularFiles(kindtreeDir)) {
        console.log("Snapshot already migrated (kindtree/ contains schema files), nothing to do.");
        return;
    }

    // Phase 1: Preflight — validate all input, build migration plan
    const plan = await buildMigrationPlan(snapshotDir);

    // Phase 2: Apply — delete old files, write new ones
    await applyMigrationPlan(snapshotDir, plan);

    if (plan.emptyInput) {
        console.log("Migrated 0 value(s) (empty rendered/ input).");
    } else {
        console.log(`Migrated ${plan.entries.length} value(s) to exploded format.`);
    }
}

/**
 * Recursively remove empty directories.
 * @param {string} dir
 */
async function cleanEmptyDirs(dir) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            await cleanEmptyDirs(path.join(dir, entry.name));
        }
    }
    const remaining = await fs.readdir(dir);
    if (remaining.length === 0) {
        await fs.rmdir(dir);
    }
}

// ─── CLI entry point ────────────────────────────────────────────────────────

async function main() {
    const snapshotDir = process.argv[2];
    if (!snapshotDir) {
        console.error("Usage: node scripts/migrate-snapshot-to-exploded.js <snapshot-dir>");
        process.exit(1);
    }

    const absDir = path.resolve(snapshotDir);
    const renderedDir = path.join(absDir, "rendered");

    try {
        await fs.stat(renderedDir);
    } catch {
        console.error(`Error: ${renderedDir} does not exist.`);
        process.exit(1);
    }

    console.log(`Migrating snapshot: ${absDir}`);
    await migrateSnapshot(absDir);
    console.log("Done.");
}

if (require.main === module) {
    main().catch((err) => {
        console.error("Migration failed:", err);
        process.exit(1);
    });
}

module.exports = { migrateSnapshot };
