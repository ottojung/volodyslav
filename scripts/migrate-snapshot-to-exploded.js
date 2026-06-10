#!/usr/bin/env node
/**
 * Convert an old-format rendered snapshot (single JSON file per DB value)
 * to the new exploded JSON format with paired kindtree/ and rendered/ trees.
 *
 * The old format stores each DB value as one JSON file under rendered/.
 * The new format stores:
 *   kindtree/<value-root>           — type schema file
 *   rendered/<value-root>/<leaves>  — exploded primitive leaf files
 *
 * Usage: node scripts/migrate-snapshot-to-exploded.js <snapshot-dir>
 *
 * The snapshot directory is modified IN PLACE.
 */

const path = require("path");
const fs = require("fs/promises");

const { parseValue } = require("../backend/src/generators/incremental_graph/database/encoding");
const { projectExplodedJsonValue } = require("../backend/src/generators/incremental_graph/database/render/exploded_json");

/**
 * Walk a directory recursively, returning all regular file paths relative to baseDir.
 *
 * @param {string} dir - Directory to walk.
 * @param {string} baseDir - Base directory for relative paths.
 * @returns {Promise<string[]>}
 */
async function walkFiles(dir, baseDir) {
    const files = [];
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return files;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nested = await walkFiles(fullPath, baseDir);
            files.push(...nested);
        } else if (entry.isFile()) {
            files.push(path.relative(baseDir, fullPath));
        }
    }
    return files;
}

/**
 * Migrate an old-format snapshot to the new paired format.
 * Modifies the directory IN PLACE.
 *
 * @param {string} snapshotDir - Root of the snapshot (containing rendered/).
 */
async function migrateSnapshot(snapshotDir) {
    const renderedDir = path.join(snapshotDir, "rendered");
    try {
        await fs.stat(renderedDir);
    } catch {
        throw new Error(`Snapshot directory does not contain rendered/: ${snapshotDir}`);
    }

    // Check if already migrated: kindtree exists and has files
    const kindtreeDir = path.join(snapshotDir, "kindtree");
    let alreadyMigrated = false;
    try {
        const kindtreeEntries = await fs.readdir(kindtreeDir);
        if (kindtreeEntries.length > 0) {
            alreadyMigrated = true;
        }
    } catch {
        // kindtree doesn't exist yet
    }
    if (alreadyMigrated) {
        console.log("Snapshot already migrated (kindtree/ exists), nothing to do.");
        return;
    }

    // Walk all files under rendered/
    const allFiles = await walkFiles(renderedDir, renderedDir);
    // Group files by value root.
    // Old format layouts:
    //   rendered/_meta/current_replica            → value root: _meta/current_replica
    //   rendered/r/global/version                 → value root: r/global/version
    //   rendered/r/values/nodeid123               → value root: r/values/nodeid123
    //   rendered/r/values/nodeid123/subkey        → value root: r/values/nodeid123 (subkey is part of value)

    /** @type {Map<string, { relPath: string, content: string }[]>} */
    const valueRootFiles = new Map();
    for (const relPath of allFiles) {
        // Skip files that don't look like old-format value files
        const parts = relPath.split("/");
        if (parts.length < 2) continue;

        // Determine value root depth:
        // - _meta/<key>          → 2 segments
        // - r/<sublevel>/<key>   → 3 segments
        const depth = parts[0] === '_meta' ? 2 : 3;
        if (parts.length < depth) continue;

        const valueRoot = parts.slice(0, depth).join("/");
        if (!valueRootFiles.has(valueRoot)) {
            valueRootFiles.set(valueRoot, []);
        }
        valueRootFiles.get(valueRoot).push({ relPath, content: '' });
    }

    let migratedCount = 0;

    for (const [valueRoot, fileEntries] of valueRootFiles) {
        for (const entry of fileEntries) {
            const absPath = path.join(renderedDir, entry.relPath);
            try {
                entry.content = await fs.readFile(absPath, "utf-8");
            } catch {
                continue;
            }

            let value;
            try {
                value = parseValue(entry.content);
            } catch {
                continue;
            }

            let projection;
            try {
                projection = projectExplodedJsonValue(value);
            } catch {
                continue;
            }

            // Delete old single-file JSON value FIRST so its path can become a directory
            try {
                await fs.unlink(absPath);
            } catch {
                // may already be gone
            }

            // Write kindtree schema file
            const kindtreeAbsPath = path.join(kindtreeDir, valueRoot);
            await fs.mkdir(path.dirname(kindtreeAbsPath), { recursive: true });
            await fs.writeFile(kindtreeAbsPath, projection.schemaText, "utf-8");

            // Write rendered leaf files
            for (const leaf of projection.leaves) {
                const leafParts = leaf.descendantPath ? leaf.descendantPath.split("/") : [];
                const leafAbsPath = path.join(renderedDir, valueRoot, ...leafParts);
                await fs.mkdir(path.dirname(leafAbsPath), { recursive: true });
                await fs.writeFile(leafAbsPath, leaf.content, "utf-8");
            }

            migratedCount++;
        }
    }

    // Clean up empty directories under rendered/
    await cleanEmptyDirs(renderedDir);

    console.log(`Migrated ${migratedCount} value(s) to exploded format.`);
}

/**
 * Recursively remove empty directories.
 *
 * @param {string} dir
 */
async function cleanEmptyDirs(dir) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                await cleanEmptyDirs(path.join(dir, entry.name));
            }
        }
        const remaining = await fs.readdir(dir);
        if (remaining.length === 0) {
            await fs.rmdir(dir);
        }
    } catch {
        // ignore
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
