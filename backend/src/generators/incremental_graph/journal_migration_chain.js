/**
 * The canonical Journal migration chain of
 * `incremental-graph-journal-migrations.md` §9b.
 *
 * Per-edge codec determinism is not enough when a replica can reach the same
 * target version through different version paths: immutable retained records
 * keep their `JournalRecordId`, so every supported upgrade from one Journal
 * version to another has exactly one canonical transition sequence. For every
 * supported non-current Journal version `v`, the release lineage defines at
 * most one `canonicalNextJournalVersion(v)`, and a supported migration from a
 * stored version `v0` to the running version `vn` follows exactly
 * `v0 -> v1 -> ... -> vn` where `vi+1 = canonicalNextJournalVersion(vi)`.
 *
 * A machine may skip application releases, but it does not skip canonical
 * Journal migration transitions: each chain step is a complete Journal-aware
 * migration (whole-history codec rewrite, semantic repair, replay validation,
 * and a version cut to that intermediate version), and migration-authored
 * records from an intermediate step are retained and are themselves rewritten
 * by later canonical steps.
 *
 * If the complete chain from a stored version to the running version is not
 * available, that source version is unsupported and startup fails
 * `JournalVersionCompatibilityError`.
 */

const { makeJournalVersionCompatibilityError } = require("./journal");

/** @typedef {import('./migration_codec').JournalFormatCodec} JournalFormatCodec */
/** @typedef {import('./migration_storage').MigrationStorage} MigrationStorage */
/** @typedef {import('./database/types').Version} Version */
/** @typedef {ReturnType<typeof makeJournalVersionCompatibilityError>} JournalVersionCompatibilityRejection */

/**
 * One canonical edge of the release lineage: the single supported transition
 * out of `sourceVersion`, together with the migration definition which
 * reproduces what earlier replicas executed for that edge.
 *
 * The source/target version pair identifies a frozen canonical migration
 * definition: its format codec, target semantic migration behavior, and any
 * deterministic repair rules needed to reproduce that transition may not be
 * silently changed by a later release while the source version remains
 * supported.
 *
 * @typedef {object} CanonicalMigrationEdge
 * @property {Version} sourceVersion - The supported non-current Journal version this edge leaves.
 * @property {Version} targetVersion - The canonical successor Journal version this edge cuts to.
 * @property {JournalFormatCodec} codec - The edge's directed source->target format codec.
 * @property {(storage: MigrationStorage) => Promise<void>} callback - The edge's semantic migration callback.
 */

/**
 * The canonical chain registry: at most one successor edge per supported
 * non-current source version.
 *
 * @typedef {Map<Version, CanonicalMigrationEdge>} CanonicalMigrationChain
 */

/**
 * The properties that a `CanonicalMigrationChain` value carries are:
 * - every supported non-current Journal version has at most one canonical
 *   successor edge, so the lineage is a function `canonicalNextJournalVersion`;
 * - no edge leaves the current version (the current version has no successor);
 * - no edge is a self-loop and the lineage has no cycle, so chain resolution
 *   from any stored version terminates.
 *
 * The proof of those properties is guaranteed by:
 * - This registry can only be introduced through `makeCanonicalMigrationChain`,
 *   which rejects a duplicate source version, a self-loop, and a cycle.
 *
 * @param {CanonicalMigrationEdge[]} edges - The canonical edges of the release lineage.
 * @returns {CanonicalMigrationChain | JournalVersionCompatibilityRejection}
 */
function makeCanonicalMigrationChain(edges) {
    /** @type {CanonicalMigrationChain} */
    const chain = new Map();
    for (const edge of edges) {
        if (chain.has(edge.sourceVersion)) {
            return makeJournalVersionCompatibilityError(
                `the canonical migration chain declares more than one successor for Journal version ${String(edge.sourceVersion)}`,
                "at most one canonical successor per supported source version",
                "multiple canonical successors"
            );
        }
        if (edge.sourceVersion === edge.targetVersion) {
            return makeJournalVersionCompatibilityError(
                `the canonical migration chain declares a self-loop at Journal version ${String(edge.sourceVersion)}`,
                "no self-loop",
                "a self-loop"
            );
        }
        chain.set(edge.sourceVersion, edge);
    }
    if (hasCycle(chain)) {
        return makeJournalVersionCompatibilityError(
            "the canonical migration chain declares a cycle",
            "an acyclic lineage",
            "a cycle"
        );
    }
    return chain;
}

/**
 * Detect a cycle in the lineage by walking each source version's successor
 * edges. The lineage is finite and each source has at most one successor, so
 * the walk terminates.
 *
 * @param {CanonicalMigrationChain} chain
 * @returns {boolean}
 */
function hasCycle(chain) {
    const visited = new Set();
    for (const source of chain.keys()) {
        if (visited.has(source)) {
            continue;
        }
        const path = new Set();
        let cursor = source;
        while (chain.has(cursor)) {
            if (path.has(cursor)) {
                return true;
            }
            path.add(cursor);
            visited.add(cursor);
            const edge = chain.get(cursor);
            if (edge === undefined) {
                return false;
            }
            cursor = edge.targetVersion;
        }
    }
    return false;
}

/**
 * The canonical successor of a supported non-current Journal version, or
 * `undefined` when the version has no canonical successor (it is the current
 * version, or it is not a supported source version).
 *
 * @param {CanonicalMigrationChain} chain
 * @param {Version} sourceVersion
 * @returns {Version | undefined}
 */
function canonicalNextJournalVersion(chain, sourceVersion) {
    const edge = chain.get(sourceVersion);
    return edge === undefined ? undefined : edge.targetVersion;
}

/**
 * The outcome of resolving the canonical chain from a stored version to the
 * running version.
 *
 * @typedef {object} ResolvedCanonicalMigrationChain
 * @property {CanonicalMigrationEdge[]} edges - The canonical edges to execute, in order.
 */

/**
 * Resolve the canonical migration chain from a stored Journal version to the
 * running version, following `canonicalNextJournalVersion` until the running
 * version is reached.
 *
 * A stored version equal to the running version needs no migration and resolves
 * to an empty chain. A stored version with no complete canonical chain to the
 * running version is unsupported and resolves to a
 * `JournalVersionCompatibilityError`.
 *
 * @param {CanonicalMigrationChain} chain
 * @param {Version} storedVersion - The Journal version stored in the active replica.
 * @param {Version} currentVersion - The running Journal version.
 * @returns {ResolvedCanonicalMigrationChain | JournalVersionCompatibilityRejection}
 */
function resolveCanonicalMigrationChain(chain, storedVersion, currentVersion) {
    if (storedVersion === currentVersion) {
        return { edges: [] };
    }
    /** @type {CanonicalMigrationEdge[]} */
    const edges = [];
    /** @type {Set<Version>} */
    const visited = new Set();
    let cursor = storedVersion;
    while (cursor !== currentVersion) {
        if (visited.has(cursor)) {
            return makeJournalVersionCompatibilityError(
                `the canonical migration chain from stored Journal version ${String(storedVersion)} to running version ${String(currentVersion)} revisits version ${String(cursor)}`,
                "an acyclic canonical chain to the running version",
                "a cyclic canonical chain"
            );
        }
        visited.add(cursor);
        const edge = chain.get(cursor);
        if (edge === undefined) {
            return makeJournalVersionCompatibilityError(
                `stored Journal version ${String(storedVersion)} has no complete canonical migration chain to running version ${String(currentVersion)}`,
                "a complete canonical migration chain to the running version",
                `no canonical successor for version ${String(cursor)}`
            );
        }
        edges.push(edge);
        cursor = edge.targetVersion;
    }
    return { edges };
}

module.exports = {
    makeCanonicalMigrationChain,
    canonicalNextJournalVersion,
    resolveCanonicalMigrationChain,
};
