#!/usr/bin/env node
/**
 * Migrate an old-format incremental-graph snapshot directory to the new
 * identifier-based format.
 *
 * Old format:
 *   rendered/r/values/all_events        (zero-arg node → bare head name)
 *   rendered/r/values/event/id123       (parameterized → head/arg1/arg2/...)
 *   rendered/r/inputs/events_count      = { inputs: ["{\"head\":\"all_events\",\"args\":[]}"], inputCounters: [1] }
 *   rendered/r/revdeps/all_events       = ["{\"head\":\"events_count\",\"args\":[]}"]
 *   rendered/_meta/current_replica      = "x"
 *   rendered/r/global/version           = "0.0.0-dev-previous"
 *   (no identifiers_keys_map)
 *
 * New format:
 *   rendered/r/values/abcdefghi         (9-letter opaque identifier, single segment)
 *   rendered/r/inputs/abcdefghi         = { inputs: ["abcdefghj"], inputCounters: [1] }
 *   rendered/r/revdeps/abcdefghj        = ["abcdefghi"]
 *   rendered/_meta/current_replica      = "x"
 *   rendered/r/global/version           = "0.0.0-dev-previous"
 *   rendered/r/global/identifiers_keys_map = [["abcdefghi", "{\"head\":\"all_events\",\"args\":[]}"], ...]
 *
 * Usage: node scripts/migrate-snapshot-to-identifiers.js <snapshot-dir>
 *
 * The snapshot directory is modified IN PLACE.
 */

const path = require("path");
const fs = require("fs/promises");
const { basicString } = require("../backend/src/random/basic_string");
const { compareConstValue } = require("../backend/src/generators/incremental_graph/database/node_key");

const MIGRATED_VERSION = "0.0.0-dev";

// ─── Old-format path parsing ────────────────────────────────────────────────

const DATA_SUBLEVELS = new Set([
    "values", "freshness", "inputs", "revdeps", "counters", "timestamps",
]);

/**
 * Decode a percent-encoded path segment (matches encoding.js decodeSegment).
 * @param {string} s
 * @returns {string}
 */
function decodeSegment(s) {
    if (/^%00$/i.test(s)) return "";
    if (/^%2e$/i.test(s)) return ".";
    if (/^%2e%2e$/i.test(s)) return "..";
    return s.replace(/%21/gi, "!").replace(/%2F/gi, "/").replace(/%25/gi, "%");
}

/**
 * Decode an old-format encoded argument back to its semantic value.
 *
 * The old rendered format encoded arguments with a tilde prefix scheme:
 *   - Strings starting with `~` were escaped as `~~` (e.g., "~abc" → ~~abc)
 *   - Non-string values were prefixed with `~` and the remainder was treated
 *     as JSON (e.g., number 42 → ~42, boolean true → ~true, null → ~null,
 *     array [1,2] → ~[1,2], object {"a":1} → ~{"a":1})
 *   - Plain strings were stored as-is (e.g., "hello" → hello)
 *
 * @param {string} s - Decoded (percent-decoded) path segment.
 * @returns {unknown} The semantic argument value.
 */
function decodeArg(s) {
    if (s.startsWith("~~")) {
        return s.slice(1);
    }
    if (s.startsWith("~")) {
        return JSON.parse(s.slice(1));
    }
    return s;
}

/**
 * Parse an old-format file path (relative to rendered/) into a node key JSON string.
 *
 * @param {string} relPath - e.g. "r/values/all_events" or "r/values/event/id123"
 * @returns {{ sublevel: string, nodeKeyJson: string } | null}
 */
function parseOldPath(relPath) {
    const segments = relPath.split("/");
    // Must be at least: replica(1) + sublevel(1) + key(1) = 3 segments
    if (segments.length < 3) return null;

    const replica = segments[0]; // "r"
    if (replica !== "r") return null;

    const sublevel = segments[1]; // "values", "freshness", etc.
    if (!DATA_SUBLEVELS.has(sublevel)) return null;

    const keyComponents = segments.slice(2); // ["all_events"] or ["event", "id123"]
    if (keyComponents.length === 0) return null;

    // In the old format, zero-arg nodes have a single segment (bare head name).
    // Parameterized nodes have head/arg1/arg2/...
    const head = decodeSegment(keyComponents[0]);
    const args = keyComponents.slice(1).map((s) => decodeArg(decodeSegment(s)));

    const nodeKeyJson = JSON.stringify({ head, args });
    return { sublevel, nodeKeyJson };
}

/**
 * Compare two old-format node key JSON strings using the same canonical
 * ordering as the production compareNodeKey: head lexicographically, then
 * arity, then each argument via compareConstValue.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareOldNodeKeyJson(left, right) {
    const leftKey = JSON.parse(left);
    const rightKey = JSON.parse(right);

    if (leftKey.head < rightKey.head) return -1;
    if (leftKey.head > rightKey.head) return 1;

    if (leftKey.args.length !== rightKey.args.length) {
        return leftKey.args.length - rightKey.args.length;
    }

    for (let i = 0; i < leftKey.args.length; i++) {
        const cmp = compareConstValue(leftKey.args[i], rightKey.args[i]);
        if (cmp !== 0) return cmp;
    }

    return 0;
}

// ─── Reference conversion ───────────────────────────────────────────────────

/**
 * Check if a string looks like a serialized JSON node key (old format).
 */
function isOldFormatReference(str) {
    if (typeof str !== "string") return false;
    return str.startsWith('{"head":');
}

/**
 * Convert old-format references in inputs/revdeps values to identifier strings.
 * @param {unknown} value - The parsed JSON value from an inputs or revdeps file.
 * @param {(nodeKeyJson: string) => string} keyToId - Maps node key JSON → identifier
 * @returns {unknown} The value with references converted.
 */
function convertReferences(value, keyToId) {
    if (typeof value === "string") {
        if (isOldFormatReference(value)) {
            const id = keyToId(value);
            if (id === undefined) {
                throw new Error(`Cannot find identifier for reference: ${value}`);
            }
            return id;
        }
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => convertReferences(item, keyToId));
    }

    if (value !== null && typeof value === "object") {
        const result = {};
        for (const [k, v] of Object.entries(value)) {
            if (k === "inputs" && Array.isArray(v)) {
                // inputs array: convert each element
                result[k] = v.map((ref) => {
                    if (typeof ref === "string" && isOldFormatReference(ref)) {
                        const id = keyToId(ref);
                        if (id === undefined) {
                            throw new Error(`Cannot find identifier for input reference: ${ref}`);
                        }
                        return id;
                    }
                    return ref;
                });
            } else {
                result[k] = convertReferences(v, keyToId);
            }
        }
        return result;
    }

    return value;
}

// ─── Main migration logic ───────────────────────────────────────────────────

/**
 * Walk an old-format snapshot directory and collect all node entries.
 * @param {string} renderedDir
 * @returns {Promise<{ sublevel: string, nodeKeyJson: string, filePath: string }[]>}
 */
async function collectEntries(renderedDir) {
    const entries = [];

    async function walk(dir, sublevel) {
        let files;
        try {
            files = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return; // directory doesn't exist
        }

        for (const file of files) {
            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
                // Could be deeper nesting (e.g. r/values/event/ for parameterized nodes)
                await walk(fullPath, sublevel);
            } else {
                // Build relative path from renderedDir
                const relPath = path.relative(renderedDir, fullPath);
                const parsed = parseOldPath(relPath);
                if (parsed !== null) {
                    entries.push({
                        sublevel: parsed.sublevel,
                        nodeKeyJson: parsed.nodeKeyJson,
                        filePath: fullPath,
                    });
                }
            }
        }
    }

    // Walk each data sublevel directory
    for (const sublevel of DATA_SUBLEVELS) {
        const sublevelDir = path.join(renderedDir, "r", sublevel);
        await walk(sublevelDir, sublevel);
    }

    // Sort by canonical node-key ordering (head, arity, compareConstValue)
    // so identifier assignment is deterministic regardless of filesystem order.
    entries.sort((a, b) => compareOldNodeKeyJson(a.nodeKeyJson, b.nodeKeyJson));
    return entries;
}

/**
 * Read the value from an old-format file.
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
async function readValue(filePath) {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
}

/**
 * Write a value to the new format location.
 * @param {string} renderedDir
 * @param {string} sublevel
 * @param {string} identifier
 * @param {unknown} value
 */
async function writeValue(renderedDir, sublevel, identifier, value) {
    const filePath = path.join(renderedDir, "r", sublevel, identifier);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

/**
 * Delete an old-format file.
 * @param {string} renderedDir
 * @param {string} sublevel
 * @param {string} oldRelPath
 */
async function deleteOldEntry(renderedDir, sublevel, oldRelPath) {
    const fullPath = path.join(renderedDir, oldRelPath);
    try {
        await fs.unlink(fullPath);
    } catch {
        // ignore if already gone
    }
    // Clean up empty parent directories
    let dir = path.dirname(fullPath);
    while (dir.startsWith(renderedDir)) {
        try {
            const remaining = await fs.readdir(dir);
            if (remaining.length === 0) {
                await fs.rmdir(dir);
                dir = path.dirname(dir);
            } else {
                break;
            }
        } catch {
            break;
        }
    }
}

/**
 * Migrate an old-format snapshot directory to the new identifier-based format.
 * Modifies the directory IN PLACE.
 *
 * @param {string} snapshotDir - The root of the snapshot (containing rendered/).
 */
async function migrateSnapshot(snapshotDir) {
    const renderedDir = path.join(snapshotDir, "rendered");
    const identifiersMapPath = path.join(renderedDir, "r", "global", "identifiers_keys_map");

    try {
        await fs.stat(identifiersMapPath);
        console.log("Snapshot already migrated, nothing to do.");
        return;
    } catch {
        // Continue with the old-format scan.
    }

    // ── Step 1: Collect all old-format entries ──
    const entries = await collectEntries(renderedDir);

    if (entries.length === 0) {
        console.log("No old-format entries found, nothing to migrate.");
        // Still ensure identifiers_keys_map exists
        await ensureIdentifiersKeysMap(renderedDir, []);
        // Normalize version even for empty snapshots
        await fs.writeFile(path.join(renderedDir, "r", "global", "version"), JSON.stringify(MIGRATED_VERSION));
        return;
    }

    // ── Step 2: Assign deterministic identifiers ──
    // Preserve insertion order so subsequent runs are stable.
    const seenKeys = new Set();
    const orderedKeys = [];

    for (const entry of entries) {
        if (!seenKeys.has(entry.nodeKeyJson)) {
            seenKeys.add(entry.nodeKeyJson);
            orderedKeys.push(entry.nodeKeyJson);
        }
    }

    // Assign identifiers in canonical order using seeded basicString.
    // The capabilities seed counter provides a deterministic sequence (0, 1, 2, ...).
    let seedCounter = 0;
    /** @type {{ seed: { generate: () => number } }} */
    const capabilities = {
        seed: {
            generate: () => seedCounter++,
        },
    };

    const keyToId = new Map();
    const idToKey = new Map();

    for (const keyJson of orderedKeys) {
        // Retry on the vanishingly unlikely event that basicString produces
        // the same identifier for two different seeds. Each retry consumes
        // one more seed value, guaranteeing a distinct result.
        let id;
        do {
            id = basicString(capabilities, 9);
        } while (idToKey.has(id));
        keyToId.set(keyJson, id);
        idToKey.set(id, keyJson);
    }

    console.log(`  Found ${orderedKeys.length} unique nodes, assigned identifiers.`);

    // ── Step 3: Read old values, build new data, write to new paths ──
    // Group entries by sublevel and nodeKeyJson — we only write one file per
    // (sublevel, identifier) pair.

    /** @type {Map<string, Map<string, string>>} */
    const sublevelFilePaths = new Map(); // sublevel → nodeKeyJson → old file path

    for (const entry of entries) {
        if (!sublevelFilePaths.has(entry.sublevel)) {
            sublevelFilePaths.set(entry.sublevel, new Map());
        }
        sublevelFilePaths.get(entry.sublevel).set(entry.nodeKeyJson, entry.filePath);
    }

    for (const [sublevel, keysToFiles] of sublevelFilePaths) {
        for (const [nodeKeyJson, filePath] of keysToFiles) {
            const identifier = keyToId.get(nodeKeyJson);
            if (identifier === undefined) continue; // shouldn't happen

            const value = await readValue(filePath);

            let convertedValue = value;
            if (sublevel === "inputs" || sublevel === "revdeps") {
                convertedValue = convertReferences(value, (ref) => {
                    const id = keyToId.get(ref);
                    if (id === undefined) {
                        throw new Error(
                            `Reference ${ref} in ${sublevel}/${nodeKeyJson} has no assigned identifier`
                        );
                    }
                    return id;
                });
            }

            await writeValue(renderedDir, sublevel, identifier, convertedValue);
        }
    }

    // ── Step 4: Remove old-format files ──
    for (const entry of entries) {
        const relPath = path.relative(snapshotDir, entry.filePath);
        await deleteOldEntry(snapshotDir, entry.sublevel, relPath);
    }

    // Clean up empty sublevel directories
    for (const sublevel of DATA_SUBLEVELS) {
        const sublevelDir = path.join(renderedDir, "r", sublevel);
        try {
            const remaining = await fs.readdir(sublevelDir);
            if (remaining.length === 0) {
                await fs.rmdir(sublevelDir);
            } else {
                // Also recursively clean up empty subdirs (leftover from parameterized nodes)
                await cleanEmptyDirs(sublevelDir);
            }
        } catch {
            // directory might not exist
        }
    }

    // ── Step 5: Write identifiers_keys_map ──
    const idEntries = orderedKeys
        .map((keyJson) => [keyToId.get(keyJson), keyJson])
        .sort(([leftIdentifier], [rightIdentifier]) => String(leftIdentifier).localeCompare(String(rightIdentifier)));
    await ensureIdentifiersKeysMap(renderedDir, idEntries);

    // ── Step 6: Normalize the snapshot version to the current format ──
    await fs.writeFile(path.join(renderedDir, "r", "global", "version"), JSON.stringify(MIGRATED_VERSION));

    console.log("  Migration complete.");
}

/**
 * Recursively remove empty directories.
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

/**
 * Ensure the identifiers_keys_map file exists in rendered/r/global/.
 * @param {string} renderedDir
 * @param {Array<[string, string]>} entries - Array of [identifier, nodeKeyJson] pairs
 */
async function ensureIdentifiersKeysMap(renderedDir, entries) {
    const mapPath = path.join(renderedDir, "r", "global", "identifiers_keys_map");
    await fs.mkdir(path.dirname(mapPath), { recursive: true });
    await fs.writeFile(mapPath, JSON.stringify(entries, null, 2));
}

// ─── CLI entry point ────────────────────────────────────────────────────────

async function main() {
    const snapshotDir = process.argv[2];
    if (!snapshotDir) {
        console.error("Usage: node scripts/migrate-snapshot-to-identifiers.js <snapshot-dir>");
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

module.exports = { migrateSnapshot, decodeArg };
