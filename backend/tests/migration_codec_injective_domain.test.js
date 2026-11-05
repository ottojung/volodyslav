"use strict";

/**
 * `incremental-graph-journal-testing.md` §Canonical per-record rewrite regressions,
 * "distributed disjoint-history" (lines 845-854), and
 * `incremental-graph-journal-migrations.md` §9a (lines 519-528).
 *
 * `rewriteNodeKey` is injective over the complete supported source NodeKey semantic
 * domain, independent of which keys one replica happens to retain. No replica can
 * enumerate that domain: a concrete migration only rejects a collision its own
 * retained history witnesses (`journal_rewrite.js`). This file pins the
 * domain-level obligation that the per-replica retained-set scan cannot discharge:
 * when the source domain is finite/enumerable in a test model, the injectivity law
 * is checked exhaustively over the declared domain, and a codec that is injective
 * on every disjoint retained subset is still rejected before either migration is
 * considered valid.
 */

const { makeJournalFormatCodec } = require("../src/generators/incremental_graph/migration_codec");
const { makeHistoryRewriter } = require("../src/generators/incremental_graph/journal_rewrite");
const {
    isJournalVersionCompatibilityError,
    makeJournalVersionCompatibilityError,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

/** NodeKey of a zero-arity node named `name`. */
function nodeKeyOf(name) {
    return { head: name, args: [] };
}

/**
 * Build a codec whose `rewriteNodeKey` sends each named source head to a fixed
 * target head. A head absent from `mapping` maps to itself.
 *
 * @param {Record<string, string>} mapping
 * @returns {import('../src/generators/incremental_graph/migration_codec').JournalFormatCodec}
 */
function codecMapping(mapping) {
    const codec = makeJournalFormatCodec({
        rewriteNodeKey: (sourceKey) => {
            const sourceHead = String(sourceKey.head);
            const targetHead = Object.prototype.hasOwnProperty.call(mapping, sourceHead)
                ? mapping[sourceHead]
                : sourceHead;
            return { head: targetHead, args: sourceKey.args };
        },
    });
    if (codec instanceof Error) {
        throw codec;
    }
    return codec;
}

/**
 * Exhaustively check the §9a injectivity law over a declared, finite source
 * NodeKey domain. This is the test-model obligation: it iterates the complete
 * declared domain rather than any replica's retained history, so it rejects a
 * many-to-one collapse that no single replica's retained subset witnesses.
 *
 * @param {import('../src/generators/incremental_graph/migration_codec').JournalFormatCodec} codec
 * @param {Array<import('../src/generators/incremental_graph/database/node_key').NodeKey>} domain
 * @returns {Error | undefined} a JournalVersionCompatibilityError, or undefined when injective
 */
function exhaustiveInjectivityRejection(codec, domain) {
    /** @type {Map<string, string>} */
    const targetBySource = new Map();
    for (const key of domain) {
        const sourceText = nodeKeyToCanonicalString(key);
        const rewritten = codec.rewriteNodeKey(key);
        if (isJournalVersionCompatibilityError(rewritten)) {
            return rewritten;
        }
        const targetText = nodeKeyToCanonicalString(rewritten);
        const existingSource = targetBySource.get(targetText);
        if (existingSource !== undefined && existingSource !== sourceText) {
            return makeJournalVersionCompatibilityError(
                "the migration definition's journal format codec maps distinct source node keys " +
                    existingSource + " and " + sourceText + " onto one target node key " + targetText +
                    " over the declared source NodeKey domain, so it is not injective",
                "distinct target node keys for distinct source node keys",
                "one target node key " + targetText
            );
        }
        targetBySource.set(targetText, sourceText);
    }
    return undefined;
}

/**
 * Decide whether one migration definition may be considered for a set of
 * replicas. The exhaustive domain-level injectivity law is evaluated FIRST, over
 * the complete declared domain, before any replica's migration is considered: a
 * domain-level violation rejects the definition and short-circuits every
 * per-replica evaluation.
 *
 * @param {import('../src/generators/incremental_graph/migration_codec').JournalFormatCodec} codec
 * @param {Array<import('../src/generators/incremental_graph/database/node_key').NodeKey>} domain
 * @param {Array<{ name: string, retained: Array<import('../src/generators/incremental_graph/database/node_key').NodeKey> }>} replicas
 * @returns {{ valid: boolean, rejection: Error | undefined, consideredReplicas: string[] }}
 */
function evaluateMigrationDefinition(codec, domain, replicas) {
    const rejection = exhaustiveInjectivityRejection(codec, domain);
    if (rejection !== undefined) {
        return { valid: false, rejection, consideredReplicas: [] };
    }
    return { valid: true, rejection: undefined, consideredReplicas: replicas.map((replica) => replica.name) };
}

/**
 * Run one replica's retained-set scan through the real production rewriter. Each
 * replica migration builds its own rewriter, so one instance observes exactly the
 * keys that replica retained. This is the defensive, observed-collision check of
 * `journal_rewrite.js`: it fires only when this replica's own retained history
 * witnesses two distinct source keys collapsing.
 *
 * @param {import('../src/generators/incremental_graph/migration_codec').JournalFormatCodec} codec
 * @param {Array<import('../src/generators/incremental_graph/database/node_key').NodeKey>} retained
 * @returns {{ observesCollision: boolean, error: Error | undefined }}
 */
function localRetainedSetScan(codec, retained) {
    const rewriter = makeHistoryRewriter(codec);
    for (const key of retained) {
        const rewritten = rewriter.nodeKey(key);
        if (rewritten instanceof Error) {
            return { observesCollision: true, error: rewritten };
        }
    }
    return { observesCollision: false, error: undefined };
}

describe("journal format codec injectivity over the declared source NodeKey domain", () => {
    const K1 = nodeKeyOf("K1");
    const K2 = nodeKeyOf("K2");
    // A historical node family no longer present in the target schema. Per
    // migrations.md §9a it still belongs to the source NodeKey domain even though
    // no replica below retains it.
    const GONE = nodeKeyOf("gone");
    const SOURCE_DOMAIN = [K1, K2, GONE];

    // Two disjoint replicas: A retains only K1's history, B retains only K2's.
    // Neither retains the removed `gone` family.
    const REPLICAS = [
        { name: "A", retained: [K1] },
        { name: "B", retained: [K2] },
    ];

    test("an injective codec over the declared finite source domain satisfies the exhaustive law", () => {
        const injective = codecMapping({ K1: "T1", K2: "T2", gone: "gone" });
        expect(exhaustiveInjectivityRejection(injective, SOURCE_DOMAIN)).toBeUndefined();

        const decision = evaluateMigrationDefinition(injective, SOURCE_DOMAIN, REPLICAS);
        expect(decision.valid).toBe(true);
        expect(decision.rejection).toBeUndefined();
        expect(decision.consideredReplicas).toEqual(["A", "B"]);
    });

    test("a codec collapsing two distinct declared domain keys is rejected before any replica migration is considered valid", () => {
        const collapsing = codecMapping({ K1: "T", K2: "T", gone: "gone" });
        const rejection = exhaustiveInjectivityRejection(collapsing, SOURCE_DOMAIN);
        expect(isJournalVersionCompatibilityError(rejection)).toBe(true);

        const decision = evaluateMigrationDefinition(collapsing, SOURCE_DOMAIN, REPLICAS);
        expect(decision.valid).toBe(false);
        expect(isJournalVersionCompatibilityError(decision.rejection)).toBe(true);
        // The definition is rejected at the domain level, so neither replica's
        // migration is considered: the model does not reach per-replica evaluation.
        expect(decision.consideredReplicas).toEqual([]);
    });

    test("distributed disjoint-history: each replica-local retained-set scan is individually injective, yet the definition is still rejected", () => {
        const collapsing = codecMapping({ K1: "T", K2: "T", gone: "gone" });

        // Each disjoint replica's own retained set is individually injective, so
        // the production defensive scan observes no collision for either one.
        const scanA = localRetainedSetScan(collapsing, REPLICAS[0].retained);
        expect(scanA.observesCollision).toBe(false);
        const scanB = localRetainedSetScan(collapsing, REPLICAS[1].retained);
        expect(scanB.observesCollision).toBe(false);

        // The defensive scan is real, not vacuous: a single replica retaining both
        // colliding keys does witness the collision.
        const combinedRewriter = makeHistoryRewriter(collapsing);
        const first = combinedRewriter.nodeKey(K1);
        expect(first instanceof Error).toBe(false);
        const second = combinedRewriter.nodeKey(K2);
        expect(second instanceof Error).toBe(true);

        // But observing no collision locally is not proof of the domain law. The
        // definition is rejected before either migration is considered valid, so
        // the model MUST NOT accept both migrations merely because their local
        // subsets are individually injective.
        const decision = evaluateMigrationDefinition(collapsing, SOURCE_DOMAIN, REPLICAS);
        expect(decision.valid).toBe(false);
        expect(decision.consideredReplicas).toEqual([]);
    });

    test("the exhaustive law covers the declared domain including a removed node family no replica retains", () => {
        // K1 and the removed family `gone` collapse onto one target key, while K2
        // maps distinctly. No replica retains `gone`, so no local retained-set
        // scan can witness the collision.
        const collapsingRemovedFamily = codecMapping({ K1: "T", K2: "T2", gone: "T" });

        for (const replica of REPLICAS) {
            expect(localRetainedSetScan(collapsingRemovedFamily, replica.retained).observesCollision).toBe(false);
        }

        const rejection = exhaustiveInjectivityRejection(collapsingRemovedFamily, SOURCE_DOMAIN);
        expect(isJournalVersionCompatibilityError(rejection)).toBe(true);

        const decision = evaluateMigrationDefinition(collapsingRemovedFamily, SOURCE_DOMAIN, REPLICAS);
        expect(decision.valid).toBe(false);
        expect(decision.consideredReplicas).toEqual([]);

        // The removed family still belongs to the domain, so a codec that maps it
        // to its own distinct target alongside distinct K1/K2 targets is injective.
        const preservingRemovedFamily = codecMapping({ K1: "T1", K2: "T2", gone: "gone" });
        expect(exhaustiveInjectivityRejection(preservingRemovedFamily, SOURCE_DOMAIN)).toBeUndefined();
        expect(evaluateMigrationDefinition(preservingRemovedFamily, SOURCE_DOMAIN, REPLICAS).valid).toBe(true);
    });
});
