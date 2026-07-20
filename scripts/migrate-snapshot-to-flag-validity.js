#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { createDefaultGraphDefinition } = require("../backend/src/generators/interface/default_graph");
const { compileNodeDef } = require("../backend/src/generators/incremental_graph/compiled_node");
const {
    buildGraphSchemeFromNodeDefs,
    buildGraphSchemeStringFromNodeDefs,
    deriveInputEdges,
    makeIdentifierLookup,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    parseGraphScheme,
    compareNodeIdentifier,
} = require("../backend/src/generators/incremental_graph/database");

class SnapshotMigrationError extends Error {
    constructor(message) {
        super(message);
        this.name = "SnapshotMigrationError";
    }
}

function readJson(filePath) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new SnapshotMigrationError(`Missing required file: ${filePath}`);
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        throw new SnapshotMigrationError(`Malformed JSON in ${filePath}: ${error.message}`);
    }
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function requireDirectory(directoryPath) {
    if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
        throw new SnapshotMigrationError(`Missing required directory: ${directoryPath}`);
    }
}


function currentGraphScheme() {
    const nodeDefs = createDefaultGraphDefinition({});
    const compiledNodes = nodeDefs.map(compileNodeDef);
    return {
        graphScheme: buildGraphSchemeFromNodeDefs(compiledNodes),
        graphSchemeString: buildGraphSchemeStringFromNodeDefs(compiledNodes),
    };
}

function requireNumber(value, description) {
    if (!Number.isInteger(value)) {
        throw new SnapshotMigrationError(`Malformed ${description}: expected integer`);
    }
    return value;
}

function loadIdentifierLookup(globalDirectory) {
    validateGlobalMetadata(globalDirectory);
    const raw = readJson(path.join(globalDirectory, "identifiers_keys_map"));
    if (!Array.isArray(raw)) {
        throw new SnapshotMigrationError("Malformed identifiers_keys_map: expected an array");
    }
    return makeIdentifierLookup(raw);
}

function validateGlobalMetadata(globalDirectory) {
    const fingerprint = readJson(path.join(globalDirectory, "fingerprint"));
    if (typeof fingerprint !== "string" || fingerprint.length === 0) {
        throw new SnapshotMigrationError("Malformed fingerprint: expected non-empty string");
    }
    const lastNodeIndex = readJson(path.join(globalDirectory, "last_node_index"));
    requireNumber(lastNodeIndex, "last_node_index");
    if (lastNodeIndex < 0) {
        throw new SnapshotMigrationError("Malformed last_node_index: expected non-negative integer");
    }
    const version = readJson(path.join(globalDirectory, "version"));
    if (typeof version !== "string" || version.length === 0) {
        throw new SnapshotMigrationError("Malformed version: expected non-empty string");
    }
}

function readLevel(directoryPath) {
    requireDirectory(directoryPath);
    const records = new Map();
    for (const name of fs.readdirSync(directoryPath).sort()) {
        records.set(name, readJson(path.join(directoryPath, name)));
    }
    return records;
}


function migrateSnapshot(snapshotDirectory) {
    const rendered = path.join(snapshotDirectory, "rendered");
    const replica = path.join(rendered, "r");
    requireDirectory(rendered);
    requireDirectory(replica);

    const valuesDirectory = path.join(replica, "values");
    const freshnessDirectory = path.join(replica, "freshness");
    const revdepsDirectory = path.join(replica, "revdeps");
    const countersDirectory = path.join(replica, "counters");
    const validDirectory = path.join(replica, "valid");
    const globalDirectory = path.join(replica, "global");

    requireDirectory(valuesDirectory);
    requireDirectory(freshnessDirectory);
    requireDirectory(revdepsDirectory);
    requireDirectory(countersDirectory);
    requireDirectory(globalDirectory);
    if (fs.existsSync(validDirectory) || fs.existsSync(path.join(globalDirectory, "graph_scheme"))) {
        throw new SnapshotMigrationError("Mixed source/target snapshot state: target validity records already exist");
    }

    const lookup = loadIdentifierLookup(globalDirectory);
    const values = readLevel(valuesDirectory);
    const freshness = readLevel(freshnessDirectory);
    const counters = readLevel(countersDirectory);
    const timestampsDirectory = path.join(replica, "timestamps");
    const { graphScheme, graphSchemeString } = currentGraphScheme();
    parseGraphScheme(graphSchemeString);

    const materializedIds = new Set(lookup.idToKey.keys());
    const cachedIds = new Set(values.keys());
    for (const idString of cachedIds) {
        if (!materializedIds.has(idString)) {
            throw new SnapshotMigrationError(`Cached value id has no identifier lookup entry: ${idString}`);
        }
    }
    const nextFreshness = new Map();
    const valid = new Map();

    for (const idString of [...materializedIds].sort((a, b) => compareNodeIdentifier(nodeIdentifierFromString(a), nodeIdentifierFromString(b)))) {
        const id = nodeIdentifierFromString(idString);
        const derivedInputs = deriveInputEdges(graphScheme, lookup, id);
        if (!cachedIds.has(idString)) {
            throw new SnapshotMigrationError(`Identifier has no cached value: ${idString}`);
        }
        const oldFreshness = freshness.get(idString);
        if (oldFreshness === undefined) {
            throw new SnapshotMigrationError(`Materialized node is missing freshness: ${idString}`);
        }
        if (oldFreshness !== "up-to-date" && oldFreshness !== "potentially-outdated") {
            throw new SnapshotMigrationError(`Malformed freshness for ${idString}: expected up-to-date or potentially-outdated`);
        }
        nextFreshness.set(idString, "potentially-outdated");
        for (const dependency of derivedInputs) {
            const dependencyString = nodeIdentifierToString(dependency);
            if (!materializedIds.has(dependencyString)) {
                throw new SnapshotMigrationError(`Dependency id missing from identifiers_keys_map: ${dependencyString}`);
            }
            if (!counters.has(dependencyString)) {
                throw new SnapshotMigrationError(`Dependency id missing from counters: ${dependencyString}`);
            }
            requireNumber(counters.get(dependencyString), `counters.${dependencyString}`);
        }
    }

    for (const idString of freshness.keys()) {
        if (!materializedIds.has(idString)) throw new SnapshotMigrationError(`Freshness id has no identifier lookup entry: ${idString}`);
        if (!cachedIds.has(idString)) throw new SnapshotMigrationError(`Freshness id has no cached value: ${idString}`);
    }

    const validObject = [...valid.entries()]
        .sort(([a], [b]) => compareNodeIdentifier(nodeIdentifierFromString(a), nodeIdentifierFromString(b)))
        .map(([dependency, dependents]) => [dependency, [...dependents].sort((a, b) => compareNodeIdentifier(nodeIdentifierFromString(a), nodeIdentifierFromString(b)))]);

    validateResult(graphScheme, lookup, materializedIds, nextFreshness, validObject);

    writeJson(path.join(globalDirectory, "identifiers_keys_map"), [...lookup.idToKey.entries()]
        .map(([id, key]) => [nodeIdentifierFromString(id), key]));
    for (const [id, state] of nextFreshness.entries()) writeJson(path.join(freshnessDirectory, id), state);
    for (const id of materializedIds) {
        const nowIso = "1970-01-01T00:00:00.000Z";
        writeJson(path.join(timestampsDirectory, id), { createdAt: nowIso, modifiedAt: nowIso });
    }
    fs.mkdirSync(validDirectory, { recursive: true });
    for (const [dependency, dependents] of validObject) writeJson(path.join(validDirectory, dependency), dependents);
    writeJson(path.join(globalDirectory, "graph_scheme"), graphSchemeString);
    fs.rmSync(path.join(replica, "inputs"), { recursive: true, force: true });
    fs.rmSync(revdepsDirectory, { recursive: true, force: true });
    fs.rmSync(countersDirectory, { recursive: true, force: true });

    validateWrittenSnapshot(replica, graphScheme, makeIdentifierLookup(readJson(path.join(globalDirectory, "identifiers_keys_map"))));
}

function validateResult(graphScheme, lookup, materializedIds, freshness, validObject) {
    for (const idString of materializedIds) {
        const id = nodeIdentifierFromString(idString);
        deriveInputEdges(graphScheme, lookup, id);
        if (!freshness.has(idString)) throw new SnapshotMigrationError(`Materialized node is missing freshness: ${idString}`);
    }
    for (const [dependency, dependents] of validObject) {
        if (!materializedIds.has(dependency)) throw new SnapshotMigrationError(`Valid key is not materialized: ${dependency}`);
        for (const dependent of dependents) {
            if (!materializedIds.has(dependent)) throw new SnapshotMigrationError(`Valid dependent is not materialized: ${dependent}`);
            const edges = deriveInputEdges(graphScheme, lookup, nodeIdentifierFromString(dependent)).map(nodeIdentifierToString);
            if (!edges.includes(dependency)) throw new SnapshotMigrationError(`Invalid validity flag ${dependency} -> ${dependent}`);
        }
    }
    for (const [idString, state] of freshness.entries()) {
        if (!materializedIds.has(idString)) throw new SnapshotMigrationError(`Freshness id has no identifier lookup entry: ${idString}`);
        if (state === "up-to-date") {
            const edges = deriveInputEdges(graphScheme, lookup, nodeIdentifierFromString(idString)).map(nodeIdentifierToString);
            for (const dependency of edges) {
                const record = validObject.find(([key]) => key === dependency);
                if (record === undefined || !record[1].includes(idString)) {
                    throw new SnapshotMigrationError(`Up-to-date node ${idString} is missing validity flag from ${dependency}`);
                }
            }
        }
    }
}

function validateWrittenSnapshot(replica, graphScheme, lookup) {
    parseGraphScheme(readJson(path.join(replica, "global", "graph_scheme")));
    for (const removed of ["inputs", "revdeps", "counters"]) {
        if (fs.existsSync(path.join(replica, removed))) throw new SnapshotMigrationError(`Removed source directory still exists: ${removed}`);
    }
    const materializedIds = new Set(lookup.idToKey.keys());
    const freshness = readLevel(path.join(replica, "freshness"));
    const valid = readLevel(path.join(replica, "valid"));
    const validObject = [...valid.entries()];
    validateResult(graphScheme, lookup, materializedIds, freshness, validObject);
}

function main() {
    const args = process.argv.slice(2);
    if (args.length !== 1) {
        console.error("Usage: node scripts/migrate-snapshot-to-flag-validity.js <snapshot-dir>");
        process.exit(1);
    }
    try {
        migrateSnapshot(args[0]);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = { migrateSnapshot, SnapshotMigrationError };
