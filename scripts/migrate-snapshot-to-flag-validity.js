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

function optionalDirectoryEntries(directoryPath) {
    if (!fs.existsSync(directoryPath)) return [];
    requireDirectory(directoryPath);
    return fs.readdirSync(directoryPath).sort();
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

function requireArray(value, description) {
    if (!Array.isArray(value)) {
        throw new SnapshotMigrationError(`Malformed ${description}: expected array`);
    }
    return value;
}

function parseInputRecord(raw, id) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new SnapshotMigrationError(`Malformed inputs record for ${id}: expected object`);
    }
    const inputs = requireArray(raw.inputs, `inputs.${id}.inputs`);
    const inputCounters = requireArray(raw.inputCounters, `inputs.${id}.inputCounters`);
    for (let index = 0; index < inputCounters.length; index++) {
        requireNumber(inputCounters[index], `inputs.${id}.inputCounters[${index}]`);
    }
    if (inputs.length !== inputCounters.length) {
        throw new SnapshotMigrationError(`Malformed inputCounters for ${id}: length mismatch`);
    }
    return { inputs, inputCounters };
}

function assertSameInputs(id, oldInputs, derivedInputs) {
    const oldStrings = oldInputs.map(String);
    const derivedStrings = derivedInputs.map(nodeIdentifierToString);
    if (oldStrings.length !== derivedStrings.length) {
        throw new SnapshotMigrationError(`Input mismatch for ${id}: length differs`);
    }
    for (let index = 0; index < oldStrings.length; index++) {
        if (oldStrings[index] !== derivedStrings[index]) {
            throw new SnapshotMigrationError(`Input mismatch for ${id} at index ${index}`);
        }
    }
}

function addValid(validMap, dependency, dependent) {
    const dependencyString = nodeIdentifierToString(dependency);
    const dependentString = nodeIdentifierToString(dependent);
    if (!validMap.has(dependencyString)) validMap.set(dependencyString, new Set());
    validMap.get(dependencyString).add(dependentString);
}

function migrateSnapshot(snapshotDirectory) {
    const rendered = path.join(snapshotDirectory, "rendered");
    const replica = path.join(rendered, "r");
    requireDirectory(rendered);
    requireDirectory(replica);

    const valuesDirectory = path.join(replica, "values");
    const freshnessDirectory = path.join(replica, "freshness");
    const inputsDirectory = path.join(replica, "inputs");
    const revdepsDirectory = path.join(replica, "revdeps");
    const countersDirectory = path.join(replica, "counters");
    const validDirectory = path.join(replica, "valid");
    const globalDirectory = path.join(replica, "global");

    requireDirectory(valuesDirectory);
    requireDirectory(freshnessDirectory);
    requireDirectory(inputsDirectory);
    requireDirectory(revdepsDirectory);
    requireDirectory(countersDirectory);
    requireDirectory(globalDirectory);
    if (fs.existsSync(validDirectory) || fs.existsSync(path.join(globalDirectory, "graph_scheme"))) {
        throw new SnapshotMigrationError("Mixed source/target snapshot state: target validity records already exist");
    }

    const lookup = loadIdentifierLookup(globalDirectory);
    const values = readLevel(valuesDirectory);
    const freshness = readLevel(freshnessDirectory);
    const inputs = readLevel(inputsDirectory);
    const counters = readLevel(countersDirectory);
    const { graphScheme, graphSchemeString } = currentGraphScheme();
    parseGraphScheme(graphSchemeString);

    const materializedIds = new Set(values.keys());
    const nextFreshness = new Map();
    const valid = new Map();

    for (const idString of [...materializedIds].sort((a, b) => compareNodeIdentifier(nodeIdentifierFromString(a), nodeIdentifierFromString(b)))) {
        const id = nodeIdentifierFromString(idString);
        if (!lookup.idToKey.has(idString)) {
            throw new SnapshotMigrationError(`Materialized value id missing from identifiers_keys_map: ${idString}`);
        }
        const derivedInputs = deriveInputEdges(graphScheme, lookup, id);
        if (!freshness.has(idString)) {
            throw new SnapshotMigrationError(`Missing freshness record for materialized node: ${idString}`);
        }
        const oldFreshness = freshness.get(idString);
        if (oldFreshness !== "up-to-date" && oldFreshness !== "potentially-outdated") {
            throw new SnapshotMigrationError(`Malformed freshness for ${idString}: expected up-to-date or potentially-outdated`);
        }
        const isUpToDate = oldFreshness === "up-to-date";
        nextFreshness.set(idString, oldFreshness);
        if (derivedInputs.length === 0) continue;

        if (!inputs.has(idString)) {
            throw new SnapshotMigrationError(`Missing inputs record for non-zero-input node: ${idString}`);
        }
        const inputRecord = parseInputRecord(inputs.get(idString), idString);
        assertSameInputs(idString, inputRecord.inputs, derivedInputs);
        for (let index = 0; index < derivedInputs.length; index++) {
            const dependency = derivedInputs[index];
            const dependencyString = nodeIdentifierToString(dependency);
            if (!materializedIds.has(dependencyString)) {
                throw new SnapshotMigrationError(`Dependency id missing from values: ${dependencyString}`);
            }
            if (!counters.has(dependencyString)) {
                throw new SnapshotMigrationError(`Dependency id missing from counters: ${dependencyString}`);
            }
            const dependencyCounter = requireNumber(counters.get(dependencyString), `counters.${dependencyString}`);
            if (isUpToDate || inputRecord.inputCounters[index] === dependencyCounter) {
                addValid(valid, dependency, id);
            }
        }
    }

    for (const idString of freshness.keys()) {
        if (!materializedIds.has(idString)) throw new SnapshotMigrationError(`Freshness id is not materialized: ${idString}`);
    }

    const validObject = [...valid.entries()]
        .sort(([a], [b]) => compareNodeIdentifier(nodeIdentifierFromString(a), nodeIdentifierFromString(b)))
        .map(([dependency, dependents]) => [dependency, [...dependents].sort((a, b) => compareNodeIdentifier(nodeIdentifierFromString(a), nodeIdentifierFromString(b)))]);

    validateResult(graphScheme, lookup, materializedIds, nextFreshness, validObject);

    for (const [id, state] of nextFreshness.entries()) writeJson(path.join(freshnessDirectory, id), state);
    fs.mkdirSync(validDirectory, { recursive: true });
    for (const [dependency, dependents] of validObject) writeJson(path.join(validDirectory, dependency), dependents);
    writeJson(path.join(globalDirectory, "graph_scheme"), graphSchemeString);
    fs.rmSync(inputsDirectory, { recursive: true, force: true });
    fs.rmSync(revdepsDirectory, { recursive: true, force: true });
    fs.rmSync(countersDirectory, { recursive: true, force: true });

    validateWrittenSnapshot(replica, graphScheme, lookup);
}

function validateResult(graphScheme, lookup, materializedIds, freshness, validObject) {
    for (const idString of materializedIds) {
        const id = nodeIdentifierFromString(idString);
        deriveInputEdges(graphScheme, lookup, id);
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
        if (!materializedIds.has(idString)) throw new SnapshotMigrationError(`Freshness id is not materialized: ${idString}`);
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
    const materializedIds = new Set(optionalDirectoryEntries(path.join(replica, "values")));
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
