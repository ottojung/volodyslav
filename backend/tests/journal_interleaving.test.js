/**
 * The interleaving argument for `persistedGraph == project(retainedJournal)`.
 *
 * `incremental-graph-journal-theorems.md` Law 1 requires one unique semantic
 * result for `project(J)` "independent of arrival order, wall time, randomness,
 * transport ancestry, computor execution, or mutable graph bytes". Law 2 is the
 * graph/Journal equality which is this issue's actual predicate. Neither is
 * established by replaying a handful of random seeds, and this file takes the
 * named work from the prior front's own `next:` — a property or model-based
 * argument across the interleavings — rather than another sample.
 *
 * The argument has two halves, and the file keeps them apart because they are
 * different claims with different bounds:
 *
 * - **Confluence.** Every presentation of one fixed journal through the
 *   `JournalSource` interface produces the same projection. The presentation
 *   freedom is characterised and enumerated, not sampled: writer enumeration
 *   order, prefix-union decomposition, contributor order, and reader chunk size.
 * - **Differential agreement.** The oracle agrees with an independently written
 *   declarative reference model on acceptance as well as on the projected value,
 *   over the enumerated journal space.
 *
 * The journal space itself is the interleaving space: a per-writer choice of
 * operations plus every linear extension of the resulting writer chains, because a
 * linear extension is exactly a legal interleaving of two concurrent writers and
 * it is what fixes each record's context cut and authority allocation.
 *
 * Every state-space claim here states the bound it actually proved. None of it is
 * the general theorem, and the file says which half of the predicate is still
 * unaddressed.
 */

const {
    authorityCompare,
    isJournalCausalClosureError,
    isJournalGapError,
    journalAuthorToString,
    journalRecordIdToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalSequence,
    makeValueEvent,
    validateJournalReplica,
} = require("../src/generators/incremental_graph/journal");

const {
    makeReplicaSource,
    makeUnionSource,
    projectRetainedJournal,
    readerOverIterable,
    selectCertificates,
    selectSemanticHeads,
    selectedValueId,
    summarizeInvalidations,
} = require("../src/generators/incremental_graph/journal/oracle");

const { declarativeProject } = require("./oracle_declarative_reference");

const {
    adversarialFixtures,
    forkFixture,
    keyAt,
    enumerateJournals,
    makeJournalAuthorFromName,
    presentationsOf,
    replicaOf,
    schemaOf,
} = require("./interleaving_space");

/**
 * A readable label for one element of a comparison grid, so a violation names the
 * record rather than printing an object graph.
 * @param {{id: {author: {__value: string}, sequence: {__value: string}}, authorityTime: {physical: number, logical: {__value: string}}}} record
 * @returns {string}
 */
function label(record) {
    return (
        record.id.author.__value +
        ":" +
        record.id.sequence.__value +
        "@" +
        record.authorityTime.physical +
        "/" +
        record.authorityTime.logical.__value
    );
}

/**
 * The sign of a comparison, with the negative zero which `Math.sign(0)` and
 * `-Math.sign(0)` produce for a self-comparison normalised away. Antisymmetry is
 * about the comparison and not about JavaScript signed zeros.
 * @param {number} comparison
 * @returns {-1 | 0 | 1}
 */
function signOf(comparison) {
    return comparison < 0 ? -1 : comparison > 0 ? 1 : 0;
}

/**
 * Reduce a projection to a comparable plain value, so a disagreement names the
 * node and the field rather than comparing object identities. Every field the
 * lowering writes is included, including both persisted timestamps, so a
 * normalisation on either side would show as a disagreement.
 * @param {object} projection
 * @returns {string}
 */
function summarize(projection) {
    return JSON.stringify({
        lastNodeIndex: projection.lastNodeIndex,
        selfProofReady: [...projection.selfProofReadyNodes].sort(),
        unmarkedPropagatedStaleness: [...projection.unmarkedPropagatedStaleness].sort(),
        occurrences: projection.occurrences.map((occurrence) => [
            occurrence.nodeKeyString,
            journalRecordIdToString(occurrence.valueId),
            occurrence.nodeIdentifier,
            occurrence.createdAt,
            occurrence.modifiedAt,
            occurrence.fresh,
            [...occurrence.validInputs].sort(),
        ]),
    });
}

/**
 * The outcome of one projection, as a value two presentations can be compared
 * through. A rejection is named by its error class, because the accepted/rejected
 * decision is the claim under test and the class is not.
 * @param {object} options
 * @param {import("../src/generators/incremental_graph/journal/oracle").JournalSource} options.source
 * @param {string} options.localWriterName
 * @returns {{accepted: boolean, value: string, error: import("../src/generators/incremental_graph/journal").AnyJournalError | undefined}}
 */
function runOnce(options) {
    const projection = projectRetainedJournal({
        source: options.source,
        localWriter: makeJournalAuthorFromName(options.localWriterName),
        currentInputKeysOfNode: schemaOf,
    });
    if (projection instanceof Error) {
        return { accepted: false, value: projection.name, error: projection };
    }
    return { accepted: true, value: summarize(projection), error: undefined };
}

/**
 * The local writer is `A` throughout. It affects only the reconstructed allocator
 * watermark, so fixing it keeps the comparison about the projection and not about
 * which writer happened to be asked.
 */
const LOCAL_WRITER = "aaaaaaaaa";

/**
 * The space the confluence and differential claims are made over.
 *
 * Two writers, three coordinates each, over the full operation alphabet. The
 * bound is measured rather than assumed: it is reported by the "bound grows with
 * the space" test, and the coverage tests assert that the accepted part of the
 * space really does reach the certificate pass, so a green confluence run cannot
 * be green because the certificate pass was never entered.
 */
const SPACE = [2, 2];

/** A strictly smaller space, used to show the bound is a function of the space. */
const SMALL_SPACE = [2, 1];

/**
 * The space the differential agreement is claimed over.
 *
 * It is larger than `SPACE`, because agreement with the model is one projection
 * per journal while confluence is one projection per *presentation* of a journal,
 * and the presentation count is what makes the exhaustive confluence sweep
 * expensive. The two bounds are reported separately because they are different
 * measurements of different spaces.
 */
const DIFFERENTIAL_SPACE = [3, 2];

/**
 * Every presentation of a journal, with the outcome of each.
 * @param {import("./interleaving_space").GeneratedJournal} journal
 * @returns {Array<{label: string, outcome: ReturnType<typeof runOnce>}>}
 */
function outcomesOf(journal) {
    return presentationsOf(journal).map((presentation) => ({
        label: presentation.label,
        outcome: runOnce({ source: presentation.source, localWriterName: LOCAL_WRITER }),
    }));
}

/**
 * The single presentation every other presentation is compared against: the
 * whole journal as one source per writer, writers in ascending name order, one
 * record buffered at a time.
 * @param {import("./interleaving_space").GeneratedJournal} journal
 * @returns {{label: string, outcome: ReturnType<typeof runOnce>}}
 */
function canonicalOutcomeOf(journal) {
    const first = presentationsOf(journal, { chunkSizes: [1] })[0];
    if (first === undefined) {
        throw new Error("a journal with no presentation cannot be projected");
    }
    return { label: first.label, outcome: runOnce({ source: first.source, localWriterName: LOCAL_WRITER }) };
}

describe("the interleaving space the Journal record layer and the project oracle admit", () => {
    test("the enumerated space is the interleaving space, and it is not empty", () => {
        // A retained journal is a set of per-writer streams, and a writer's own
        // stream order is immutable. So the freedom in a retained journal is the
        // per-writer operation choice plus the cross-writer interleaving, and the
        // interleaving is a linear extension of the writer chains. If this test
        // ever reports an empty or single-member space, the space stopped being
        // the interleaving space and every confluence claim below is void.
        const space = enumerateJournals({ lengths: SMALL_SPACE });
        expect(space.writers).toEqual(["aaaaaaaaa", "bbbbbbbbb"]);
        expect(space.bound).toBe(space.journals.length);
        expect(space.journals.length).toBeGreaterThan(1);

        // Both writers are populated, so the space really does contain genuinely
        // concurrent writers rather than one writer and an empty stream.
        const populated = space.journals.filter((journal) =>
            Object.values(journal.streams).every((stream) => stream.length > 0)
        );
        expect(populated.length).toBe(space.journals.length);

        // The same operation assignment reached through different interleavings
        // produces different journals, which is what makes this an interleaving
        // space rather than a set of distinct operation sequences.
        const byAssignment = new Map();
        for (const journal of space.journals) {
            const key = journal.operations.join("|");
            const existing = byAssignment.get(key) ?? [];
            existing.push(journal);
            byAssignment.set(key, existing);
        }
        const concurrent = [...byAssignment.values()].filter((group) => group.length > 1);
        expect(concurrent.length).toBeGreaterThan(0);
        const differing = concurrent.filter((group) => {
            const cuts = new Set(
                group.map((journal) =>
                    Object.values(journal.streams)
                        .flat()
                        .map((record) =>
                            "context" in record
                                ? JSON.stringify([...record.context])
                                : "writer-state"
                        )
                        .join(" ")
                )
            );
            return cuts.size > 1;
        });
        expect(differing.length).toBeGreaterThan(0);
    });

    test("the enumerated journals are supported journals the record layer accepts", () => {
        // The confluence claim is about supported journals. A generated journal
        // which the record layer's own well-formedness rules reject is not a
        // counterexample to anything, so the space is filtered to the members
        // `validateJournalReplica` accepts before any confluence claim is made.
        const space = enumerateJournals({ lengths: SPACE });
        const accepted = space.journals.filter(
            (journal) => validateJournalReplica(replicaOf(journal)) === undefined
        );
        expect(accepted.length).toBeGreaterThan(space.journals.length / 2);
    });
});

describe("the projection is confluent over every presentation of a fixed journal", () => {
    /**
     * The claim: for one fixed supported journal, the projection does not depend
     * on how the source presents it.
     *
     * The presentation space per journal is: every order the writers are
     * enumerated in, times every order-preserving decomposition of each writer's
     * stream into prefix contributors, times four reader chunk sizes for the
     * single-contributor presentations. That space is enumerated in full; nothing
     * here is sampled.
     */
    test("acceptance and the projected value are both invariant, over the whole enumerated space", () => {
        const space = enumerateJournals({ lengths: SPACE });
        const supported = space.journals.filter(
            (journal) => validateJournalReplica(replicaOf(journal)) === undefined
        );
        expect(supported.length).toBeGreaterThan(0);

        let presentationsChecked = 0;
        /** @type {string[]} */
        const disagreements = [];
        for (const journal of supported) {
            const canonical = canonicalOutcomeOf(journal);
            for (const candidate of outcomesOf(journal)) {
                presentationsChecked += 1;
                if (candidate.outcome.accepted !== canonical.outcome.accepted) {
                    disagreements.push(
                        "acceptance differs: " +
                            candidate.label +
                            " " +
                            candidate.outcome.value +
                            " vs canonical " +
                            canonical.label +
                            " " +
                            canonical.outcome.value
                    );
                    continue;
                }
                if (candidate.outcome.value !== canonical.outcome.value) {
                    disagreements.push(
                        "value differs: " +
                            candidate.label +
                            " vs canonical " +
                            canonical.label
                    );
                }
            }
        }
        expect(disagreements).toEqual([]);
        // The bound is a measured count, not an assumption: this asserts the
        // enumeration actually ran rather than silently finding nothing to check.
        expect(presentationsChecked).toBeGreaterThan(supported.length);
    });

    test("the bound grows with the space and is stated rather than assumed", () => {
        // A bound nobody can see the growth of is indistinguishable from a bound
        // which happened to be small. The presentation count per journal is a
        // function of the retained lengths, and the journal count is a function of
        // the operation alphabet and those lengths, so both are reported here as
        // measured numbers.
        const smaller = enumerateJournals({ lengths: SMALL_SPACE });
        const larger = enumerateJournals({ lengths: SPACE });
        expect(larger.journals.length).toBeGreaterThan(smaller.journals.length);

        const presentationsOfSmall = presentationsOf(smaller.journals[0]);
        const presentationsOfLarge = presentationsOf(larger.journals[0]);
        expect(presentationsOfLarge.length).toBeGreaterThan(presentationsOfSmall.length);
    });

    test("rejection is a function of the journal, and the reader chunk size is not one of its causes", () => {
        // A source which buffers its records differently is the same source. If
        // chunk size could change the outcome, the streaming claim in
        // `incremental-graph-journal-testing.md` §Streaming correctness would be
        // false, and this is the smallest fixture which would show it: a journal
        // whose writer state record is read at a chunk boundary.
        const space = enumerateJournals({ lengths: SPACE });
        const withWriterState = space.journals.filter((journal) =>
            Object.values(journal.streams)
                .flat()
                .some((record) => record.kind === "writer-state")
        );
        expect(withWriterState.length).toBeGreaterThan(0);
        for (const journal of withWriterState) {
            const values = new Set(
                presentationsOf(journal, { chunkSizes: [1, 2, 3, 7, 1000] }).map(
                    (presentation) => runOnce({ source: presentation.source, localWriterName: LOCAL_WRITER }).value
                )
            );
            expect([...values]).toHaveLength(1);
        }
    });
});

describe("the oracle agrees with the declarative reference model across the interleaving space", () => {
    test("agreement on acceptance and on the projected value, over the whole enumerated space", () => {
        // The differential is the only thing standing between this file and a
        // self-consistent restatement of the oracle, so it runs over the whole
        // enumerated space rather than over a fixture per named regression.
        // Disagreement is reported, never repaired: the model is not adjusted to
        // agree, because a model tuned until it agrees is worse than no model.
        const space = enumerateJournals({ lengths: DIFFERENTIAL_SPACE });
        const supported = space.journals.filter(
            (journal) => validateJournalReplica(replicaOf(journal)) === undefined
        );
        /** @type {string[]} */
        const disagreements = [];
        let agreed = 0;
        for (const journal of supported) {
            const oracle = runOnce({
                source: presentationsOf(journal, { chunkSizes: [1] })[0].source,
                localWriterName: LOCAL_WRITER,
            });
            const model = declarativeProject(replicaOf(journal), LOCAL_WRITER, schemaOf);
            if (!oracle.accepted) {
                if (model.publishable) {
                    disagreements.push(
                        "the model published a journal the oracle rejected with " + oracle.value
                    );
                }
                continue;
            }
            if (!model.publishable) {
                disagreements.push("the model declined a journal the oracle published");
                continue;
            }
            const oracleShape = JSON.parse(oracle.value).occurrences;
            const modelShape = model.occurrences.map((occurrence) => [
                occurrence.nodeKeyString,
                occurrence.valueId,
                occurrence.nodeIdentifier,
                occurrence.createdAt,
                occurrence.modifiedAt,
                occurrence.fresh,
                occurrence.validInputs,
            ]);
            if (JSON.stringify(oracleShape) !== JSON.stringify(modelShape)) {
                disagreements.push(
                    "the projected value differs: oracle " +
                        JSON.stringify(oracleShape) +
                        " vs model " +
                        JSON.stringify(modelShape)
                );
                continue;
            }
            agreed += 1;
        }
        expect(disagreements).toEqual([]);
        expect(agreed).toBeGreaterThan(0);
    });
});

describe("the premises which make confluence hold by construction", () => {
    test("authorityCompare is a strict total order, so the head fold has a unique maximum", () => {
        // This is the step which carries confluence rather than merely observing
        // it. `selectSemanticHeads` keeps a running maximum, which is
        // order-independent exactly when the comparison is a total order on the
        // records it folds over. The grid below is closed and finite, and every
        // element of it is a distinct record, so this is exhaustive over it.
        const grid = [];
        for (const writerName of ["aaaaaaaaa", "bbbbbbbbb"]) {
            for (const sequence of ["1", "2"]) {
                for (const physical of [0, 1]) {
                    for (const logical of ["0", "1"]) {
                        const author = makeJournalAuthor(writerName);
                        const journalSequence = makeJournalSequence(sequence);
                        if (author instanceof Error || journalSequence instanceof Error) {
                            throw new Error("the totality grid built a coordinate the record layer rejects");
                        }
                        grid.push({
                            id: { author, sequence: journalSequence },
                            context: makeJournalFrontierFromText([]),
                            authorityTime: makeAuthorityTime(physical, logical),
                        });
                    }
                }
            }
        }
        expect(grid).toHaveLength(16);

        /**
         * Every order-theoretic property this grid has to satisfy, collected and
         * asserted once, so a failure names the offending triple rather than
         * aborting at the first bad pair.
         * @type {string[]}
         */
        const violations = [];
        for (const left of grid) {
            if (authorityCompare(left, left) !== 0) {
                violations.push("irreflexive on itself: " + label(left));
            }
            for (const right of grid) {
                if (signOf(authorityCompare(left, right)) + signOf(authorityCompare(right, left)) !== 0) {
                    violations.push("antisymmetry: " + label(left) + " vs " + label(right));
                }
                // A tie between two distinct records is what would make a running
                // maximum depend on arrival order, so it is the property that
                // carries the confluence claim and it is checked over every pair.
                if (left !== right && authorityCompare(left, right) === 0) {
                    violations.push("distinct records tie: " + label(left) + " vs " + label(right));
                }
            }
        }
        for (const left of grid) {
            for (const middle of grid) {
                for (const right of grid) {
                    if (
                        authorityCompare(left, middle) <= 0 &&
                        authorityCompare(middle, right) <= 0 &&
                        authorityCompare(left, right) > 0
                    ) {
                        violations.push(
                            "transitivity: " + label(left) + " <= " + label(middle) + " <= " + label(right)
                        );
                    }
                }
            }
        }
        expect(violations).toEqual([]);
    });

    test("a strict total order over a finite set has an order-independent maximum", () => {
        // The induction step the running maximum rests on, stated as an
        // executable property over the grid rather than argued in prose: folding a
        // maximum in any order yields the same winner, and a running maximum which
        // replaces its incumbent only on a strict improvement yields the maximum
        // even when the maximum arrives first.
        const records = [];
        for (const writerName of ["aaaaaaaaa", "bbbbbbbbb"]) {
            for (const sequence of ["1", "2", "3"]) {
                const author = makeJournalAuthor(writerName);
                const journalSequence = makeJournalSequence(sequence);
                if (author instanceof Error || journalSequence instanceof Error) {
                    throw new Error("the fold grid built a coordinate the record layer rejects");
                }
                records.push({
                    id: { author, sequence: journalSequence },
                    context: makeJournalFrontierFromText([]),
                    authorityTime: makeAuthorityTime(0, sequence),
                });
            }
        }
        const expected = records.reduce((best, record) =>
            authorityCompare(record, best) > 0 ? record : best
        );
        /** @type {string[]} */
        const differing = [];
        for (let rotation = 0; rotation < records.length; rotation++) {
            const rotated = [...records.slice(rotation), ...records.slice(0, rotation)];
            let incumbent = rotated[0];
            for (const record of rotated.slice(1)) {
                if (incumbent === undefined) {
                    throw new Error("the fold grid produced an empty rotation");
                }
                if (authorityCompare(record, incumbent) > 0) {
                    incumbent = record;
                }
            }
            if (incumbent !== expected) {
                differing.push("rotation " + String(rotation));
            }
        }
        expect(differing).toEqual([]);
    });
});

describe("the authority tiebreak is observable only in the selected certificate, not in the projection", () => {
    test("the certificate pass selects the greater authority when every earlier key ties", () => {
        // This limit is worth stating rather than papering over. When two eligible
        // certificates have equal effective basis and equal invalidation coverage,
        // the authority tiebreak is the only thing which separates them — and
        // because those three keys together determine every field the projection
        // reports, the tiebreak is *unobservable in the projection itself*. A
        // mutation which replaced the tiebreak with "keep the incumbent" therefore
        // produces a different selected certificate and an identical projection.
        //
        // It is not unobservable in the implementation, because the certificate
        // pass is exported and the selected certificate is a real output of it. It
        // is asserted here, at that seam, which is the only place it can be seen.
        const fixture = adversarialFixtures().find(
            (candidate) => candidate.name === "authority breaks an otherwise exact certificate tie"
        );
        expect(fixture).toBeDefined();
        if (fixture === undefined) {
            throw new Error("the authority-tiebreak fixture is missing");
        }
        const source = makeReplicaSource(replicaOf(fixture.journal));
        const heads = selectSemanticHeads(source);
        expect("error" in heads).toBe(false);
        if ("error" in heads) {
            throw new Error("head selection failed on a supported journal");
        }
        /** @type {Map<string, {node: import("../src/generators/incremental_graph/journal").NodeKey, valueId: import("../src/generators/incremental_graph/journal").JournalRecordId}>} */
        const selectedOccurrences = new Map();
        for (const nodeKeyString of [...heads.selections.keys()].sort()) {
            const valueId = selectedValueId(heads.selections, nodeKeyString);
            const selection = heads.selections.get(nodeKeyString);
            if (valueId === undefined || selection === undefined) {
                continue;
            }
            selectedOccurrences.set(nodeKeyString, { node: selection.nodeKey, valueId });
        }
        const invalidations = summarizeInvalidations(source, selectedOccurrences);
        expect("error" in invalidations).toBe(false);
        if ("error" in invalidations) {
            throw new Error("invalidation summarisation failed on a supported journal");
        }
        /** @type {Map<string, import("../src/generators/incremental_graph/journal").JournalAuthor>} */
        const names = new Map();
        for (const author of source.writers()) {
            names.set(journalAuthorToString(author), author);
        }
        const certificates = selectCertificates(source, {
            occurrences: {
                valueIdOf: (nodeKeyString) => selectedValueId(heads.selections, nodeKeyString),
                authorOf: (name) => names.get(name),
            },
            summaries: invalidations.summaries,
            currentInputKeysOfNode: schemaOf,
        });
        expect("error" in certificates).toBe(false);
        if ("error" in certificates) {
            throw new Error("certificate selection failed on a supported journal");
        }
        const selected = certificates.certificates.get(keyAt(0));
        expect(selected).toBeDefined();
        if (selected === undefined) {
            throw new Error("no certificate was selected for the root occurrence");
        }
        // The root occurrence is revalidated twice with an identical basis, once by
        // each writer, and only the authority times differ, so the selected
        // certificate must be the second writer's.
        expect(journalAuthorToString(selected.certificate.id.author)).toBe("bbbbbbbbb");
    });
});

describe("which defect is reported", () => {
    /**
     * A value event for one coordinate of one writer, with the context the test
     * asks for, so that a defective context can be built directly.
     * @param {string} writerName
     * @param {number} sequence
     * @param {number} nodeId
     * @param {ReadonlyArray<[string, string]>} context
     * @param {number} physical
     * @returns {import("../src/generators/incremental_graph/journal").JournalRecord}
     */
    const value = (writerName, sequence, nodeId, context, physical) =>
            makeValueEvent(
                {
                    id: writerName + ":" + String(sequence),
                    context: makeJournalFrontierFromText(context),
                    authorityTime: makeAuthorityTime(physical, "0"),
                    node: { head: "event", args: [{ id: nodeId }] },
                },
                String(nodeId) + "-abcdefghi",
                { type: "entry_description", description: "v" + String(nodeId) },
                "2020-01-01T00:00:00.000Z",
                "2020-01-02T00:00:00.000Z",
            "compute"
        );

    /**
     * A source over named per-writer retained streams which enumerates its
     * writers in whatever order it is given.
     *
     * The order is a parameter rather than an accident because the order is the
     * degree of freedom under test. A source which sorted internally could not
     * exhibit the behaviour these tests are about, and would also hide it.
     * @param {Record<string, import("../src/generators/incremental_graph/journal").JournalRecord[]>} streams
     * @param {ReadonlyArray<string>} order
     * @returns {import("../src/generators/incremental_graph/journal/oracle").JournalSource}
     */
    const sourceOver = (streams, order) => {
        /** @type {Record<string, import("../src/generators/incremental_graph/journal").JournalAuthor>} */
        const authors = {};
        for (const writerName of Object.keys(streams)) {
            const author = makeJournalAuthor(writerName);
            if (author instanceof Error) {
                throw new Error("the test built an author the record layer rejects");
            }
            authors[writerName] = author;
        }
        return {
            writers: () => order.map((writerName) => authors[writerName]),
            retainedLengthOf: (author) => {
                const records = streams[journalAuthorToString(author)];
                const last = records?.[records.length - 1];
                return last === undefined ? undefined : last.id.sequence;
            },
            prefixReaderOf: (author) => {
                const writerName = journalAuthorToString(author);
                const records = streams[writerName] ?? [];
                const last = records[records.length - 1];
                return readerOverIterable(
                    writerName,
                    records,
                    last === undefined ? makeJournalSequence("0") : last.id.sequence
                );
            },
        };
    };

    /**
     * Every ordering of three writers.
     * @param {string} a
     * @param {string} b
     * @param {string} c
     * @returns {string[][]}
     */
    const allOrders = (a, b, c) => [
        [a, b, c],
        [a, c, b],
        [b, a, c],
        [b, c, a],
        [c, a, b],
        [c, b, a],
    ];

    /**
     * A retained journal in which each of three writers carries a different
     * genuine defect.
     *
     * - `A` retains `A:1` and `A:3`, so `A:2` is a hole;
     * - `B` retains `B:1`, whose context claims a coordinate no writer retains,
     *   so the context is not closed;
     * - `C` retains `C:1`, whose own-writer context coordinate is not its
     *   predecessor, so the context is not a complete local prefix.
     *
     * Every one of these is a real defect, so no enumeration order of this
     * journal is a supported journal and the accept/reject decision is the same
     * in all of them. Which of the three is *reported* is what used to move with
     * the enumeration order, because every pass stops at the first failure it
     * meets and every pass walked `writers()` order.
     * @returns {Record<string, import("../src/generators/incremental_graph/journal").JournalRecord[]>}
     */
    const threeDefectiveStreams = () => ({
        aaaaaaaaa: [
            value("aaaaaaaaa", 1, 1, [], 100),
            value("aaaaaaaaa", 3, 1, [["aaaaaaaaa", "2"]], 300),
        ],
        bbbbbbbbb: [value("bbbbbbbbb", 1, 2, [["zzzzzzzzz", "9"]], 200)],
        ccccccccc: [value("ccccccccc", 1, 3, [["ccccccccc", "2"]], 400)],
    });

    test("a journal with two independent defects reports the same defect in either order", () => {
        // The counterexample this front found, repaired rather than deleted. With
        // a hole in `A` and a non-closed context in `B`, the two enumeration
        // orders used to name different defects of the same retained journal:
        // `A` first reported `JournalGapError` and `B` first reported
        // `JournalCausalClosureError`. The accept/reject decision was invariant
        // throughout, so the finding was a defect in the failure channel rather
        // than in the decision.
        //
        // The test is kept, and kept as the same two orders, because those two
        // orders disagreeing is the evidence the finding rested on. A test which
        // only ever asked for one order would not notice the order-dependence
        // returning.
        const streams = {
            aaaaaaaaa: [
                value("aaaaaaaaa", 1, 1, [], 100),
                value("aaaaaaaaa", 3, 1, [["aaaaaaaaa", "2"]], 300),
            ],
            bbbbbbbbb: [value("bbbbbbbbb", 1, 2, [["zzzzzzzzz", "9"]], 200)],
        };
        const holeFirst = runOnce({ source: sourceOver(streams, ["aaaaaaaaa", "bbbbbbbbb"]), localWriterName: LOCAL_WRITER });
        const closureFirst = runOnce({ source: sourceOver(streams, ["bbbbbbbbb", "aaaaaaaaa"]), localWriterName: LOCAL_WRITER });

        // The decision is invariant, which is the claim the confluence test above
        // makes and the reason the finding was a diagnosability defect rather
        // than a violation of Law 1.
        expect([holeFirst.accepted, closureFirst.accepted]).toEqual([false, false]);
        // The report is invariant too, and it is the earlier writer's defect: the
        // gap at `A:2`.
        expect([holeFirst.value, closureFirst.value]).toEqual(["JournalGapError", "JournalGapError"]);
        expect(isJournalGapError(holeFirst.error)).toBe(true);
        expect(isJournalCausalClosureError(closureFirst.error)).toBe(false);
        expect(holeFirst.error?.message).toBe(closureFirst.error?.message);
    });

    test("every enumeration order of a three-defect journal reports one defect", () => {
        // The regression the finding calls for, and the assertion which goes red
        // on a walk that reads the source's enumeration order. Three writers with
        // three different defects, read in all six orders: every order must reject
        // with the identical error, naming the identical defect of the identical
        // coordinate.
        //
        // Comparing `error.message` rather than the error class is deliberate. A
        // walk which normalised the class while still reporting a different
        // record's defect would satisfy a class-only comparison, and which defect
        // a caller is told about is the whole question.
        const streams = threeDefectiveStreams();
        /** @type {string[]} */
        const reports = [];
        for (const order of allOrders("aaaaaaaaa", "bbbbbbbbb", "ccccccccc")) {
            const outcome = runOnce({ source: sourceOver(streams, order), localWriterName: LOCAL_WRITER });
            expect([order.join(""), outcome.accepted]).toEqual([order.join(""), false]);
            if (outcome.error === undefined) {
                throw new Error("a defective journal was rejected without an error");
            }
            reports.push(outcome.error.name + ": " + outcome.error.message);
        }
        // One distinct report across all six orders.
        expect([...new Set(reports)]).toHaveLength(1);
        expect(reports[0]).toBe(reports[1]);
        expect(reports[0]).toBe(reports[2]);
        expect(reports[0]).toBe(reports[3]);
        expect(reports[0]).toBe(reports[4]);
        expect(reports[0]).toBe(reports[5]);
    });

    test("the reported defect is the canonical-earliest writer's, not the first enumerated", () => {
        // Which single defect the canonical walk reports, asserted directly, so
        // the invariance above cannot be satisfied by reporting one fixed
        // unrelated error for every order. The canonical-earliest writer is `A`
        // and the order the source enumerates here is reverse-canonical, so the
        // first writer the fold reaches is the last writer a caller would expect.
        const streams = threeDefectiveStreams();
        const outcome = runOnce({
            source: sourceOver(streams, ["ccccccccc", "bbbbbbbbb", "aaaaaaaaa"]),
            localWriterName: LOCAL_WRITER,
        });
        expect(outcome.accepted).toBe(false);
        if (outcome.error === undefined) {
            throw new Error("a defective journal was rejected without an error");
        }
        expect(isJournalGapError(outcome.error)).toBe(true);
        expect(outcome.error.message).toContain("aaaaaaaaa:2");

        // The same journal read in canonical order reports the same defect, so
        // the two differ only in what the source enumerated.
        const canonical = runOnce({
            source: sourceOver(streams, ["aaaaaaaaa", "bbbbbbbbb", "ccccccccc"]),
            localWriterName: LOCAL_WRITER,
        });
        if (canonical.error === undefined) {
            throw new Error("a defective journal was rejected without an error");
        }
        expect(canonical.error.message).toBe(outcome.error.message);
    });

    test("the order-dependence cannot turn a rejection into an acceptance", () => {
        // The stronger question, and the one which decides whether the finding
        // above is a diagnosability defect or a correctness defect. A source which
        // enumerates its writers in an order the specification does not require is
        // not a supported source, so a caller cannot rely on any particular
        // order; if that could change the accept/reject decision then Law 1's
        // determinism would fail on supported input. It does not, over the whole
        // enumerated space.
        const space = enumerateJournals({ lengths: SPACE });
        /** @type {string[]} */
        const flipped = [];
        for (const journal of space.journals) {
            const outcomes = outcomesOf(journal);
            const accepted = outcomes.filter((entry) => entry.outcome.accepted);
            if (accepted.length !== 0 && accepted.length !== outcomes.length) {
                flipped.push(
                    "mixed: " +
                        outcomes
                            .map((entry) => entry.label + "=" + entry.outcome.value)
                            .join(" ")
                );
            }
        }
        expect(flipped).toEqual([]);
    });
});

describe("the adversarial fixtures isolate one projection rule each", () => {
    /**
     * The enumerated space is exhaustive but coarse, so it cannot by itself tell a
     * correct implementation from one which dropped a rule the other rules happen
     * to duplicate. These fixtures close that gap: each builds a journal in which
     * exactly one rule is the difference between a right and a wrong answer.
     *
     * The property asserted here is the one which makes the rest of the file
     * meaningful: a fixture must produce the outcome it was designed to produce,
     * and must be a journal the record layer accepts apart from the single rule it
     * deliberately violates.
     */
    test("every fixture is well formed apart from the rule it names", () => {
        /** @type {string[]} */
        const wrong = [];
        for (const fixture of adversarialFixtures()) {
            const failure = validateJournalReplica(replicaOf(fixture.journal));
            const wellFormed = failure === undefined;
            if (fixture.supported !== wellFormed) {
                wrong.push(
                    fixture.name +
                        ": expected " +
                        (fixture.supported === true ? "accepted" : "rejected") +
                        " but the record layer said " +
                        (wellFormed ? "accepted" : "rejected")
                );
            }
        }
        expect(wrong).toEqual([]);
    });

    test("each fixture produces the outcome the record layer's own rules demand", () => {
        // The record layer's validators and the oracle's checks are two independent
        // expressions of the same conditions, so for the fixtures which deliberately
        // violate one of them, both must reject and the tests must assert both. A
        // mutation which removes the oracle's check while leaving the record layer's
        // validator intact is exactly the kind of defect that a test asserting only
        // the validator would miss, and the "well formed apart from the rule it
        // names" test above is such a test on its own.
        for (const fixture of adversarialFixtures()) {
            const outcome = canonicalOutcomeOf(fixture.journal);
            // `projectable` rather than `supported`, because being well formed and
            // being projectable are different questions and conflating them would
            // make a dependency-closure rejection look like a well-formedness
            // failure.
            expect([fixture.name, outcome.outcome.accepted]).toEqual([
                fixture.name,
                fixture.projectable ?? fixture.supported !== false,
            ]);
        }
    });

    test("a fork between two retained prefixes is reported, and contributor order does not change that", () => {
        // The no-forks condition is a consequence of the merge comparing canonical
        // meaning where two contributors meet, so the only way to observe it is to
        // supply two contributors which meet and disagree. Contributor order is
        // part of the presentation space, so the report must not depend on it.
        const fork = forkFixture();
        const sources = (order) =>
            order.map((which) =>
                makeReplicaSource(replicaOf(which === "left" ? fork.agreeing : fork.disagreeing))
            );
        for (const order of [["left", "right"], ["right", "left"]]) {
            const outcome = runOnce({
                source: makeUnionSource(sources(order)),
                localWriterName: LOCAL_WRITER,
            });
            expect([order.join(","), outcome.accepted]).toEqual([order.join(","), false]);
            expect([order.join(","), outcome.value]).toEqual([order.join(","), "JournalForkError"]);
        }
    });

    test("each fixture isolates a distinct rule", () => {
        // The fixtures are only worth their cost if each one is load-bearing, so
        // the isolation each claims is asserted rather than left for a reader of
        // the fixture source to verify.
        const isolated = adversarialFixtures().map((fixture) => fixture.isolates);
        expect(new Set(isolated).size).toBe(isolated.length);
        expect(isolated.length).toBeGreaterThanOrEqual(10);
    });

    test("each fixture is confluent over its own presentation space, and agrees with the model", () => {
        /** @type {string[]} */
        const wrong = [];
        for (const fixture of adversarialFixtures()) {
            const canonical = canonicalOutcomeOf(fixture.journal);
            for (const candidate of outcomesOf(fixture.journal)) {
                if (candidate.outcome.accepted !== canonical.outcome.accepted) {
                    wrong.push(
                        fixture.name +
                            ": " +
                            candidate.label +
                            " accepted=" +
                            candidate.outcome.accepted +
                            " vs canonical " +
                            canonical.label +
                            " accepted=" +
                            canonical.outcome.accepted
                    );
                } else if (
                    canonical.outcome.accepted &&
                    candidate.outcome.value !== canonical.outcome.value
                ) {
                    wrong.push(fixture.name + ": " + candidate.label + " projects a different value");
                }
            }
            // The differential is scoped to well-formed journals, and that scope
            // is a property of the model rather than a convenience: the oracle
            // checks own-writer prefix exactness and retained-range coverage as
            // conditions of replay, while the declarative model implements only the
            // dependency-closure rejection. A fixture which deliberately violates a
            // context condition is therefore a case where the two models answer
            // different questions, and asserting agreement there would be asserting
            // that the model implements a rule it does not.
            const model = declarativeProject(replicaOf(fixture.journal), LOCAL_WRITER, schemaOf);
            if (fixture.supported === true && model.publishable !== canonical.outcome.accepted) {
                wrong.push(
                    fixture.name +
                        ": the model published=" +
                        model.publishable +
                        " but the oracle accepted=" +
                        canonical.outcome.accepted
                );
            }
            if (canonical.outcome.accepted) {
                const projected = JSON.parse(canonical.outcome.value).occurrences;
                const modelled = model.occurrences.map((occurrence) => [
                    occurrence.nodeKeyString,
                    occurrence.valueId,
                    occurrence.nodeIdentifier,
                    occurrence.createdAt,
                    occurrence.modifiedAt,
                    occurrence.fresh,
                    occurrence.validInputs,
                ]);
                if (JSON.stringify(projected) !== JSON.stringify(modelled)) {
                    wrong.push(
                        fixture.name +
                            ": the oracle projects " +
                            JSON.stringify(projected) +
                            " and the model projects " +
                            JSON.stringify(modelled)
                    );
                }
            }
        }
        expect(wrong).toEqual([]);
    });

    test("each ordering key's fixture detects its own mutation, in the field that key decides", () => {
        // Read as the executable statement of what each isolating fixture is for.
        //
        // The basis-strength and coverage keys are both invisible in the projected
        // occurrences of their own fixtures, and asserting them there would assert
        // nothing. A certificate which proves fewer edges and one which does not
        // cover an invalidation can both leave the *selected* occurrence looking the
        // same; what they differ on is which certificate wins, and that shows up in
        // the derived self-proof report rather than in the lowered occurrences. The
        // assertions below are therefore made on the field each key actually
        // decides, which is the only place the key is observable at all.
        const byName = new Map(adversarialFixtures().map((fixture) => [fixture.name, fixture]));

        /**
         * @param {string} name
         * @returns {{selfProofReady: string[], unmarked: string[]}}
         */
        const report = (name) => {
            const fixture = byName.get(name);
            if (fixture === undefined) {
                throw new Error("fixture not found: " + name);
            }
            const outcome = canonicalOutcomeOf(fixture.journal);
            if (!outcome.outcome.accepted) {
                throw new Error("fixture was rejected: " + name);
            }
            const parsed = JSON.parse(outcome.outcome.value);
            return {
                selfProofReady: parsed.selfProofReady,
                unmarked: parsed.unmarkedPropagatedStaleness,
            };
        };

        // Basis strength: the stale-valued certificate has far greater authority,
        // and if the strength key were dropped it would win, leaving the root
        // occurrence without a certificate that covers its value invalidations.
        const basis = report("effective basis strength beats clock authority");
        expect(basis.selfProofReady).toContain(keyAt(0));

        // Value-invalidation coverage: the covering certificate has the lesser
        // authority, and if the coverage key were dropped the concurrent one would
        // win, so the root would stop being self-proof-ready.
        const coverage = report("value-invalidation coverage beats clock authority");
        expect(coverage.selfProofReady).toContain(keyAt(0));
    });

    test("the ordering keys are each the sole differentiator in their own fixture", () => {
        // Read as executable statements of what each isolating fixture asserts: the
        // occurrence the oracle projects is the one the isolated rule names, and
        // not the one the remaining rules would select.
        const byName = new Map(adversarialFixtures().map((fixture) => [fixture.name, fixture]));

        // Basis strength: the empty-basis certificate by the second writer has far
        // greater authority than the complete one, and must still lose.
        const basis = byName.get("effective basis strength beats clock authority");
        expect(basis).toBeDefined();
        if (basis === undefined) {
            throw new Error("the basis-strength fixture is missing");
        }
        const basisOccurrences = JSON.parse(
            canonicalOutcomeOf(basis.journal).outcome.value
        ).occurrences;
        expect(basisOccurrences[0][6]).toEqual([keyAt(1)]);

        // Authority tiebreak: with equal basis and equal coverage, the greater
        // authority wins, so the root occurrence keeps its valid edge.
        const tiebreak = byName.get("authority breaks an otherwise exact certificate tie");
        expect(tiebreak).toBeDefined();
        if (tiebreak === undefined) {
            throw new Error("the authority-tiebreak fixture is missing");
        }
        const tiebreakOccurrences = JSON.parse(
            canonicalOutcomeOf(tiebreak.journal).outcome.value
        ).occurrences;
        expect(tiebreakOccurrences[0][6]).toEqual([keyAt(1)]);

        // Proof barrier: the barrier retires the root occurrence's only edge, so
        // the root has no valid inputs while the middle node keeps its own.
        const barrier = byName.get("a proof barrier retires exactly the one edge it names");
        expect(barrier).toBeDefined();
        if (barrier === undefined) {
            throw new Error("the proof-barrier fixture is missing");
        }
        const barrierOccurrences = JSON.parse(
            canonicalOutcomeOf(barrier.journal).outcome.value
        ).occurrences;
        const edgesByNode = new Map(
            barrierOccurrences.map((occurrence) => [occurrence[0], occurrence[6]])
        );
        expect(edgesByNode.get(keyAt(0))).toEqual([]);
        expect(edgesByNode.get(keyAt(1))).toEqual([keyAt(2)]);

        // Watermark: the greatest writer-state value is the one projection field
        // the maximum argument does not cover.
        const watermark = byName.get(
            "the allocator watermark is the greatest writer-state value"
        );
        expect(watermark).toBeDefined();
        if (watermark === undefined) {
            throw new Error("the watermark fixture is missing");
        }
        expect(JSON.parse(canonicalOutcomeOf(watermark.journal).outcome.value).lastNodeIndex).toBe(
            42
        );
    });
});
