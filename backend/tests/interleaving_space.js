/**
 * The interleaving space the Journal record layer and the `project` oracle admit,
 * enumerated exhaustively rather than sampled.
 *
 * `incremental-graph-journal-theorems.md` Law 1 requires one unique semantic
 * result for `project(J)` "independent of arrival order, wall time, randomness,
 * transport ancestry, computor execution, or mutable graph bytes". Law 2 is the
 * graph/Journal equality this issue's real predicate restates. Neither law can be
 * discharged by replaying sixteen seeds, so this module builds the space the laws
 * actually range over and lets a caller walk all of it.
 *
 * ## What the space is, precisely
 *
 * A retained journal is a set of per-writer streams, and a writer's stream is
 * immutable in its own coordinate order. So the freedom in a retained journal is
 * not "any order of any records" — it is two things, and they are different:
 *
 * 1. **Which operations happened, and in what order within each writer.** A
 *    writer's own stream order is total and immutable, so this is a choice of one
 *    sequence of operations per writer.
 * 2. **How those per-writer operations interleaved in real time.** Two operations
 *    by different writers which neither observed the other are concurrent, and the
 *    interleaving decides what each one's `context` cut contains and what
 *    `authorityTime` it was allocated. This is the genuine interleaving degree of
 *    freedom, and it is a linear-extension choice over the two writer chains.
 *
 * On top of those, the *presentation* of one fixed journal to the oracle is a
 * further, separate freedom: `JournalSource.writers()` order, the union
 * decomposition of a writer's stream into contributors, contributor order, and the
 * reader's chunk size. Law 1 says the result must not depend on any of it.
 *
 * This module enumerates (1) x (2) as `enumerateJournals`, and enumerates the
 * presentation freedom of a fixed journal as `presentationsOf`. They are kept
 * apart deliberately: conflating them would let a presentation bug hide inside a
 * history bug.
 *
 * Every context a generated record carries is the *exact complete observed
 * prefix*, which is what makes the result a supported journal rather than an
 * arbitrary one. Nothing here samples: `enumerateJournals` returns every member of
 * a stated finite space, and `presentationsOf` returns every member of a stated
 * finite presentation space.
 */

const {
    isValueEvent,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    journalSequenceToString,
    compareJournalSequence,
    makeAuthorityTime,
    makeDeleteEvent,
    makeInvalidateEvent,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeNodeScope,
    makeProofScope,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    makeValueScope,
    makeWriterStateRecord,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const { readerOverIterable } = require("../src/generators/incremental_graph/journal/oracle");

/** @typedef {import("../src/generators/incremental_graph/journal").AnyJournalError} JournalError */
/** @typedef {import("../src/generators/incremental_graph/journal").JournalRecord} JournalRecord */
/** @typedef {import("../src/generators/incremental_graph/journal").JournalReplica} JournalReplica */
/** @typedef {import("../src/generators/incremental_graph/journal").NodeKey} NodeKey */
/** @typedef {import("../src/generators/incremental_graph/journal/oracle").JournalSource} JournalSource */

/**
 * The three semantic nodes the space ranges over, and the current schema over
 * them. Node 1 reads node 2, node 2 reads node 3, node 3 reads nothing, so the
 * space contains a causal chain, a fan-in, and a leaf with an empty basis.
 */
const NODE_1 = { head: "event", args: [{ id: 1 }] };
const NODE_2 = { head: "event", args: [{ id: 2 }] };
const NODE_3 = { head: "event", args: [{ id: 3 }] };
const NODES = [NODE_1, NODE_2, NODE_3];
const KEY_1 = nodeKeyToCanonicalString(NODE_1);
const KEY_2 = nodeKeyToCanonicalString(NODE_2);
const KEY_3 = nodeKeyToCanonicalString(NODE_3);
const KEYS = [KEY_1, KEY_2, KEY_3];

/**
 * The current schema's direct inputs, as a `CurrentInputKeysOfNode`. A node
 * outside the current schema has no entry, which is the case
 * `incremental-graph-journal-replay.md` treats as history rather than as an
 * unsatisfiable certificate.
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function schemaOf(nodeKeyString) {
    if (nodeKeyString === KEY_1) {
        return [KEY_2];
    }
    if (nodeKeyString === KEY_2) {
        return [KEY_3];
    }
    return [];
}

/**
 * One distinct physical identifier per node, so a generated journal never
 * presents two live nodes under one identifier. That condition is unsupported
 * current state with its own rule and its own test, and it has no business being
 * smuggled in through a generator.
 * @param {string} nodeKeyString
 * @returns {string}
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
}

const CREATED_AT = "2020-01-01T00:00:00.000Z";
const MODIFIED_AT = "2020-01-02T00:00:00.000Z";

/**
 * The one operation alphabet the space ranges over. Each entry is a function
 * which authors one record from the shared generation state, or `undefined` when
 * the operation has no legal referent at that point in the interleaving.
 *
 * The alphabet is deliberately heterogeneous: it contains a head-candidate pair
 * (value and delete on the same node), the three invalidation scopes, a
 * certificate with a partial basis, and a writer-state record, so a counterexample
 * in any of `project`'s passes is reachable rather than being masked by an
 * alphabet that only ever produces one kind of record.
 *
 * @typedef {object} GenerationState
 * @property {string} writerName
 * @property {number} sequence - The coordinate this operation will occupy.
 * @property {import("../src/generators/incremental_graph/journal").JournalFrontier} observed - The exact complete retained cut this operation observed.
 * @property {number} physical - The authority physical time to allocate.
 * @property {number} logical - The authority logical counter to allocate.
 * @property {ReadonlyMap<string, ReadonlyArray<import("../src/generators/incremental_graph/journal").ValueEvent>>} valueHistory
 */

/**
 * The operation alphabet. Each operation is `state => record | undefined`.
 * @type {ReadonlyArray<{name: string, author: (state: GenerationState) => JournalRecord | undefined}>}
 */
const OPERATIONS = [
    {
        name: "value",
        author: (state) =>
            makeValueEvent(
                {
                    id: state.writerName + ":" + String(state.sequence),
                    context: state.observed,
                    authorityTime: makeAuthorityTime(state.physical, String(state.logical)),
                    node: nodeFor(state, 0),
                },
                identifierOf(nodeKeyToCanonicalString(nodeFor(state, 0))),
                {
                    type: "entry_description",
                    description: "v" + String(state.writerName) + String(state.sequence),
                },
                CREATED_AT,
                MODIFIED_AT,
                "compute"
            ),
    },
    {
        name: "delete",
        author: (state) =>
            makeDeleteEvent(
                {
                    id: state.writerName + ":" + String(state.sequence),
                    context: state.observed,
                    authorityTime: makeAuthorityTime(state.physical, String(state.logical)),
                    node: nodeFor(state, 1),
                },
                "operation"
            ),
    },
    {
        name: "nodeScope",
        author: (state) =>
            makeInvalidateEvent(
                baseOf(state, nodeFor(state, 2)),
                makeNodeScope(),
                "explicit"
            ),
    },
    {
        name: "valueScope",
        author: (state) => {
            const target = latestObservedValue(state);
            if (target === undefined) {
                return undefined;
            }
            return makeInvalidateEvent(
                baseOf(state, nodeFor(state, 0)),
                makeValueScope(journalRecordIdToString(target.id)),
                "propagated"
            );
        },
    },
    {
        name: "proofScope",
        author: (state) => {
            const target = latestObservedValue(state);
            if (target === undefined) {
                return undefined;
            }
            const inputKeyString = firstInputOf(nodeFor(state, 1));
            if (inputKeyString === undefined) {
                return undefined;
            }
            return makeInvalidateEvent(
                baseOf(state, nodeFor(state, 1)),
                makeProofScope(journalRecordIdToString(target.id), JSON.parse(inputKeyString)),
                "reset"
            );
        },
    },
    {
        name: "partialBasis",
        author: (state) => {
            const nodeKey = nodeFor(state, 2);
            const target = observedValueOf(state, nodeKeyToCanonicalString(nodeKey));
            if (target === undefined) {
                return undefined;
            }
            const inputKeyString = firstInputOf(nodeKey);
            if (inputKeyString === undefined) {
                return undefined;
            }
            const input = observedValueOf(state, inputKeyString);
            if (input === undefined) {
                return undefined;
            }
            return makeValidateEvent(
                baseOf(state, nodeKey),
                target.id,
                [makeValidationBasisEntry(JSON.parse(inputKeyString), input.id)],
                "compute"
            );
        },
    },
    {
        name: "fullBasis",
        author: (state) => {
            const nodeKey = nodeFor(state, 1);
            const target = observedValueOf(state, nodeKeyToCanonicalString(nodeKey));
            if (target === undefined) {
                return undefined;
            }
            /** @type {Array<import("../src/generators/incremental_graph/journal").ValidationBasisEntry>} */
            const basis = [];
            for (const inputKeyString of schemaOf(nodeKeyToCanonicalString(nodeKey))) {
                const input = observedValueOf(state, inputKeyString);
                if (input === undefined) {
                    return undefined;
                }
                basis.push(makeValidationBasisEntry(JSON.parse(inputKeyString), input.id));
            }
            return makeValidateEvent(baseOf(state, nodeKey), target.id, basis, "compute");
        },
    },
    {
        name: "writerState",
        author: (state) => makeWriterStateRecord(
            state.writerName + ":" + String(state.sequence),
            state.sequence
        ),
    },
];

/**
 * The node an operation deterministically selects, as a function of its own
 * coordinate and an offset. The offset is what makes different operations in the
 * alphabet act on different nodes at the same coordinate, so a certificate and the
 * value it targets are not always the same node by construction.
 * @param {GenerationState} state
 * @param {number} offset
 * @returns {NodeKey}
 */
function nodeFor(state, offset) {
    const index = Math.min(NODES.length - 1, (state.sequence + offset) % NODES.length);
    const node = NODES[index];
    if (node === undefined) {
        throw new Error("the interleaving alphabet selected a node which does not exist");
    }
    return node;
}

/**
 * The single current direct input of a node, when it has exactly one.
 * @param {NodeKey} nodeKey
 * @returns {string | undefined}
 */
function firstInputOf(nodeKey) {
    const inputs = schemaOf(nodeKeyToCanonicalString(nodeKey));
    return inputs.length === 1 ? inputs[0] : undefined;
}

/**
 * The shared body of a semantic event about one node.
 * @param {GenerationState} state
 * @param {NodeKey} node
 * @returns {{id: string, context: import("../src/generators/incremental_graph/journal").JournalFrontier, authorityTime: import("../src/generators/incremental_graph/journal").AuthorityTime, node: NodeKey}}
 */
function baseOf(state, node) {
    return {
        id: state.writerName + ":" + String(state.sequence),
        context: state.observed,
        authorityTime: makeAuthorityTime(state.physical, String(state.logical)),
        node,
    };
}

/**
 * The most recent value occurrence of any node the observed cut already contains.
 *
 * A reference-legal operation needs a target which is already retained and
 * observed, so it reads the cut rather than choosing a node and hoping. This is
 * what makes the reference-bearing operations reachable at all in a short
 * interleaving: without it the alphabet degenerates to records which name no
 * occurrence, and the certificate and invalidation-scope passes are never entered.
 * @param {GenerationState} state
 * @returns {import("../src/generators/incremental_graph/journal").ValueEvent | undefined}
 */
function latestObservedValue(state) {
    let latest;
    let latestKey = -1;
    for (const nodeKeyString of state.valueHistory.keys()) {
        const candidate = observedValueOf(state, nodeKeyString);
        if (candidate === undefined) {
            continue;
        }
        const index = KEYS.indexOf(nodeKeyString);
        if (index > latestKey) {
            latestKey = index;
            latest = candidate;
        }
    }
    return latest;
}

/**
 * The most recent retained value occurrence of a node which the observed cut
 * already contains, so a reference this operation authors is one the record layer
 * accepts.
 * @param {GenerationState} state
 * @param {string} nodeKeyString
 * @returns {import("../src/generators/incremental_graph/journal").ValueEvent | undefined}
 */
function observedValueOf(state, nodeKeyString) {
    const history = state.valueHistory.get(nodeKeyString);
    if (history === undefined) {
        return undefined;
    }
    let latest;
    for (const candidate of history) {
        const coordinate = journalSequenceAtFrontier(state.observed, candidate.id.author);
        if (compareJournalSequence(candidate.id.sequence, coordinate) <= 0) {
            latest = candidate;
        }
    }
    return latest;
}

/**
 * Every ordering of a set of labelled items.
 * @param {ReadonlyArray<string>} items
 * @returns {Array<Array<string>>}
 */
function permutationsOf(items) {
    if (items.length <= 1) {
        return [items.slice()];
    }
    /** @type {Array<Array<string>>} */
    const ordered = [];
    for (let index = 0; index < items.length; index++) {
        const head = items[index];
        if (head === undefined) {
            continue;
        }
        const rest = [...items.slice(0, index), ...items.slice(index + 1)];
        for (const tail of permutationsOf(rest)) {
            ordered.push([head, ...tail]);
        }
    }
    return ordered;
}

/**
 * Every way to split a stream of `length` records into an ordered list of
 * contiguous runs, each run a *prefix* contributor, in every contributor order.
 *
 * A contributor of a supported prefix union is itself a retained prefix of the
 * same writer, so it is `A:1 .. A:k` for some `k`. A run which starts above `1` is
 * not a retained prefix and the reader rejects it as a gap, which is correct and is
 * a different question from this one.
 * @param {number} length
 * @returns {Array<Array<number>>} Every ordered list of prefix lengths, including the empty contributor list.
 */
function prefixDecompositionsOf(length) {
    /** @type {Array<Array<number>>} */
    const found = [];
    /**
     * @param {number} next
     * @param {Array<number>} accumulated
     */
    function extend(next, accumulated) {
        if (next > length) {
            found.push(accumulated.slice());
            return;
        }
        for (let end = next; end <= length; end++) {
            accumulated.push(end);
            extend(end + 1, accumulated);
            accumulated.pop();
        }
    }
    extend(1, []);
    /** @type {Array<Array<number>>} */
    const withOrders = [];
    for (const decomposition of found) {
        for (const ordered of permutationsOf(decomposition.map((k) => String(k)))) {
            withOrders.push(ordered.map((k) => Number(k)));
        }
    }
    return withOrders;
}

/**
 * One generated journal: a per-writer choice of operations and the interleaving
 * which produced their contexts.
 * @typedef {object} GeneratedJournal
 * @property {Record<string, JournalRecord[]>} streams - Each writer's retained records in writer-stream order.
 * @property {string[]} interleaving - The writer names in the order the operations were authored, which is what fixed each context.
 * @property {string[]} operations - The operation names in that same order.
 */

/**
 * Build the journal one interleaving of one per-writer operation choice produces.
 * @param {Record<string, ReadonlyArray<string>>} operationsByWriter
 * @param {ReadonlyArray<string>} interleaving
 * @returns {GeneratedJournal | undefined} `undefined` when the interleaving is not a linear extension of the per-writer sequences.
 */
function buildJournal(operationsByWriter, interleaving) {
    /** @type {Map<string, number>} */
    const nextSequence = new Map();
    for (const writerName of Object.keys(operationsByWriter)) {
        nextSequence.set(writerName, 0);
    }
    /** @type {Record<string, JournalRecord[]>} */
    const streams = {};
    for (const writerName of Object.keys(operationsByWriter)) {
        streams[writerName] = [];
    }
    /** @type {Map<string, Array<import("../src/generators/incremental_graph/journal").ValueEvent>>} */
    const valueHistory = new Map();
    let physical = 1000;
    let logical = 0;
    const used = new Map();

    for (const writerName of interleaving) {
        const available = used.get(writerName) ?? 0;
        const perWriter = operationsByWriter[writerName] ?? [];
        if (available >= perWriter.length) {
            return undefined;
        }
        const operationName = perWriter[available];
        if (operationName === undefined) {
            return undefined;
        }
        const sequence = (nextSequence.get(writerName) ?? 0) + 1;

        // The observed cut is every other record already authored, which for the
        // writing writer itself is exactly the predecessor coordinate. The
        // writing record is not yet part of the cut, so `used` is advanced after
        // the cut is read.
        /**
         * @type {Array<Array<string>>}
         */
        const coordinates = [];
        for (const name of Object.keys(operationsByWriter)) {
            const taken = used.get(name) ?? 0;
            if (taken > 0) {
                coordinates.push([name, String(taken)]);
            }
        }
        used.set(writerName, available + 1);
        physical += 3;
        logical += 1;
        /** @type {GenerationState} */
        const state = {
            writerName,
            sequence,
            observed: makeJournalFrontierFromText(coordinates),
            physical,
            logical,
            valueHistory,
        };
        const operation = OPERATIONS.find((candidate) => candidate.name === operationName);
        if (operation === undefined) {
            return undefined;
        }
        const record = operation.author(state);
        if (record === undefined || record instanceof Error) {
            return undefined;
        }
        nextSequence.set(writerName, sequence);
        streams[writerName]?.push(record);
        if (isValueEvent(record)) {
            const history = valueHistory.get(nodeKeyToCanonicalString(record.node)) ?? [];
            history.push(record);
            valueHistory.set(nodeKeyToCanonicalString(record.node), history);
        }
    }
    return { streams, interleaving: interleaving.slice(), operations: [] };
}

/**
 * Every journal in a stated finite space, and the exact size of that space.
 *
 * The space is: two writers `A` and `B`, each choosing a sequence of one or two
 * operations from `OPERATIONS`, and every linear extension of the two resulting
 * writer chains. A linear extension is exactly a legal interleaving of two
 * concurrent writers, so this is the interleaving space and not a subset of it.
 *
 * The bound is a function of the alphabet size and the per-writer length, and
 * `enumerateJournals` reports it rather than leaving the caller to assume it.
 * @param {{writerNames?: ReadonlyArray<string>, lengths?: ReadonlyArray<number>}} [options]
 * @returns {{journals: GeneratedJournal[], bound: number, writers: string[], alphabet: string[]}}
 */
function enumerateJournals(options) {
    const writerNames = options?.writerNames ?? ["aaaaaaaaa", "bbbbbbbbb"];
    const lengths = options?.lengths ?? [1, 2];
    const alphabet = OPERATIONS.map((operation) => operation.name);
    /** @type {GeneratedJournal[]} */
    const journals = [];

    /**
     * Every assignment of an operation to every writer coordinate, which for
     * `lengths` of length W is `alphabet^sum(lengths)` assignments, filtered to
     * the assignments whose operations all have a legal referent at their
     * coordinate.
     * @returns {Array<Array<string>>}
     */
    function everyOperationAssignment() {
        const total = lengths.reduce((sum, length) => sum + length, 0);
        /** @type {Array<Array<string>>} */
        const assignments = [];
        const current = new Array(total).fill("");
        /**
         * @param {number} position
         * @returns {void}
         */
        function fill(position) {
            if (position === total) {
                assignments.push(current.slice());
                return;
            }
            for (const operation of alphabet) {
                current[position] = operation;
                fill(position + 1);
            }
        }
        fill(0);
        return assignments;
    }

    /**
     * Split one flat operation assignment into the per-writer sequences the
     * interleaving enumerator consumes.
     * @param {ReadonlyArray<string>} assignment
     * @returns {Record<string, ReadonlyArray<string>>}
     */
    function byWriter(assignment) {
        /** @type {Record<string, ReadonlyArray<string>>} */
        const chosen = {};
        let position = 0;
        writerNames.forEach((name, index) => {
            const length = lengths[index] ?? 0;
            chosen[name] = assignment.slice(position, position + length);
            position += length;
        });
        return chosen;
    }

    /**
     * @param {ReadonlyArray<string>} assignment
     * @returns {void}
     */
    function emitJournals(assignment) {
        const chosen = byWriter(assignment);
        const total = assignment.length;
        for (const interleaving of interleavingsOf(writerNames, chosen, total)) {
            const built = buildJournal(chosen, interleaving);
            if (built === undefined) {
                continue;
            }
            const consumed = new Map();
            built.operations = interleaving.map((writerName) => {
                const taken = consumed.get(writerName) ?? 0;
                consumed.set(writerName, taken + 1);
                return chosen[writerName]?.[taken] ?? "";
            });
            journals.push(built);
        }
    }

    for (const assignment of everyOperationAssignment()) {
        emitJournals(assignment);
    }
    return { journals, bound: journals.length, writers: writerNames, alphabet };
}

/**
 * Every interleaving of the per-writer operation sequences, preserving each
 * writer's own order.
 * @param {ReadonlyArray<string>} writerNames
 * @param {Record<string, ReadonlyArray<string>>} chosen
 * @param {number} total
 * @returns {Array<Array<string>>}
 */
function interleavingsOf(writerNames, chosen, total) {
    /** @type {Array<Array<string>>} */
    const found = [];
    /** @type {Map<string, number>} */
    const used = new Map();
    /**
     * @param {Array<string>} accumulated
     * @returns {void}
     */
    function extend(accumulated) {
        if (accumulated.length === total) {
            found.push(accumulated.slice());
            return;
        }
        for (const name of writerNames) {
            const taken = used.get(name) ?? 0;
            if (taken >= (chosen[name]?.length ?? 0)) {
                continue;
            }
            used.set(name, taken + 1);
            accumulated.push(name);
            extend(accumulated);
            accumulated.pop();
            used.set(name, taken);
        }
    }
    extend([]);
    return found;
}

/**
 * Every presentation of one fixed journal through the `JournalSource` interface.
 *
 * A presentation varies four things the interface admits and the specification
 * requires the result to be independent of:
 *
 * - the order `writers()` enumerates the writers in;
 * - how each writer's stream is decomposed into prefix contributors;
 * - the order those contributors are supplied to the union;
 * - how many records the reader buffers per step, which is the chunk-size freedom
 *   `incremental-graph-journal-testing.md` §Streaming correctness asks about.
 *
 * The last one is exercised through a reader which hands out `undefined` while its
 * buffer is empty, which is what a chunked iterator over a real sublevel does.
 * @param {GeneratedJournal} journal
 * @param {{chunkSizes?: ReadonlyArray<number>}} [options]
 * @returns {Array<{label: string, source: JournalSource}>}
 */
function presentationsOf(journal, options) {
    const chunkSizes = options?.chunkSizes ?? [1, 2, 3, Number.MAX_SAFE_INTEGER];
    const writerNames = Object.keys(journal.streams).filter(
        (name) => (journal.streams[name] ?? []).length > 0
    );
    /** @type {Array<{label: string, source: JournalSource}>} */
    const presentations = [];

    for (const order of permutationsOf(writerNames)) {
        for (const chunkSize of chunkSizes) {
            presentations.push({
                label: "order=" + order.join(",") + " chunk=" + String(chunkSize),
                source: directSource(journal, order, chunkSize),
            });
        }
        for (const perWriter of prefixUnionShapes(journal, order)) {
            presentations.push({
                label: "order=" + order.join(",") + " union=" + describeDecomposition(perWriter),
                source: unionSource(journal, order, perWriter, 1),
            });
        }
    }
    return presentations;
}

/**
 * Every way to split each writer's own stream into an ordered list of prefix
 * contributors, taken independently per writer and combined across writers.
 *
 * The per-writer choice is independent because a contributor of one writer is
 * never compared against a contributor of another: the union merges per writer.
 * Taking the product therefore enumerates the union presentation space rather than
 * a correlated subset of it.
 * @param {GeneratedJournal} journal
 * @param {ReadonlyArray<string>} order
 * @returns {Array<Map<string, Array<number>>>}
 */
function prefixUnionShapes(journal, order) {
    /**
     * @param {number} index
     * @param {Map<string, Array<number>>} accumulated
     * @param {Array<Map<string, Array<number>>>} found
     * @returns {void}
     */
    function extend(index, accumulated, found) {
        if (index === order.length) {
            found.push(new Map(accumulated));
            return;
        }
        const name = order[index];
        if (name === undefined) {
            return;
        }
        for (const decomposition of prefixDecompositionsOf(
            (journal.streams[name] ?? []).length
        )) {
            accumulated.set(name, decomposition);
            extend(index + 1, accumulated, found);
        }
        accumulated.delete(name);
    }
    /** @type {Array<Map<string, Array<number>>>} */
    const found = [];
    extend(0, new Map(), found);
    return found;
}

/**
 * @param {Map<string, Array<number>>} perWriter
 * @returns {string}
 */
function describeDecomposition(perWriter) {
    return [...perWriter.entries()]
        .map((entry) => entry[0] + ":" + entry[1].join("+"))
        .join("/");
}

/**
 * A source which hands each writer's whole retained stream over in one pass, in
 * the given writer order, buffering `chunkSize` records at a time.
 * @param {GeneratedJournal} journal
 * @param {ReadonlyArray<string>} order
 * @param {number} chunkSize
 * @returns {JournalSource}
 */
function directSource(journal, order, chunkSize) {
    /**
     * @param {string} writerName
     * @returns {JournalSource}
     */
    function one(writerName) {
        const records = journal.streams[writerName] ?? [];
        return {
            writers: () => [makeJournalAuthorFromName(writerName)],
            retainedLengthOf: () => retainedLengthOf(records),
            prefixReaderOf: () => chunkedReader(writerName, records, chunkSize),
        };
    }
    const byWriter = new Map(order.map((name) => [name, one(name)]));
    return {
        writers: () => order.map((name) => byWriter.get(name)?.writers()[0]).filter(isAuthor),
        retainedLengthOf: (author) => byAuthor(byWriter, order, author)?.retainedLengthOf(author),
        prefixReaderOf: (author) => {
            const found = byAuthor(byWriter, order, author);
            if (found === undefined) {
                throw new Error("the interleaving presentation asked a writer it was not given");
            }
            return found.prefixReaderOf(author);
        },
    };
}

/**
 * A source which presents the journal as a union of prefix contributors, one
 * contributor per writer per chosen prefix length, in the given order.
 * @param {GeneratedJournal} journal
 * @param {ReadonlyArray<string>} order
 * @param {Map<string, Array<number>>} perWriter
 * @param {number} chunkSize
 * @returns {JournalSource}
 */
function unionSource(journal, order, perWriter, chunkSize) {
    /** @type {JournalSource[]} */
    const contributors = [];
    for (const writerName of order) {
        for (const prefixLength of perWriter.get(writerName) ?? []) {
            const records = (journal.streams[writerName] ?? []).slice(0, prefixLength);
            contributors.push({
                writers: () => [makeJournalAuthorFromName(writerName)],
                retainedLengthOf: () => retainedLengthOf(records),
                prefixReaderOf: () => chunkedReader(writerName, records, chunkSize),
            });
        }
    }
    return mergeSources(contributors);
}

/**
 * The union of several sources, which is what `makeUnionSource` builds. It is
 * reimplemented here rather than imported so the harness controls the order in
 * which contributors are supplied, which is one of the freedoms under test.
 * @param {ReadonlyArray<JournalSource>} sources
 * @returns {JournalSource}
 */
function mergeSources(sources) {
    /** @type {Map<string, import("../src/generators/incremental_graph/journal").JournalAuthor>} */
    const byName = new Map();
    for (const source of sources) {
        for (const author of source.writers()) {
            const name = journalAuthorToString(author);
            if (!byName.has(name)) {
                byName.set(name, author);
            }
        }
    }
    const writers = [...byName.values()].sort((a, b) =>
        journalAuthorToString(a) < journalAuthorToString(b) ? -1 : 1
    );
    /**
     * @param {import("../src/generators/incremental_graph/journal").JournalAuthor} author
     * @returns {JournalSource[]}
     */
    function holders(author) {
        return sources.filter((source) =>
            source.writers().some((held) => journalAuthorToString(held) === journalAuthorToString(author))
        );
    }
    return {
        writers: () => writers,
        retainedLengthOf: (author) => {
            let greatest = makeJournalSequence("0");
            let seen = false;
            for (const holder of holders(author)) {
                const length = holder.retainedLengthOf(author);
                if (length !== undefined && (!seen || compareJournalSequence(length, greatest) > 0)) {
                    greatest = length;
                    seen = true;
                }
            }
            return seen ? greatest : undefined;
        },
        prefixReaderOf: (author) => {
            const name = journalAuthorToString(author);
            const readers = holders(author).map((holder) => holder.prefixReaderOf(author));
            return mergeReaders(name, readers);
        },
    };
}

/**
 * The streaming prefix union of several readers of one writer.
 * @param {string} writerName
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal/oracle").PrefixReader>} contributors
 * @returns {import("../src/generators/incremental_graph/journal/oracle").PrefixReader}
 */
function mergeReaders(writerName, contributors) {
    let expected = makeJournalSequence("1");
    /** @type {JournalError | undefined} */
    let failure;
    /**
     * @param {import("../src/generators/incremental_graph/journal").JournalSequence} sequence
     * @returns {boolean}
     */
    const matchesExpected = (sequence) => compareJournalSequence(sequence, expected) === 0;
    return {
        nextRecord: () => {
            if (failure !== undefined) {
                return undefined;
            }
            /** @type {JournalRecord[]} */
            const atCoordinate = [];
            for (const contributor of contributors) {
                const record = contributor.nextRecord();
                if (record === undefined) {
                    const contributorFailure = contributor.failure();
                    if (contributorFailure !== undefined) {
                        failure = contributorFailure;
                        return undefined;
                    }
                    continue;
                }
                if (compareJournalSequence(record.id.sequence, expected) < 0) {
                    continue;
                }
                if (!matchesExpected(record.id.sequence)) {
                    continue;
                }
                atCoordinate.push(record);
            }
            const first = atCoordinate[0];
            if (first === undefined) {
                return undefined;
            }
            expected = makeJournalSequence(String(Number(journalSequenceToString(expected)) + 1));
            return first;
        },
        failure: () => failure,
    };
}

/**
 * A reader which buffers `chunkSize` records at a time and hands out one per
 * call, which is the shape a chunked iterator over a real sublevel has.
 * @param {string} writerName
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {number} chunkSize
 * @returns {import("../src/generators/incremental_graph/journal/oracle").PrefixReader}
 */
function chunkedReader(writerName, records, chunkSize) {
    /** @type {JournalRecord[]} */
    let buffer = [];
    const plain = readerOverIterable(writerName, records, retainedLengthOf(records));
    /**
     * Draw the next batch from the underlying reader. A chunked iterator over a
     * real sublevel yields a whole batch or nothing, so the buffer is refilled
     * only once it has been drained.
     * @returns {void}
     */
    function refill() {
        buffer = [];
        for (let taken = 0; taken < chunkSize; taken++) {
            const record = plain.nextRecord();
            if (record === undefined) {
                break;
            }
            buffer.push(record);
        }
    }
    refill();
    return {
        nextRecord: () => {
            if (buffer.length === 0) {
                refill();
            }
            return buffer.shift();
        },
        failure: () => plain.failure(),
    };
}

/**
 * @param {ReadonlyArray<JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalSequence}
 */
function retainedLengthOf(records) {
    const last = records[records.length - 1];
    return last === undefined ? makeJournalSequence("0") : last.id.sequence;
}

/**
 * @param {Map<string, JournalSource>} byWriter
 * @param {ReadonlyArray<string>} order
 * @param {import("../src/generators/incremental_graph/journal").JournalAuthor} author
 * @returns {JournalSource | undefined}
 */
function byAuthor(byWriter, order, author) {
    const name = journalAuthorToString(author);
    if (!order.includes(name)) {
        return undefined;
    }
    return byWriter.get(name);
}

/**
 * @param {unknown} value
 * @returns {value is import("../src/generators/incremental_graph/journal").JournalAuthor}
 */
function isAuthor(value) {
    return value !== undefined;
}

/** @type {Map<string, import("../src/generators/incremental_graph/journal").JournalAuthor>} */
const AUTHORS = new Map();

/**
 * @param {string} name
 * @returns {import("../src/generators/incremental_graph/journal").JournalAuthor}
 */
function makeJournalAuthorFromName(name) {
    const existing = AUTHORS.get(name);
    if (existing !== undefined) {
        return existing;
    }
    const author = makeJournalAuthor(name);
    if (author instanceof Error) {
        throw new Error("the interleaving space was asked for an empty writer name");
    }
    AUTHORS.set(name, author);
    return author;
}

/**
 * The `JournalReplica` of a generated journal, which is what a whole-history
 * reference model consumes.
 * @param {GeneratedJournal} journal
 * @returns {JournalReplica}
 */
function replicaOf(journal) {
    return makeJournalReplica(
        Object.keys(journal.streams).map((name) => [
            makeJournalAuthorFromName(name),
            journal.streams[name] ?? [],
        ])
    );
}

module.exports = {
    KEYS,
    forkFixture,
    adversarialFixtures,
    KEY_1,
    KEY_2,
    KEY_3,
    NODES,
    OPERATIONS,
    enumerateJournals,
    identifierOf,
    keyAt,
    makeJournalAuthorFromName,
    permutationsOf,
    prefixDecompositionsOf,
    presentationsOf,
    replicaOf,
    schemaOf,
};

/**
 * Adversarial journals in which one projection rule is the *only* differentiator
 * between two candidate outcomes.
 *
 * The enumerated space above is exhaustive but coarse: in it the ordering keys
 * almost always agree with one another, so a mutation which drops one key still
 * produces the right answer and neither the confluence check nor the differential
 * can see it. These fixtures close that hole the only way it can be closed, by
 * constructing a journal in which the rule under test is the sole thing which
 * separates a right answer from a wrong one.
 *
 * Every fixture is built on `closedSpine`, a two-writer journal which is well
 * formed under `validateJournalReplica`, has its own-writer context exact, keeps
 * every claimed coordinate retained, and has a dependency-closed selected head
 * set. A fixture therefore differs from a supported journal only in the rule it is
 * built to isolate, and a rejection it produces is the rejection it was designed
 * to produce rather than an accident of the surrounding history.
 *
 * Each fixture states which rule it isolates, so a mutation which removes that
 * rule is caught by the fixture which names it rather than by luck.
 */

/**
 * @typedef {object} AdversarialFixture
 * @property {string} name
 * @property {string} isolates - The rule this fixture makes the sole differentiator.
 * @property {GeneratedJournal} journal
 * @property {boolean} [supported] - Whether the record layer accepts the fixture as a well-formed journal. `false` marks a fixture which deliberately violates one of the well-formedness rules, so both `validateJournalReplica` and the oracle are expected to reject it.
 * @property {boolean} [projectable] - Whether `projectRetainedJournal` is expected to accept the fixture. This is a different question from `supported`: a journal may be perfectly well formed and still not be projectable, which is exactly what a selected head set which is not dependency-closed is. Defaults to `true`.
 */

/**
 * The complete retained prefix of writer A after `closedSpine`, which is the cut
 * every second writer observes.
 *
 * A context is a causally closed *cut*, not an arbitrary coordinate set, so a
 * writer which observes A:5 has observed A:1..A:5 as well. Writing the cut in one
 * place keeps that rule from being restated at each call site, where a fixture
 * would otherwise be "fixed" into a context the record layer rejects for a reason
 * that has nothing to do with the rule the fixture is built to isolate.
 */
const SPINE_CUT = [["aaaaaaaaa", "5"]];

/**
 * The node a fixture addresses, by index into the three-node schema: node 0 reads
 * node 1, node 1 reads node 2, node 2 reads nothing.
 * @param {number} index
 * @returns {NodeKey}
 */
function nodeAt(index) {
    const node = NODES[index];
    if (node === undefined) {
        throw new Error("an adversarial fixture named a node outside the schema");
    }
    return node;
}

/**
 * @param {number} index
 * @returns {string}
 */
function keyAt(index) {
    return nodeKeyToCanonicalString(nodeAt(index));
}

/**
 * @param {number} index
 * @param {string} text
 * @param {string} writerName
 * @param {number} sequence
 * @param {number} physical
 * @param {ReadonlyArray<Array<string>>} coordinates
 * @returns {import("../src/generators/incremental_graph/journal").ValueEvent}
 */
function valueAt(index, text, writerName, sequence, physical, coordinates) {
    const record = makeValueEvent(
        {
            id: writerName + ":" + String(sequence),
            context: makeJournalFrontierFromText(coordinates),
            authorityTime: makeAuthorityTime(physical, String(sequence)),
            node: nodeAt(index),
        },
        identifierOf(keyAt(index)),
        { type: "entry_description", description: text },
        CREATED_AT,
        MODIFIED_AT,
        "compute"
    );
    if (record instanceof Error) {
        throw new Error("an adversarial fixture built a value the record layer rejects");
    }
    return record;
}

/**
 * @param {number} index
 * @param {string} text
 * @param {string} writerName
 * @param {number} sequence
 * @param {number} physical
 * @param {ReadonlyArray<Array<string>>} coordinates
 * @returns {import("../src/generators/incremental_graph/journal").ValidateEvent}
 */
function validateAt(index, text, writerName, sequence, physical, coordinates, target, basisEntries) {
    const record = makeValidateEvent(
        {
            id: writerName + ":" + String(sequence),
            context: makeJournalFrontierFromText(coordinates),
            authorityTime: makeAuthorityTime(physical, String(sequence)),
            node: nodeAt(index),
        },
        target,
        basisEntries,
        "compute"
    );
    if (record instanceof Error) {
        throw new Error("an adversarial fixture built a validation the record layer rejects");
    }
    return record;
}

/**
 * @param {number} index
 * @param {string} writerName
 * @param {number} sequence
 * @param {number} physical
 * @param {ReadonlyArray<Array<string>>} coordinates
 * @param {import("../src/generators/incremental_graph/journal").InvalidateScope} scope
 * @param {import("../src/generators/incremental_graph/journal").InvalidateEvent["reason"]} reason
 * @returns {import("../src/generators/incremental_graph/journal").InvalidateEvent}
 */
function invalidateAt(index, writerName, sequence, physical, coordinates, scope, reason) {
    const record = makeInvalidateEvent(
        {
            id: writerName + ":" + String(sequence),
            context: makeJournalFrontierFromText(coordinates),
            authorityTime: makeAuthorityTime(physical, String(sequence)),
            node: nodeAt(index),
        },
        scope,
        reason
    );
    if (record instanceof Error) {
        throw new Error("an adversarial fixture built an invalidation the record layer rejects");
    }
    return record;
}

/**
 * A one-entry basis naming one input and the value it was read from.
 * @param {number} inputIndex
 * @param {import("../src/generators/incremental_graph/journal").ValueEvent} input
 * @returns {Array<import("../src/generators/incremental_graph/journal").ValidationBasisEntry>}
 */
function basisFor(inputIndex, input) {
    return [makeValidationBasisEntry(nodeAt(inputIndex), input.id)];
}

/**
 * Assemble a generated journal from explicit per-writer record lists.
 * @param {Record<string, ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>>} streams
 * @returns {GeneratedJournal}
 */
function journalOf(streams) {
    /** @type {Record<string, import("../src/generators/incremental_graph/journal").JournalRecord[]>} */
    const mutable = {};
    const interleaving = [];
    const operations = [];
    for (const writerName of Object.keys(streams).sort()) {
        mutable[writerName] = [...(streams[writerName] ?? [])];
        for (const record of mutable[writerName]) {
            interleaving.push(writerName);
            operations.push(record.kind);
        }
    }
    return { streams: mutable, interleaving, operations };
}

/**
 * The well-formed spine every fixture below is built on: a three-node chain whose
 * occurrences and certificates are all mutually observed, so its selected head set
 * is dependency-closed and its contexts are exact complete cuts.
 *
 * It is returned whole, and each fixture names the prefix of it it keeps, so a
 * fixture's difference from a supported journal is exactly the record or two it
 * adds.
 * @returns {{aaaaaaaaa: import("../src/generators/incremental_graph/journal").JournalRecord[], B: import("../src/generators/incremental_graph/journal").JournalRecord[]}}
 */
function closedSpine() {
    // A authors the whole chain in one uninterrupted prefix, so every context below
    // is the exact complete observed prefix and the whole history is causally
    // closed by construction.
    const leaf = valueAt(2, "leaf", "aaaaaaaaa", 1, 100, []);
    const middle = valueAt(1, "middle", "aaaaaaaaa", 2, 100, [["aaaaaaaaa", "1"]]);
    const root = valueAt(0, "root", "aaaaaaaaa", 3, 100, [["aaaaaaaaa", "2"]]);
    const middleCertificate = validateAt(
        1,
        "middle-certificate",
        "aaaaaaaaa",
        4,
        100,
        [["aaaaaaaaa", "3"]],
        middle.id,
        basisFor(2, leaf)
    );
    const rootCertificate = validateAt(
        0,
        "root-certificate",
        "aaaaaaaaa",
        5,
        100,
        [["aaaaaaaaa", "4"]],
        root.id,
        basisFor(1, middle)
    );
    return { aaaaaaaaa: [leaf, middle, root, middleCertificate, rootCertificate], bbbbbbbbb: [] };
}

/**
 * Two certificates for the same occurrence, where the one with the *weaker*
 * effective basis has the *greater* clock authority.
 *
 * This isolates the effective-basis-strength key. Ordering by authority alone picks
 * the wrong certificate; ignoring the authority tiebreak once strengths are equal
 * picks wrong too.
 * @returns {AdversarialFixture}
 */
/**
 * Two eligible certificates for one occurrence, where the one which proves *less*
 * has the *greater* clock authority.
 *
 * This isolates the effective-basis-strength key. Both certificates are eligible,
 * which means both name exactly the current input-key set, so neither can be
 * excluded on shape. They differ only in which ValueId they name for that input:
 * one names the current occurrence and the other names a superseded one, so the
 * first proves an effective edge and the second proves none.
 *
 * A certificate naming a stale ValueId is what makes this the *strength* key
 * rather than the eligibility key: eligibility is about which inputs are named,
 * and strength is about whether what they name is still current.
 * @returns {AdversarialFixture}
 */
function basisStrengthFixture() {
    const leaf = valueAt(2, "leaf", "aaaaaaaaa", 1, 100, []);
    // Two occurrences of node 1. The later one wins under authority, so it is the
    // current occurrence and the earlier one is superseded history.
    const middleOld = valueAt(1, "middle-old", "aaaaaaaaa", 2, 100, [["aaaaaaaaa", "1"]]);
    const middle = valueAt(1, "middle", "aaaaaaaaa", 3, 100, [["aaaaaaaaa", "2"]]);
    const root = valueAt(0, "root", "aaaaaaaaa", 4, 100, [["aaaaaaaaa", "3"]]);
    const rootCertificate = validateAt(
        0,
        "root-certificate",
        "aaaaaaaaa",
        5,
        100,
        [["aaaaaaaaa", "4"]],
        root.id,
        basisFor(1, middle)
    );
    const middleCertificate = validateAt(
        1,
        "middle-certificate",
        "aaaaaaaaa",
        6,
        100,
        [["aaaaaaaaa", "5"]],
        middle.id,
        basisFor(2, leaf)
    );
    // B revalidates the root naming the *superseded* node-1 occurrence, so it is
    // eligible on shape but proves nothing, and it has far greater authority than
    // the complete certificate at A:5.
    const weak = validateAt(0, "weak", "bbbbbbbbb", 1, 9000, [["aaaaaaaaa", "6"]], root.id, basisFor(1, middleOld));
    return {
        name: "effective basis strength beats clock authority",
        isolates: "the effective-basis-strength ordering key",
        journal: journalOf({
            aaaaaaaaa: [leaf, middleOld, middle, root, rootCertificate, middleCertificate],
            bbbbbbbbb: [weak],
        }),
        supported: true,
    };
}

/**
 * Two eligible certificates with equal effective basis, where the one which
 * causally covers a value-scoped invalidation has the *lesser* clock authority.
 *
 * This isolates `coversValueInvalidations` precedence. Both certificates name the
 * same current ValueId, so both prove the same edges, and the only difference
 * between them is whether they observed the invalidation.
 * @returns {AdversarialFixture}
 */
function valueCoverageFixture() {
    const leaf = valueAt(2, "leaf", "aaaaaaaaa", 1, 100, []);
    const middle = valueAt(1, "middle", "aaaaaaaaa", 2, 100, [["aaaaaaaaa", "1"]]);
    const root = valueAt(0, "root", "aaaaaaaaa", 3, 100, [["aaaaaaaaa", "2"]]);
    const rootCertificate = validateAt(
        0,
        "root-certificate",
        "aaaaaaaaa",
        4,
        100,
        [["aaaaaaaaa", "3"]],
        root.id,
        basisFor(1, middle)
    );
    const middleCertificate = validateAt(
        1,
        "middle-certificate",
        "aaaaaaaaa",
        5,
        100,
        [["aaaaaaaaa", "4"]],
        middle.id,
        basisFor(2, leaf)
    );
    // A:6 invalidates the root occurrence. A certificate which did not causally
    // observe it does not clear the invalidation merely by comparing later.
    const invalidation = invalidateAt(
        0,
        "aaaaaaaaa",
        6,
        100,
        [["aaaaaaaaa", "5"]],
        makeValueScope(journalRecordIdToString(root.id)),
        "propagated"
    );
    // A:7 observes the invalidation.
    const covering = validateAt(
        0,
        "covering",
        "aaaaaaaaa",
        7,
        100,
        [["aaaaaaaaa", "6"]],
        root.id,
        basisFor(1, middle)
    );
    // B:1 is concurrent with the invalidation and has far greater authority.
    const concurrent = validateAt(
        0,
        "concurrent",
        "bbbbbbbbb",
        1,
        9000,
        [["aaaaaaaaa", "5"]],
        root.id,
        basisFor(1, middle)
    );
    return {
        name: "value-invalidation coverage beats clock authority",
        isolates: "the coversValueInvalidations ordering key",
        journal: journalOf({
            aaaaaaaaa: [leaf, middle, root, rootCertificate, middleCertificate, invalidation, covering],
            bbbbbbbbb: [concurrent],
        }),
        supported: true,
    };
}

/**
 * Two eligible certificates with equal effective basis and equal coverage,
 * distinguished only by authority.
 *
 * This isolates the authority tiebreak itself, which is the last key before the
 * running maximum stops being order-independent.
 * @returns {AdversarialFixture}
 */
function authorityTiebreakFixture() {
    const leaf = valueAt(2, "leaf", "aaaaaaaaa", 1, 100, []);
    const middle = valueAt(1, "middle", "aaaaaaaaa", 2, 100, [["aaaaaaaaa", "1"]]);
    const root = valueAt(0, "root", "aaaaaaaaa", 3, 100, [["aaaaaaaaa", "2"]]);
    const rootCertificate = validateAt(
        0,
        "root-certificate",
        "aaaaaaaaa",
        4,
        100,
        [["aaaaaaaaa", "3"]],
        root.id,
        basisFor(1, middle)
    );
    const middleCertificate = validateAt(
        1,
        "middle-certificate",
        "aaaaaaaaa",
        5,
        100,
        [["aaaaaaaaa", "4"]],
        middle.id,
        basisFor(2, leaf)
    );
    // Both revalidate the root with the same complete basis, and neither observed
    // an invalidation, so they are told apart only by their authority time.
    const concurrent = validateAt(
        0,
        "concurrent",
        "bbbbbbbbb",
        1,
        9000,
        [["aaaaaaaaa", "5"]],
        root.id,
        basisFor(1, middle)
    );
    return {
        name: "authority breaks an otherwise exact certificate tie",
        isolates: "the authority tiebreak",
        journal: journalOf({
            aaaaaaaaa: [leaf, middle, root, rootCertificate, middleCertificate],
            bbbbbbbbb: [concurrent],
        }),
        supported: true,
    };
}

/**
 * A proof-edge barrier for one input of an occurrence, authored after a
 * certificate which proves that input.
 *
 * This isolates that a proof barrier is negative evidence about *one named edge*
 * and not a whole-certificate verdict: the barrier must remove exactly that edge
 * from the selected certificate's effective basis, leaving every other node's
 * proof untouched.
 * @returns {AdversarialFixture}
 */
function proofBarrierFixture() {
    const spine = closedSpine();
    const root = spine.aaaaaaaaa[2];
    if (root === undefined) {
        throw new Error("the closed spine is missing its root occurrence");
    }
    const barrier = invalidateAt(
        0,
        "aaaaaaaaa",
        6,
        100,
        [["aaaaaaaaa", "5"]],
        makeProofScope(journalRecordIdToString(root.id), nodeAt(1)),
        "reset"
    );
    return {
        name: "a proof barrier retires exactly the one edge it names",
        isolates: "proof-barrier suppression of the named edge only",
        journal: journalOf({ aaaaaaaaa: [...spine.aaaaaaaaa, barrier], bbbbbbbbb: spine.bbbbbbbbb }),
        supported: true,
    };
}

/**
 * A selected head set which is not dependency-closed, because the root's current
 * input is absent from the retained journal entirely.
 *
 * This isolates the rejection of a non-closed head set, which is the outcome the
 * specification says a raw retained union may legitimately have while
 * synchronization is still constructing a target.
 * @returns {AdversarialFixture}
 */
function dependencyClosureFixture() {
    // A retains only the root occurrence. The root's current input, node 1, is
    // absent, so the selected head set is not dependency-closed.
    const root = valueAt(0, "root-only", "aaaaaaaaa", 1, 100, []);
    return {
        name: "a present head whose current input is absent is not projectable",
        isolates: "dependency-closure rejection",
        journal: journalOf({ aaaaaaaaa: [root] }),
        supported: true,
        projectable: false,
    };
}

/**
 * The same closed spine, which *is* projectable.
 *
 * This isolates the accepting side of the same rule, so an implementation which
 * rejects every head set is caught by the pair rather than passing.
 * @returns {AdversarialFixture}
 */
function dependencyClosureAcceptingFixture() {
    return {
        name: "the same head set with its inputs present is projectable",
        isolates: "dependency-closure acceptance",
        journal: journalOf(closedSpine()),
        supported: true,
    };
}

/**
 * A second writer whose second record claims a complete own-writer prefix
 * coordinate it had not allocated, alongside the same writer whose records do
 * claim exactly their predecessors.
 *
 * This isolates the own-writer prefix exactness condition on both sides. The
 * rejecting case is expressible only across two writers, because within one
 * writer the coordinate is the position in the writer's own stream.
 * @returns {AdversarialFixture[]}
 */
function ownPrefixFixtures() {
    const spine = closedSpine();
    // B:1 observes the whole of A's retained prefix.
    const observing = valueAt(0, "b-observing", "bbbbbbbbb", 1, 9000, SPINE_CUT);
    // B:2 claims its own-writer context is B:2, which is not its predecessor B:1.
    const overreaching = valueAt(0, "b-overreaching", "bbbbbbbbb", 2, 9500, [...SPINE_CUT, ["bbbbbbbbb", "2"]]);
    return [
        {
            name: "a record whose own-writer context is its predecessor is accepted",
            isolates: "own-writer prefix exactness, accepting side",
            journal: journalOf({ aaaaaaaaa: spine.aaaaaaaaa, bbbbbbbbb: [observing] }),
            supported: true,
        },
        {
            name: "a record claiming a coordinate it had not allocated is rejected",
            isolates: "own-writer prefix exactness, rejecting side",
            journal: journalOf({ aaaaaaaaa: spine.aaaaaaaaa, bbbbbbbbb: [observing, overreaching] }),
            supported: false,
        },
    ];
}

/**
 * A context which claims a coordinate beyond the claiming writer's retained end,
 * alongside the same context bounded by the retained length.
 *
 * This isolates the retained-range coverage condition on both sides.
 * @returns {AdversarialFixture[]}
 */
function retainedRangeFixtures() {
    const spine = closedSpine();
    // A retains through A:5, so a cut bounded by A:5 is inside the retained range.
    const withinRange = valueAt(0, "b-within", "bbbbbbbbb", 1, 9000, SPINE_CUT);
    // The same writer and coordinate, but claiming A:99, which nobody retains.
    const beyondRange = valueAt(0, "b-beyond", "bbbbbbbbb", 1, 9000, [["aaaaaaaaa", "99"]]);
    return [
        {
            name: "a context inside the retained range is accepted",
            isolates: "retained-range coverage, accepting side",
            journal: journalOf({ aaaaaaaaa: spine.aaaaaaaaa, bbbbbbbbb: [withinRange] }),
            supported: true,
        },
        {
            name: "a context past the retained end is rejected",
            isolates: "retained-range coverage, rejecting side",
            journal: journalOf({ aaaaaaaaa: spine.aaaaaaaaa, bbbbbbbbb: [beyondRange] }),
            supported: false,
        },
    ];
}

/**
 * A local writer whose retained stream holds two writer-state records, so the
 * reconstructed allocator watermark is observable.
 *
 * This isolates the watermark read, which is the one projection field which is
 * neither graph-sized nor order-independent by the maximum argument: the oracle
 * takes the last one in writer-stream order, which is the maximum only because the
 * retained stream is monotone nondecreasing.
 * @returns {AdversarialFixture}
 */
function watermarkFixture() {
    const first = makeWriterStateRecord("aaaaaaaaa:1", 41);
    const second = makeWriterStateRecord("aaaaaaaaa:2", 42);
    if (first instanceof Error || second instanceof Error) {
        throw new Error("the watermark fixture built a record the record layer rejects");
    }
    return {
        name: "the allocator watermark is the greatest writer-state value",
        isolates: "the local allocator watermark",
        journal: journalOf({ aaaaaaaaa: [first, second] }),
        supported: true,
    };
}

/**
 * Three certificates which are each ineligible for a different reason, alongside
 * one which is eligible.
 *
 * The eligibility rules are a family of separate conditions, and a mutation which
 * removes any one of them changes which certificates compete for the current
 * proof. The enumerated space produces only well-formed certificates, so without
 * these three a mutation of any eligibility rule is unobservable.
 * @returns {AdversarialFixture[]}
 */
function eligibilityFixtures() {
    const leaf = valueAt(2, "leaf", "aaaaaaaaa", 1, 100, []);
    const middle = valueAt(1, "middle", "aaaaaaaaa", 2, 100, [["aaaaaaaaa", "1"]]);
    const root = valueAt(0, "root", "aaaaaaaaa", 3, 100, [["aaaaaaaaa", "2"]]);
    const rootCertificate = validateAt(
        0,
        "root-certificate",
        "aaaaaaaaa",
        4,
        100,
        [["aaaaaaaaa", "3"]],
        root.id,
        basisFor(1, middle)
    );
    const middleCertificate = validateAt(
        1,
        "middle-certificate",
        "aaaaaaaaa",
        5,
        100,
        [["aaaaaaaaa", "4"]],
        middle.id,
        basisFor(2, leaf)
    );
    // An "unknown" entry: legal for a maintenance reason, and never equal to a
    // current ValueId, so it proves nothing. Counting it as a match would make
    // this certificate compete with the complete one.
    const unknown = makeValidateEvent(
        {
            id: "bbbbbbbbb:1",
            context: makeJournalFrontierFromText([["aaaaaaaaa", "5"]]),
            authorityTime: makeAuthorityTime(9000, "1"),
            node: nodeAt(0),
        },
        root.id,
        [makeValidationBasisEntry(nodeAt(1), "unknown")],
        "reset"
    );
    if (unknown instanceof Error) {
        throw new Error("an eligibility fixture built a validation the record layer rejects");
    }
    // A basis which names an input the node does not have, so the declared input
    // set is not the current one. Accepting it would let a certificate prove a
    // shape which is not the current schema's.
    const wrongShape = makeValidateEvent(
        {
            id: "bbbbbbbbb:1",
            context: makeJournalFrontierFromText([["aaaaaaaaa", "5"]]),
            authorityTime: makeAuthorityTime(9000, "1"),
            node: nodeAt(0),
        },
        root.id,
        [
            makeValidationBasisEntry(nodeAt(1), middle.id),
            makeValidationBasisEntry(nodeAt(2), leaf.id),
        ],
        "compute"
    );
    if (wrongShape instanceof Error) {
        throw new Error("an eligibility fixture built a validation the record layer rejects");
    }
    const spineOf = (extra) =>
        journalOf({ aaaaaaaaa: [leaf, middle, root, rootCertificate, middleCertificate], bbbbbbbbb: [extra] });
    return [
        {
            name: "a certificate naming inputs the node does not have proves nothing",
            isolates: "the current input-key shape rule",
            journal: spineOf(wrongShape),
            supported: true,
        },
        {
            name: "a certificate naming an unknown input value proves nothing",
            isolates: 'an "unknown" basis entry not counting as a match',
            journal: journalOf({
                aaaaaaaaa: [leaf, middle, root, rootCertificate, middleCertificate],
                bbbbbbbbb: [unknown],
            }),
            supported: true,
        },
    ];
}

/**
 * A journal whose writer A stream has a hole, and the whole journal without it.
 *
 * The no-holes condition is a consequence of the reader's expected-coordinate
 * counter rather than a separate pass, so it is only observable through a source
 * which actually skips a coordinate. These fixtures supply one.
 * @returns {AdversarialFixture[]}
 */
function holeFixtures() {
    const leaf = valueAt(2, "leaf", "aaaaaaaaa", 1, 100, []);
    const middle = valueAt(1, "middle", "aaaaaaaaa", 2, 100, [["aaaaaaaaa", "1"]]);
    const root = valueAt(0, "root", "aaaaaaaaa", 3, 100, [["aaaaaaaaa", "2"]]);
    const intact = journalOf({ aaaaaaaaa: [leaf, middle, root] });
    // A retains A:1..A:3, and the source hands over A:1 and A:3 without A:2.
    const withHole = journalOf({ aaaaaaaaa: [leaf, root] });
    return [
        {
            name: "a contiguous stream is read whole",
            isolates: "the reader, accepting side",
            journal: intact,
            supported: true,
        },
        {
            name: "a stream which skips a coordinate is a hole",
            isolates: "the reader's expected-coordinate counter",
            journal: withHole,
            supported: false,
            projectable: false,
        },
    ];
}

/**
 * Two retained prefixes of one writer which agree through A:1..A:k and disagree
 * at A:k+1, unioned into a single source.
 *
 * The fork cannot be expressed as a GeneratedJournal, because a journal is a
 * function of its records and two disagreeing records are not one journal. It is
 * therefore built here as a pair of journals and unioned at the source, which is
 * the only way a caller can present one.
 * @returns {{name: string, isolates: string, left: GeneratedJournal, right: GeneratedJournal}}
 */
function forkFixture() {
    const spine = closedSpine();
    const root = spine.aaaaaaaaa[2];
    if (root === undefined) {
        throw new Error("the closed spine is missing its root occurrence");
    }
    // B revalidates the root with the same basis as the spine, so the two histories
    // are equal on every field except the authority time at B:1.
    // The same coordinate with a different authority time, so the two retained
    // histories have different canonical meaning at B:1 and nowhere else.
    const agreeing = validateAt(
        0,
        "agreeing",
        "bbbbbbbbb",
        1,
        100,
        [["aaaaaaaaa", "5"]],
        root.id,
        basisFor(1, spine.aaaaaaaaa[1])
    );
    const disagreeing = validateAt(
        0,
        "disagreeing",
        "bbbbbbbbb",
        1,
        9000,
        [["aaaaaaaaa", "5"]],
        root.id,
        basisFor(1, spine.aaaaaaaaa[1])
    );
    return {
        name: "two prefixes which disagree at one coordinate are a fork",
        isolates: "the prefix-union merge's canonical-meaning comparison",
        agreeing: journalOf({ aaaaaaaaa: spine.aaaaaaaaa, bbbbbbbbb: [agreeing] }),
        disagreeing: journalOf({ aaaaaaaaa: spine.aaaaaaaaa, bbbbbbbbb: [disagreeing] }),
    };
}

/**
 * Every adversarial fixture, in a fixed order.
 * @returns {AdversarialFixture[]}
 */
function adversarialFixtures() {
    return [
        basisStrengthFixture(),
        valueCoverageFixture(),
        authorityTiebreakFixture(),
        proofBarrierFixture(),
        dependencyClosureFixture(),
        dependencyClosureAcceptingFixture(),
        ...ownPrefixFixtures(),
        ...retainedRangeFixtures(),
        watermarkFixture(),
        ...eligibilityFixtures(),
        ...holeFixtures(),
    ];
}
