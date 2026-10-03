/**
 * Reading a rendered replica fixture as the pre-Journal source the startup gate reads.
 *
 * A rendered fixture is the replica exactly as a replica persists it: one JSON file per
 * sublevel key. The startup gate reads a replica through its own sublevels, so a fixture
 * can stand in for one without going through the render/scan path, and the observation
 * this module builds is the same weak shape `journal_bootstrap_source` builds from a
 * live replica.
 *
 * The cohort bootstrap source is supplied here too, because it is deployment
 * configuration rather than persisted state: a fixture representing pre-Journal state
 * has to bring its own transport, exactly as an installation does.
 */

const fs = require("fs");
const path = require("path");

const {
    deriveInputPositions,
    nodeKeyStringToString,
    parseGraphScheme,
    stringToNodeKeyString,
} = require("../src/generators/incremental_graph/database");
const {
    makeCanonicalBootstrapSnapshot,
    makeCohortBootstrapSource,
    readLegacyBootstrapState,
} = require("../src/generators/incremental_graph/journal");

/**
 * @param {string} directory - The sublevel directory.
 * @returns {Array<string>}
 */
function keysOf(directory) {
    if (!fs.existsSync(directory)) {
        return [];
    }
    return fs.readdirSync(directory).sort();
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * The graph a rendered replica fixture persists, read back in the shape the pre-Journal
 * boundary reads: every materialized node with its persisted identifier, payload,
 * timestamps, freshness and direct legacy inputs.
 *
 * Validity is persisted as the inverse relation `valid[D] = [dependents validated
 * against D]`, so a node's direct inputs are the entries which name it.
 *
 * @param {string} replicaPath - The fixture's replica directory.
 * @returns {object}
 */
function readFixtureReplica(replicaPath) {
    const globalDirectory = path.join(replicaPath, "global");
    const serializedLookup = readJson(path.join(globalDirectory, "identifiers_keys_map"));
    const keyByIdentifier = new Map(
        serializedLookup.map(([identifier, key]) => [identifier, key])
    );
    /** @type {Map<string, Array<string>>} */
    const inputs = new Map();
    for (const identifier of keysOf(path.join(replicaPath, "valid"))) {
        for (const dependent of readJson(path.join(replicaPath, "valid", identifier))) {
            const existing = inputs.get(dependent);
            if (existing === undefined) {
                inputs.set(dependent, [keyByIdentifier.get(identifier)]);
                continue;
            }
            existing.push(keyByIdentifier.get(identifier));
        }
    }
    const nodes = serializedLookup.map(([identifier, nodeKey]) => ({
        nodeKeyString: nodeKey,
        nodeIdentifier: identifier,
        payload: readJson(path.join(replicaPath, "values", identifier)),
        ...readJson(path.join(replicaPath, "timestamps", identifier)),
        upToDate:
            readJson(path.join(replicaPath, "freshness", identifier)) === "up-to-date",
        validInputs: inputs.get(identifier) ?? [],
    }));
    return {
        version: readJson(path.join(globalDirectory, "version")),
        fingerprint: readJson(path.join(globalDirectory, "fingerprint")),
        lastNodeIndex: readJson(path.join(globalDirectory, "last_node_index")),
        graphSchemeString: readJson(path.join(globalDirectory, "graph_scheme")),
        journalRecordCount: keysOf(path.join(replicaPath, "journal")).filter((name) =>
            name.startsWith("record|")
        ).length,
        legacyState: readLegacyBootstrapState({
            graphSchemeString: readJson(path.join(globalDirectory, "graph_scheme")),
            lastNodeIndex: readJson(path.join(globalDirectory, "last_node_index")),
            nodes,
        }),
    };
}

/**
 * The current graph schema's direct inputs per node, derived from the same persisted
 * graph scheme the fixture replica ran under. A fixture's scheme is the schema its own
 * nodes were materialized against, so the two agree by construction.
 *
 * @param {string} graphSchemeString
 * @returns {(nodeKeyString: string) => ReadonlyArray<string> | undefined}
 */
function fixtureInputKeys(graphSchemeString) {
    const scheme = parseGraphScheme(graphSchemeString);
    return (nodeKeyString) => {
        const key = stringToNodeKeyString(nodeKeyString);
        if (key instanceof Error) {
            return undefined;
        }
        try {
            return deriveInputPositions(scheme, key).map((input) => nodeKeyStringToString(input));
        } catch (error) {
            if (error instanceof Error) {
                return undefined;
            }
            throw error;
        }
    };
}

/**
 * A cohort which holds nothing and publishes whatever it is handed, which is the
 * transport an installation running alone in its cohort answers with.
 *
 * @param {object} calls - Counters and the published candidates, for assertions.
 * @returns {object}
 */
function fixtureAbsentCohortSource(calls) {
    const configured = makeCohortBootstrapSource({
        async queryCanonicalBootstrap() {
            calls.queries += 1;
            return null;
        },
        async publishCanonicalBootstrapIfAbsent(candidate) {
            calls.publications += 1;
            calls.published.push(candidate);
            return {
                published: true,
                artifact: makeCanonicalBootstrapSnapshot({
                    records: candidate.records,
                    creatorWriter: candidate.creatorWriter,
                    bootstrapFrontier: candidate.bootstrapFrontier,
                    databaseVersion: candidate.targetVersion,
                    graphSchemeString: candidate.graphSchemeString,
                }),
            };
        },
    });
    if (configured instanceof Error) {
        throw configured;
    }
    return configured;
}

/**
 * A cohort whose every answer is a value the transport contract does not define.
 *
 * @param {unknown} answer
 * @returns {object}
 */
function fixtureIndeterminateCohortSource(answer) {
    const configured = makeCohortBootstrapSource({
        async queryCanonicalBootstrap() {
            return answer;
        },
        async publishCanonicalBootstrapIfAbsent() {
            return answer;
        },
    });
    if (configured instanceof Error) {
        throw configured;
    }
    return configured;
}

module.exports = {
    fixtureAbsentCohortSource,
    fixtureIndeterminateCohortSource,
    fixtureInputKeys,
    readFixtureReplica,
};
