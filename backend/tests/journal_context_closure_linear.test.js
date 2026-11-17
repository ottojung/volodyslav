/**
 * Journal context-closure historical-validation complexity.
 *
 * `$id-6845129073418625` permits Journal-aware migration to validate O(H)
 * retained history, not Θ(H²). The causal-context rules quantify over the
 * semantic events each event observes, so evaluating them by rescanning every
 * event's observed prefix once per event is quadratic. This suite pins:
 *
 * - the pre-fix (per-event rescan) probe count grows superlinearly in H;
 * - the batch `validateCausalContextClosure` probe count is exactly the number
 *   of retained records, i.e. linear in H, for a fixed writer count and fixed
 *   context size; and
 * - the batch decision agrees with the pre-fix per-event decision on valid and
 *   invalid histories, so the linear sweep does not weaken the predicates.
 *
 * The probe count is deterministic: the replica is wrapped so every record read
 * through iteration is counted. The pre-fix path is the module's own
 * `semanticEventsOfReplica` / `semanticEventsUpToSequence` scan, applied once per
 * event exactly as the historical implementation did.
 */

const {
    authorityCompare,
    compareJournalSequence,
    happenedBefore,
    isJournalCausalClosureError,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeValidateEvent,
    makeValueEvent,
    semanticEventsOfReplica,
    semanticEventsUpToSequence,
    validateAuthorityExtension,
    validateCausalContextClosure,
    validateCompleteLocalPrefix,
    validateJournalReplica,
    validateRecordReferences,
    validateRetainedRangeCoverage,
    ZERO_JOURNAL_SEQUENCE,
} = require("../src/generators/incremental_graph/journal");

const {
    buildRecordIndex,
} = require("../src/generators/incremental_graph/journal/replica");

const WRITERS = ["aaaaaaaaa", "bbbbbbbbb"];
const NODE_K = { head: "event", args: [{ id: 1 }] };
const NODE_IDENTIFIER = "1-abcdefghi";
const NOW = "2020-01-01T00:00:00.000Z";

/**
 * @param {string} id
 * @param {Array<[string, string]>} coordinates
 * @param {number} physical
 * @returns {object}
 */
function valueEvent(id, coordinates, physical) {
    const context = makeJournalFrontierFromText(coordinates);
    if (context instanceof Error) {
        throw context;
    }
    const event = makeValueEvent(
        {
            id,
            context,
            authorityTime: makeAuthorityTime(physical, "0"),
            node: NODE_K,
        },
        NODE_IDENTIFIER,
        { type: "entry_description", description: id },
        NOW,
        NOW,
        "compute"
    );
    if (event instanceof Error) {
        throw event;
    }
    return event;
}

/**
 * A deterministic, fully causally ordered history over a fixed writer set.
 *
 * Events are published round-robin, each observing every event published before
 * it. The context of event i is therefore the cut of all earlier events, whose
 * size is bounded by the writer count, and the observed prefix of the last event
 * grows with H. This is the worst case for a per-event rescan: it makes the
 * historical validation quadratic while holding writer count and context size
 * fixed.
 *
 * @param {number} H
 * @returns {Array<[string, Array<object>]>}
 */
function buildChainStreams(H) {
    /** @type {Map<string, Array<object>>} */
    const streams = new Map(WRITERS.map((writer) => [writer, []]));
    /** @type {Map<string, number>} */
    const counts = new Map(WRITERS.map((writer) => [writer, 0]));
    for (let index = 0; index < H; index += 1) {
        const writer = WRITERS[index % WRITERS.length];
        const sequence = (counts.get(writer) ?? 0) + 1;
        /** @type {Array<[string, string]>} */
        const entries = [];
        for (const other of WRITERS) {
            const published = counts.get(other) ?? 0;
            if (published > 0) {
                entries.push([other, String(published)]);
            }
        }
        const event = valueEvent(writer + ":" + String(sequence), entries, 1000 + index);
        const stream = streams.get(writer);
        if (stream === undefined) {
            throw new Error("missing writer stream");
        }
        stream.push(event);
        counts.set(writer, sequence);
    }
    return [...streams.entries()];
}

/**
 * @param {Array<[string, Array<object>]>} streams
 * @returns {object}
 */
function frontierOf(streams) {
    /** @type {Array<[string, string]>} */
    const entries = [];
    for (const [writer, records] of streams) {
        const last = records[records.length - 1];
        if (last !== undefined) {
            entries.push([writer, journalSequenceToString(last.id.sequence)]);
        }
    }
    const frontier = makeJournalFrontierFromText(entries);
    if (frontier instanceof Error) {
        throw frontier;
    }
    return frontier;
}

/**
 * A replica-shaped object which counts every record read through iteration.
 *
 * The production batch validation and the historical per-event scan both read
 * records through `for…of`, so a single counter measures the record-probe work
 * of either path without depending on wall-clock timing.
 *
 * @param {Array<[string, Array<object>]>} streams
 * @returns {{replica: object, probes: () => number, reset: () => void}}
 */
function makeCountingReplica(streams) {
    let probes = 0;
    const entries = streams.map(([writer, records]) => [makeJournalAuthor(writer), records]);
    const counting = (records) =>
        new Proxy(records, {
            get(target, property, receiver) {
                if (property === Symbol.iterator) {
                    return function* iterator() {
                        for (let index = 0; index < target.length; index += 1) {
                            probes += 1;
                            yield target[index];
                        }
                    };
                }
                if (typeof property === "string" && /^[0-9]+$/.test(property)) {
                    probes += 1;
                }
                return Reflect.get(target, property, receiver);
            },
        });
    const replica = {
        *[Symbol.iterator]() {
            for (const [author, records] of entries) {
                yield [author, counting(records)];
            }
        },
        get(author) {
            for (const [candidate, records] of entries) {
                if (journalAuthorToString(candidate) === journalAuthorToString(author)) {
                    return counting(records);
                }
            }
            return undefined;
        },
        has(author) {
            return replica.get(author) !== undefined;
        },
    };
    return {
        replica,
        probes: () => probes,
        reset: () => {
            probes = 0;
        },
    };
}

/**
 * The historical per-event transitive-closure scan, verbatim.
 * @param {object} event
 * @param {object} replica
 * @returns {string | undefined}
 */
function historicalClosure(event, replica) {
    for (const coordinate of event.context) {
        const author = coordinate[0];
        const sequence = coordinate[1];
        if (compareJournalSequence(sequence, ZERO_JOURNAL_SEQUENCE) === 0) {
            continue;
        }
        for (const observed of semanticEventsUpToSequence(replica, author, sequence)) {
            for (const own of observed.context) {
                if (
                    compareJournalSequence(
                        own[1],
                        journalSequenceAtFrontier(event.context, own[0])
                    ) > 0
                ) {
                    return "transitive closure";
                }
            }
        }
    }
    return undefined;
}

/**
 * The historical per-event authority scan, verbatim.
 * @param {object} event
 * @param {object} replica
 * @returns {string | undefined}
 */
function historicalAuthority(event, replica) {
    const label = journalRecordIdToString(event.id);
    for (const observed of semanticEventsOfReplica(replica)) {
        if (journalRecordIdToString(observed.id) === label) {
            continue;
        }
        if (!happenedBefore(observed, event)) {
            continue;
        }
        if (authorityCompare(observed, event) >= 0) {
            return "authority consistency";
        }
    }
    return undefined;
}

/**
 * The pre-fix batch decision, transcribed from the historical implementation.
 * The retained-range and complete-local-prefix checks are shared with the
 * production path; the two relational scans are the historical ones.
 * @param {object} replica
 * @param {object} retainedFrontier
 * @returns {string | undefined}
 */
function historicalValidate(replica, retainedFrontier) {
    for (const event of semanticEventsOfReplica(replica)) {
        const retained = validateRetainedRangeCoverage(event, retainedFrontier);
        if (retained !== undefined) {
            return retained.rule;
        }
        const local = validateCompleteLocalPrefix(event);
        if (local !== undefined) {
            return local.rule;
        }
        const closure = historicalClosure(event, replica);
        if (closure !== undefined) {
            return closure;
        }
        const authority = historicalAuthority(event, replica);
        if (authority !== undefined) {
            return authority;
        }
    }
    return undefined;
}

/**
 * Rebuild the last published event of a chain with one mutated field.
 * @param {number} H
 * @param {(event: object) => object} mutate
 * @returns {Array<[string, Array<object>]>}
 */
function withLastEventMutated(H, mutate) {
    const streams = buildChainStreams(H);
    const lastWriter = WRITERS[(H - 1) % WRITERS.length];
    const stream = streams.find(([writer]) => writer === lastWriter);
    if (stream === undefined) {
        throw new Error("missing last writer");
    }
    const records = stream[1];
    const last = records[records.length - 1];
    records[records.length - 1] = mutate(last);
    return streams;
}

/**
 * Rebuild one value event with a replacement context and authority time.
 * @param {object} event
 * @param {Array<[string, string]>} coordinates
 * @param {number} physical
 * @returns {object}
 */
function rebuildValueEvent(event, coordinates, physical) {
    const context = makeJournalFrontierFromText(coordinates);
    if (context instanceof Error) {
        throw context;
    }
    const rebuilt = makeValueEvent(
        {
            id: journalRecordIdToString(event.id),
            context,
            authorityTime: makeAuthorityTime(physical, "0"),
            node: event.node,
        },
        event.nodeIdentifier,
        event.payload,
        event.createdAt,
        event.modifiedAt,
        event.reason
    );
    if (rebuilt instanceof Error) {
        throw rebuilt;
    }
    return rebuilt;
}

/**
 * @param {object} event
 * @returns {Array<[string, string]>}
 */
function coordinatesOf(event) {
    /** @type {Array<[string, string]>} */
    const coordinates = [];
    for (const [author, sequence] of event.context) {
        coordinates.push([journalAuthorToString(author), journalSequenceToString(sequence)]);
    }
    return coordinates;
}

describe("context-closure historical validation is linear in H", () => {
    const sizes = [40, 80, 160, 320];

    test("the historical per-event rescan grows superlinearly in H", () => {
        const counts = sizes.map((H) => {
            const streams = buildChainStreams(H);
            const frontier = frontierOf(streams);
            const counting = makeCountingReplica(streams);
            const start = counting.probes();
            const failure = historicalValidate(counting.replica, frontier);
            expect(failure).toBeUndefined();
            return counting.probes() - start;
        });
        for (let index = 1; index < counts.length; index += 1) {
            const ratio = counts[index] / counts[index - 1];
            expect(ratio).toBeGreaterThan(3);
        }
    });

    test("the batch validation probes exactly one record per retained record", () => {
        const counts = sizes.map((H) => {
            const streams = buildChainStreams(H);
            const frontier = frontierOf(streams);
            const counting = makeCountingReplica(streams);
            const failure = validateCausalContextClosure(counting.replica, frontier);
            expect(failure).toBeUndefined();
            return counting.probes();
        });
        expect(counts).toEqual(sizes);
    });

    test("the batch validation is dramatically cheaper than the historical rescan at scale", () => {
        const H = 320;
        const streams = buildChainStreams(H);
        const frontier = frontierOf(streams);
        const counting = makeCountingReplica(streams);

        counting.reset();
        const historical = historicalValidate(counting.replica, frontier);
        const historicalProbes = counting.probes();

        counting.reset();
        const linear = validateCausalContextClosure(counting.replica, frontier);
        const linearProbes = counting.probes();

        expect(historical).toBeUndefined();
        expect(linear).toBeUndefined();
        expect(linearProbes).toBe(H);
        expect(historicalProbes).toBeGreaterThan(linearProbes * 100);
    });

    test("a valid chain replica is accepted by whole-history validation", () => {
        const streams = buildChainStreams(200);
        const replica = makeJournalReplica(
            streams.map(([writer, records]) => [makeJournalAuthor(writer), records])
        );
        expect(validateJournalReplica(replica)).toBeUndefined();
    });
});

describe("linear sweep preserves the causal-closure decision", () => {
    test("a context which omits a transitively observed coordinate is rejected", () => {
        const a1 = valueEvent("aaaaaaaaa:1", [], 1000);
        const b1 = valueEvent("bbbbbbbbb:1", [["aaaaaaaaa", "1"]], 2000);
        const c1 = valueEvent("ccccccccc:1", [["bbbbbbbbb", "1"]], 3000);
        const replica = makeJournalReplica([
            [makeJournalAuthor("aaaaaaaaa"), [a1]],
            [makeJournalAuthor("bbbbbbbbb"), [b1]],
            [makeJournalAuthor("ccccccccc"), [c1]],
        ]);
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("transitive closure");
    });

    test("an authority that does not extend an observed predecessor is rejected", () => {
        const a1 = valueEvent("aaaaaaaaa:1", [], 5000);
        const a2 = valueEvent("aaaaaaaaa:2", [["aaaaaaaaa", "1"]], 1000);
        const replica = makeJournalReplica([[makeJournalAuthor("aaaaaaaaa"), [a1, a2]]]);
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("authority consistency");
    });

    test("an equal authority time is broken by writer identity, not ignored", () => {
        const b1 = valueEvent("bbbbbbbbb:1", [], 1000);
        const a1 = valueEvent("aaaaaaaaa:1", [["bbbbbbbbb", "1"]], 1000);
        const replica = makeJournalReplica([
            [makeJournalAuthor("bbbbbbbbb"), [b1]],
            [makeJournalAuthor("aaaaaaaaa"), [a1]],
        ]);
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("authority consistency");
    });

    test("per-event authority ignores a widened own coordinate exactly as the historical scan did", () => {
        const a1 = valueEvent("aaaaaaaaa:1", [], 1000);
        const a2 = valueEvent("aaaaaaaaa:2", [["aaaaaaaaa", "1"]], 2000);
        const widened = valueEvent("aaaaaaaaa:3", [["aaaaaaaaa", "3"]], 3000);
        const replica = makeJournalReplica([
            [makeJournalAuthor("aaaaaaaaa"), [a1, a2, widened]],
        ]);
        expect(historicalAuthority(widened, replica)).toBeUndefined();
        expect(validateAuthorityExtension(widened, replica)).toBeUndefined();
    });

    test("the batch decision agrees with the historical per-event decision", () => {
        const histories = [
            buildChainStreams(1),
            buildChainStreams(2),
            buildChainStreams(7),
            buildChainStreams(31),
            withLastEventMutated(40, (event) => {
                const coordinates = coordinatesOf(event);
                coordinates.shift();
                return rebuildValueEvent(event, coordinates, event.authorityTime.physical);
            }),
            withLastEventMutated(40, (event) =>
                rebuildValueEvent(event, coordinatesOf(event), 0)
            ),
        ];
        for (const streams of histories) {
            const frontier = frontierOf(streams);
            const counting = makeCountingReplica(streams);
            const historical = historicalValidate(counting.replica, frontier);
            const linear = validateCausalContextClosure(counting.replica, frontier);
            expect(linear === undefined ? undefined : linear.rule).toBe(historical);
        }
    });

    test("an authority regression injected into a long history is rejected", () => {
        const streams = withLastEventMutated(300, (event) =>
            rebuildValueEvent(event, coordinatesOf(event), 0)
        );
        const replica = makeJournalReplica(
            streams.map(([writer, records]) => [makeJournalAuthor(writer), records])
        );
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("authority consistency");
    });

    test("a transitive-closure omission injected into a long history is rejected", () => {
        const streams = withLastEventMutated(300, (event) => {
            const coordinates = coordinatesOf(event);
            coordinates.shift();
            return rebuildValueEvent(event, coordinates, event.authorityTime.physical);
        });
        const replica = makeJournalReplica(
            streams.map(([writer, records]) => [makeJournalAuthor(writer), records])
        );
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("transitive closure");
    });
});

/**
 * A single-writer history alternating a value occurrence and a validation of the
 * previous occurrence. Each validation names one earlier coordinate, so the
 * cross-record reference pass resolves one coordinate per validation.
 * @param {number} H
 * @returns {Array<object>}
 */
function buildReferenceChain(H) {
    const records = [];
    let lastValue;
    for (let index = 0; index < H; index += 1) {
        const sequence = index + 1;
        const id = "aaaaaaaaa:" + String(sequence);
        const coordinates = sequence > 1 ? [["aaaaaaaaa", String(sequence - 1)]] : [];
        if (index % 2 === 0) {
            const event = valueEvent(id, coordinates, 1000 + index);
            lastValue = id;
            records.push(event);
        } else {
            const context = makeJournalFrontierFromText(coordinates);
            if (context instanceof Error) {
                throw context;
            }
            const event = makeValidateEvent(
                {
                    id,
                    context,
                    authorityTime: makeAuthorityTime(1000 + index, "0"),
                    node: NODE_K,
                },
                lastValue,
                [],
                "compute"
            );
            if (event instanceof Error) {
                throw event;
            }
            records.push(event);
        }
    }
    return records;
}

describe("cross-record reference resolution is linear in H", () => {
    const sizes = [40, 80, 160, 320];

    test("the historical per-reference stream scan grows superlinearly in H", () => {
        const counts = sizes.map((H) => {
            const records = buildReferenceChain(H);
            const counting = makeCountingReplica([["aaaaaaaaa", records]]);
            const start = counting.probes();
            for (const record of records) {
                expect(validateRecordReferences(record, counting.replica)).toBeUndefined();
            }
            return counting.probes() - start;
        });
        for (let index = 1; index < counts.length; index += 1) {
            expect(counts[index] / counts[index - 1]).toBeGreaterThan(3);
        }
    });

    test("the indexed reference pass probes exactly the records it indexes", () => {
        const counts = sizes.map((H) => {
            const records = buildReferenceChain(H);
            const counting = makeCountingReplica([["aaaaaaaaa", records]]);
            const start = counting.probes();
            const index = buildRecordIndex(counting.replica);
            for (const record of records) {
                expect(validateRecordReferences(record, counting.replica, index)).toBeUndefined();
            }
            return counting.probes() - start;
        });
        expect(counts).toEqual(sizes);
    });

    test("a reference to an unobserved occurrence is still rejected", () => {
        const a1 = valueEvent("aaaaaaaaa:1", [], 1000);
        const b1 = valueEvent("bbbbbbbbb:1", [], 1000);
        const scoped = makeValidateEvent(
            {
                id: "bbbbbbbbb:2",
                context: makeJournalFrontierFromText([["bbbbbbbbb", "1"]]),
                authorityTime: makeAuthorityTime(2000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:1",
            [],
            "compute"
        );
        const replica = makeJournalReplica([
            [makeJournalAuthor("aaaaaaaaa"), [a1]],
            [makeJournalAuthor("bbbbbbbbb"), [b1, scoped]],
        ]);
        const failure = validateJournalReplica(replica);
        expect(failure).toBeDefined();
    });
});
