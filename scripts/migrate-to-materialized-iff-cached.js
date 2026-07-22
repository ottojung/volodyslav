#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

class PruneError extends Error {
    constructor(message) {
        super(message);
        this.name = "PruneError";
    }
}

function readJson(filePath) {
    let text;
    try {
        text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
        throw new PruneError(`Cannot read ${filePath}: ${error.message}`);
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        throw new PruneError(`Malformed JSON in ${filePath}: ${error.message}`);
    }
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function requireDirectory(directoryPath) {
    if (
        !fs.existsSync(directoryPath)
        || !fs.statSync(directoryPath).isDirectory()
    ) {
        throw new PruneError(`Missing required directory: ${directoryPath}`);
    }
}

function resolveReplicaDirectory(inputPath) {
    const absolute = path.resolve(inputPath);
    const candidates = [
        path.join(absolute, "rendered", "r"),
        path.join(absolute, "r"),
        absolute,
    ];

    for (const candidate of candidates) {
        if (
            fs.existsSync(path.join(candidate, "global"))
            && fs.existsSync(path.join(candidate, "values"))
        ) {
            return candidate;
        }
    }

    throw new PruneError(
        `Could not locate replica r below ${absolute}; `
        + "expected rendered/r/global and rendered/r/values"
    );
}

function decodeRenderedKey(filename, context) {
    try {
        return decodeURIComponent(filename);
    } catch (error) {
        throw new PruneError(
            `Malformed encoded key ${filename} in ${context}: ${error.message}`
        );
    }
}

function listKeyedFiles(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return new Map();
    }

    requireDirectory(directoryPath);

    const files = new Map();

    for (const entry of fs.readdirSync(directoryPath, {
        withFileTypes: true,
    })) {
        if (!entry.isFile()) {
            throw new PruneError(
                `Unexpected non-file entry: ${path.join(
                    directoryPath,
                    entry.name
                )}`
            );
        }

        const key = decodeRenderedKey(entry.name, directoryPath);

        if (files.has(key)) {
            throw new PruneError(
                `Duplicate decoded key ${key} in ${directoryPath}`
            );
        }

        files.set(key, path.join(directoryPath, entry.name));
    }

    return files;
}

function loadIdentifierMaps(globalDirectory) {
    const supportedNames = [
        "identifiers_nodes_map",
        "identifiers_keys_map",
    ];

    const maps = [];

    for (const name of supportedNames) {
        const filePath = path.join(globalDirectory, name);

        if (!fs.existsSync(filePath)) {
            continue;
        }

        const entries = readJson(filePath);

        if (!Array.isArray(entries)) {
            throw new PruneError(`${filePath} must contain an array`);
        }

        for (const [index, entry] of entries.entries()) {
            if (
                !Array.isArray(entry)
                || entry.length < 2
                || typeof entry[0] !== "string"
            ) {
                throw new PruneError(
                    `${filePath}[${index}] must be an [identifier, node] pair`
                );
            }
        }

        maps.push({
            name,
            filePath,
            entries,
        });
    }

    if (maps.length === 0) {
        throw new PruneError(
            `Neither identifiers_nodes_map nor identifiers_keys_map exists `
            + `in ${globalDirectory}`
        );
    }

    const referenceIds = maps[0].entries.map(
        ([identifier]) => identifier
    );

    for (const map of maps.slice(1)) {
        const ids = map.entries.map(([identifier]) => identifier);

        if (JSON.stringify(ids) !== JSON.stringify(referenceIds)) {
            throw new PruneError(
                `${maps[0].name} and ${map.name} contain different `
                + "identifier sequences; refusing ambiguous cleanup"
            );
        }
    }

    return maps;
}

function parseSemanticNode(raw, context) {
    let node = raw;

    if (typeof raw === "string") {
        try {
            node = JSON.parse(raw);
        } catch (error) {
            throw new PruneError(
                `Malformed semantic node in ${context}: ${error.message}`
            );
        }
    }

    if (
        node === null
        || typeof node !== "object"
        || Array.isArray(node)
        || typeof node.head !== "string"
        || !Array.isArray(node.args)
    ) {
        throw new PruneError(
            `Malformed semantic node in ${context}`
        );
    }

    return {
        head: node.head,
        args: node.args,
    };
}

function canonicalNodeKey(node) {
    return JSON.stringify({
        head: node.head,
        args: node.args,
    });
}

function parseGraphScheme(globalDirectory) {
    const filePath = path.join(globalDirectory, "graph_scheme");

    if (!fs.existsSync(filePath)) {
        return undefined;
    }

    let scheme = readJson(filePath);

    if (typeof scheme === "string") {
        try {
            scheme = JSON.parse(scheme);
        } catch (error) {
            throw new PruneError(
                `Malformed graph_scheme string in ${filePath}: `
                + error.message
            );
        }
    }

    if (
        scheme === null
        || typeof scheme !== "object"
        || scheme.format !== 1
        || !Array.isArray(scheme.nodes)
    ) {
        throw new PruneError(
            `Malformed graph_scheme in ${filePath}`
        );
    }

    return scheme;
}

function buildReverseDependenciesFromGraphScheme(
    identifierEntries,
    scheme
) {
    const idToNode = new Map();
    const keyToId = new Map();

    for (
        const [index, [identifier, rawNode]]
        of identifierEntries.entries()
    ) {
        if (idToNode.has(identifier)) {
            throw new PruneError(
                `Duplicate identifier ${identifier} in identifier map`
            );
        }

        const node = parseSemanticNode(
            rawNode,
            `identifier map entry ${index}`
        );

        const key = canonicalNodeKey(node);

        if (keyToId.has(key)) {
            throw new PruneError(
                `Duplicate semantic node ${key} in identifier map`
            );
        }

        idToNode.set(identifier, node);
        keyToId.set(key, identifier);
    }

    const schemeByHead = new Map();

    for (const node of scheme.nodes) {
        if (
            node === null
            || typeof node !== "object"
            || typeof node.head !== "string"
            || !Number.isInteger(node.arity)
            || !Array.isArray(node.inputTemplates)
        ) {
            throw new PruneError("Malformed graph_scheme node");
        }

        if (schemeByHead.has(node.head)) {
            throw new PruneError(
                `Duplicate graph_scheme head ${node.head}`
            );
        }

        schemeByHead.set(node.head, node);
    }

    const reverse = new Map();
    const structurallyBroken = new Set();

    for (const [identifier, output] of idToNode) {
        const schemeNode = schemeByHead.get(output.head);

        if (schemeNode === undefined) {
            throw new PruneError(
                `No graph_scheme entry for node head ${output.head}`
            );
        }

        if (output.args.length !== schemeNode.arity) {
            throw new PruneError(
                `Arity mismatch for ${canonicalNodeKey(output)}`
            );
        }

        for (const template of schemeNode.inputTemplates) {
            if (
                template === null
                || typeof template !== "object"
                || typeof template.head !== "string"
                || !Array.isArray(template.args)
                || !template.args.every(Number.isInteger)
            ) {
                throw new PruneError(
                    `Malformed input template for ${output.head}`
                );
            }

            const dependency = {
                head: template.head,
                args: template.args.map((position) => {
                    if (
                        position < 0
                        || position >= output.args.length
                    ) {
                        throw new PruneError(
                            `Invalid input position ${position} `
                            + `for ${output.head}`
                        );
                    }

                    return output.args[position];
                }),
            };

            const dependencyId = keyToId.get(
                canonicalNodeKey(dependency)
            );

            if (dependencyId === undefined) {
                structurallyBroken.add(identifier);
                continue;
            }

            if (!reverse.has(dependencyId)) {
                reverse.set(dependencyId, new Set());
            }

            reverse.get(dependencyId).add(identifier);
        }
    }

    return {
        reverse,
        structurallyBroken,
    };
}

function buildReverseDependenciesFromInputs(replicaDirectory) {
    const inputFiles = listKeyedFiles(
        path.join(replicaDirectory, "inputs")
    );

    const reverse = new Map();

    for (const [dependentId, filePath] of inputFiles) {
        const dependencies = readJson(filePath);

        if (
            !Array.isArray(dependencies)
            || !dependencies.every(
                (value) => typeof value === "string"
            )
        ) {
            throw new PruneError(
                `${filePath} must contain an array of identifiers`
            );
        }

        for (const dependencyId of dependencies) {
            if (!reverse.has(dependencyId)) {
                reverse.set(dependencyId, new Set());
            }

            reverse.get(dependencyId).add(dependentId);
        }
    }

    return reverse;
}

function expandDependentClosure(initial, reverseDependencies) {
    const deleted = new Set(initial);
    const queue = [...initial];

    while (queue.length > 0) {
        const identifier = queue.shift();

        for (
            const dependent
            of reverseDependencies.get(identifier) ?? []
        ) {
            if (deleted.has(dependent)) {
                continue;
            }

            deleted.add(dependent);
            queue.push(dependent);
        }
    }

    return deleted;
}

function removeDeletedReferences(filePath, deletedIds, apply) {
    const value = readJson(filePath);

    if (
        !Array.isArray(value)
        || !value.every((entry) => typeof entry === "string")
    ) {
        throw new PruneError(
            `${filePath} must contain an array of identifiers`
        );
    }

    const next = value.filter(
        (identifier) => !deletedIds.has(identifier)
    );

    if (next.length === value.length) {
        return false;
    }

    if (apply) {
        if (next.length === 0) {
            fs.unlinkSync(filePath);
        } else {
            writeJson(filePath, next);
        }
    }

    return true;
}

function assertNoSurvivingInputReferences(
    replicaDirectory,
    deletedIds
) {
    const inputFiles = listKeyedFiles(
        path.join(replicaDirectory, "inputs")
    );

    for (const [dependentId, filePath] of inputFiles) {
        if (deletedIds.has(dependentId)) {
            continue;
        }

        const dependencies = readJson(filePath);

        if (
            !Array.isArray(dependencies)
            || !dependencies.every(
                (entry) => typeof entry === "string"
            )
        ) {
            throw new PruneError(
                `${filePath} must contain an array of identifiers`
            );
        }

        const deletedDependency = dependencies.find(
            (identifier) => deletedIds.has(identifier)
        );

        if (deletedDependency !== undefined) {
            throw new PruneError(
                `Internal error: surviving node ${dependentId} `
                + `still depends on deleted node ${deletedDependency}`
            );
        }
    }
}

function pruneSnapshot(inputPath, apply) {
    const replicaDirectory = resolveReplicaDirectory(inputPath);
    const globalDirectory = path.join(
        replicaDirectory,
        "global"
    );

    const identifierMaps = loadIdentifierMaps(globalDirectory);
    const identifierEntries = identifierMaps[0].entries;

    const mapIds = new Set(
        identifierEntries.map(([identifier]) => identifier)
    );

    const valueFiles = listKeyedFiles(
        path.join(replicaDirectory, "values")
    );

    for (const identifier of valueFiles.keys()) {
        if (!mapIds.has(identifier)) {
            throw new PruneError(
                `Cached value ${identifier} has no identifier-map `
                + "entry; this script will not discard cached values "
                + "implicitly"
            );
        }
    }

    const valuelessIds = new Set(
        [...mapIds].filter(
            (identifier) => !valueFiles.has(identifier)
        )
    );

    let reverseDependencies;
    const scheme = parseGraphScheme(globalDirectory);

    if (scheme !== undefined) {
        const derived =
            buildReverseDependenciesFromGraphScheme(
                identifierEntries,
                scheme
            );

        reverseDependencies = derived.reverse;

        for (const identifier of derived.structurallyBroken) {
            valuelessIds.add(identifier);
        }
    } else if (
        fs.existsSync(path.join(replicaDirectory, "inputs"))
    ) {
        reverseDependencies =
            buildReverseDependenciesFromInputs(
                replicaDirectory
            );
    } else {
        throw new PruneError(
            "Cannot establish dependency closure: neither "
            + "global/graph_scheme nor the legacy inputs "
            + "sublevel exists"
        );
    }

    const deletedIds = expandDependentClosure(
        valuelessIds,
        reverseDependencies
    );

    const sortedDeletedIds = [...deletedIds].sort();

    console.log(`Replica: ${replicaDirectory}`);
    console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
    console.log(
        "Valueless or structurally broken identifiers: "
        + valuelessIds.size
    );
    console.log(
        "Identifiers deleted after dependent closure: "
        + deletedIds.size
    );

    for (const identifier of sortedDeletedIds) {
        console.log(`  ${identifier}`);
    }

    if (deletedIds.size === 0) {
        console.log("Nothing to delete.");

        return {
            deletedIds,
            changedFiles: 0,
        };
    }

    let changedFiles = 0;

    /*
     * Delete every whole per-node record whose key is one
     * of the doomed identifiers. This covers:
     *
     * - values/$ID
     * - freshness/$ID
     * - timestamps/$ID
     * - valid/$ID
     * - inputs/$ID
     * - revdeps/$ID
     * - any other identifier-keyed sublevel
     */
    for (
        const entry
        of fs.readdirSync(replicaDirectory, {
            withFileTypes: true,
        })
    ) {
        if (
            !entry.isDirectory()
            || entry.name === "global"
        ) {
            continue;
        }

        const keyedFiles = listKeyedFiles(
            path.join(replicaDirectory, entry.name)
        );

        for (const identifier of deletedIds) {
            const filePath = keyedFiles.get(identifier);

            if (filePath === undefined) {
                continue;
            }

            console.log(
                `${apply ? "delete" : "would delete"}: `
                + filePath
            );

            if (apply) {
                fs.unlinkSync(filePath);
            }

            changedFiles += 1;
        }
    }

    /*
     * These sublevels contain arrays of identifiers.
     * Remove references to deleted identifiers from
     * records belonging to surviving nodes.
     */
    for (const sublevel of ["valid", "revdeps"]) {
        const keyedFiles = listKeyedFiles(
            path.join(replicaDirectory, sublevel)
        );

        for (const [ownerId, filePath] of keyedFiles) {
            if (deletedIds.has(ownerId)) {
                continue;
            }

            if (
                removeDeletedReferences(
                    filePath,
                    deletedIds,
                    apply
                )
            ) {
                console.log(
                    `${
                        apply
                            ? "prune references in"
                            : "would prune references in"
                    }: ${filePath}`
                );

                changedFiles += 1;
            }
        }
    }

    /*
     * We delete the dependent closure, so no surviving
     * legacy inputs record may still mention a deleted ID.
     */
    assertNoSurvivingInputReferences(
        replicaDirectory,
        deletedIds
    );

    /*
     * Finally, remove the deleted identifiers from the
     * global identifier registry.
     */
    for (const map of identifierMaps) {
        const nextEntries = map.entries.filter(
            ([identifier]) => !deletedIds.has(identifier)
        );

        if (nextEntries.length === map.entries.length) {
            continue;
        }

        console.log(
            `${apply ? "rewrite" : "would rewrite"}: `
            + map.filePath
        );

        if (apply) {
            writeJson(map.filePath, nextEntries);
        }

        changedFiles += 1;
    }

    if (apply) {
        const remainingMapIds = new Set(
            identifierMaps[0].entries
                .filter(
                    ([identifier]) =>
                        !deletedIds.has(identifier)
                )
                .map(([identifier]) => identifier)
        );

        const remainingValueIds = new Set(
            listKeyedFiles(
                path.join(replicaDirectory, "values")
            ).keys()
        );

        if (
            remainingMapIds.size
                !== remainingValueIds.size
            || [...remainingMapIds].some(
                (identifier) =>
                    !remainingValueIds.has(identifier)
            )
        ) {
            throw new PruneError(
                "Post-write verification failed: identifier "
                + "map and values are still unequal"
            );
        }
    }

    console.log(
        `${apply ? "Changed" : "Would change"} `
        + `${changedFiles} files.`
    );

    return {
        deletedIds,
        changedFiles,
    };
}

function usage() {
    console.error(
        "Usage: node "
        + "scripts/prune-valueless-materialized-identifiers.js "
        + "<generators-database-or-replica-dir> [--apply]"
    );
}

function main() {
    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const positional = args.filter(
        (arg) => arg !== "--apply"
    );

    if (positional.length !== 1) {
        usage();
        process.exit(1);
    }

    try {
        pruneSnapshot(positional[0], apply);
    } catch (error) {
        console.error(
            error instanceof Error
                ? error.message
                : String(error)
        );

        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    PruneError,
    pruneSnapshot,
};
