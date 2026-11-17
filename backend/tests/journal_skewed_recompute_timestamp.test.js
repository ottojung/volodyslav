"use strict";

/**
 * `incremental-graph-journal-testing.md` §Skewed value-timestamp regression (lines 27-31).
 *
 * Ordinary recompute must accept and persist a value occurrence with
 * `createdAt > modifiedAt`. The fixture materializes K with a persisted
 * `createdAt = Tfuture`, then recomputes K on a writer whose current wall clock
 * produces `modifiedAt = Tnow < Tfuture`. The new ValueEvent must preserve
 * `createdAt = Tfuture` and the exact committed `modifiedAt = Tnow` without
 * rejection or timestamp normalization. Conflict authority remains governed by
 * `AuthorityTime`, not by ordering the two persisted timestamps.
 *
 * This is distinct from the bootstrap skewed-timestamp case
 * (`journal_bootstrap_skewed_timestamp.test.js`), which covers the pre-Journal
 * boundary. This test covers the ordinary recompute path through
 * `finalizeEmission`, which is where the ValueEvent is authored.
 */

const {
    ZERO_JOURNAL_SEQUENCE,
    finalizeEmission,
    isValueEvent,
    isValidateEvent,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");
const { makeNodeIdentifier } = require("../src/generators/incremental_graph/database/node_identifier");

const WRITER_NAME = "aaaaaaaaa";
const FINGERPRINT = "aaaaaaaaa";

// Tfuture is after Tnow: the persisted createdAt is in the future relative to
// the wall clock that produces the recompute's modifiedAt.
const TFUTURE = "2030-06-15T12:00:00.000Z";
const TNOW = "2020-01-02T00:00:00.000Z";

const NODE_K = { head: "event", args: [{ id: 1 }] };
const NODE_KEY_STRING = nodeKeyToCanonicalString(NODE_K);

/**
 * Build a committed writer state for the local writer.
 * @returns {import("../src/generators/incremental_graph/journal").CommittedWriterState}
 */
function initialWriterState() {
    const author = makeJournalAuthor(WRITER_NAME);
    if (author instanceof Error) {
        throw new Error("the test writer name is not a valid fingerprint: " + author.message);
    }
    const highWater = makeAuthorityTime(0, "0");
    if (highWater instanceof Error) {
        throw new Error("the initial authority high-water is malformed");
    }
    return {
        localWriter: author,
        writerHead: ZERO_JOURNAL_SEQUENCE,
        committedFrontier: makeJournalFrontierFromText([]),
        authorityHighWater: highWater,
        allocatorWatermark: 0,
    };
}

describe("ordinary recompute accepts a skewed value timestamp (createdAt > modifiedAt)", () => {
    test("finalizeEmission preserves createdAt=Tfuture and modifiedAt=Tnow without rejection or normalization", () => {
        const state = initialWriterState();
        const publication = finalizeEmission({
            state,
            intents: [
                {
                    kind: "materialize",
                    node: NODE_K,
                    nodeIdentifier: makeNodeIdentifier(FINGERPRINT, 1),
                    payload: { type: "entry_description", description: "skewed" },
                    createdAt: TFUTURE,
                    modifiedAt: TNOW,
                    inputs: [],
                },
            ],
            publicationInstant: 1577923200000,
            allocatorWatermark: 1,
        });

        // The emission must not reject the skewed timestamp.
        expect(publication).not.toBeInstanceOf(Error);
        if (publication instanceof Error) {
            throw publication;
        }

        // Exactly one ValueEvent and one ValidateEvent.
        const valueEvents = publication.records.filter(isValueEvent);
        const validateEvents = publication.records.filter(isValidateEvent);
        expect(valueEvents).toHaveLength(1);
        expect(validateEvents).toHaveLength(1);

        const valueEvent = valueEvents[0];
        if (valueEvent === undefined) {
            throw new Error("expected a ValueEvent");
        }

        // The ValueEvent preserves both timestamps exactly.
        expect(valueEvent.createdAt).toBe(TFUTURE);
        expect(valueEvent.modifiedAt).toBe(TNOW);

        // The node is the one we materialized.
        expect(nodeKeyToCanonicalString(valueEvent.node)).toBe(NODE_KEY_STRING);
    });

    test("the persisted record round-trips through the codec with both skewed timestamps intact", () => {
        const state = initialWriterState();
        const publication = finalizeEmission({
            state,
            intents: [
                {
                    kind: "materialize",
                    node: NODE_K,
                    nodeIdentifier: makeNodeIdentifier(FINGERPRINT, 1),
                    payload: { type: "entry_description", description: "skewed" },
                    createdAt: TFUTURE,
                    modifiedAt: TNOW,
                    inputs: [],
                },
            ],
            publicationInstant: 1577923200000,
            allocatorWatermark: 1,
        });
        expect(publication).not.toBeInstanceOf(Error);
        if (publication instanceof Error) {
            throw publication;
        }

        const { encodeJournalRecord, tryDecodeJournalRecord, currentFormatValidateRecord } =
            require("../src/generators/incremental_graph/journal");

        for (const record of publication.records) {
            const encoded = encodeJournalRecord(record);
            const decoded = tryDecodeJournalRecord(encoded);
            if (decoded instanceof Error) {
                throw decoded;
            }
            // The current-format boundary accepts the skewed timestamps.
            expect(currentFormatValidateRecord(JSON.parse(encoded))).toBeUndefined();
        }

        const decodedValueEvents = publication.records
            .map((record) => tryDecodeJournalRecord(encodeJournalRecord(record)))
            .filter(isValueEvent);
        expect(decodedValueEvents).toHaveLength(1);
        expect(decodedValueEvents[0].createdAt).toBe(TFUTURE);
        expect(decodedValueEvents[0].modifiedAt).toBe(TNOW);
    });

    test("conflict authority is governed by AuthorityTime (modifiedAt), not by createdAt ordering", () => {
        const state = initialWriterState();
        const publication = finalizeEmission({
            state,
            intents: [
                {
                    kind: "materialize",
                    node: NODE_K,
                    nodeIdentifier: makeNodeIdentifier(FINGERPRINT, 1),
                    payload: { type: "entry_description", description: "skewed" },
                    createdAt: TFUTURE,
                    modifiedAt: TNOW,
                    inputs: [],
                },
            ],
            publicationInstant: 1577923200000,
            allocatorWatermark: 1,
        });
        expect(publication).not.toBeInstanceOf(Error);
        if (publication instanceof Error) {
            throw publication;
        }

        const valueEvent = publication.records.find(isValueEvent);
        if (valueEvent === undefined) {
            throw new Error("expected a ValueEvent");
        }

        // The AuthorityTime physical component is derived from modifiedAt (Tnow),
        // not from createdAt (Tfuture). The authority must reflect the wall clock
        // that produced modifiedAt, even though createdAt is later.
        const { epochMillisecondsOf } = require("../src/generators/incremental_graph/journal/emission");
        const modifiedAtPhysical = epochMillisecondsOf(TNOW);
        expect(modifiedAtPhysical).toBe(1577923200000);
        expect(valueEvent.authorityTime.physical).toBe(modifiedAtPhysical);

        // The authority is not derived from createdAt (Tfuture would be later).
        const createdAtPhysical = epochMillisecondsOf(TFUTURE);
        expect(createdAtPhysical).toBeGreaterThan(modifiedAtPhysical);
        expect(valueEvent.authorityTime.physical).not.toBe(createdAtPhysical);
    });

    test("a recompute after a skewed materialization preserves the future createdAt and updates modifiedAt", () => {
        // First publication: materialize with skewed timestamps.
        const state1 = initialWriterState();
        const pub1 = finalizeEmission({
            state: state1,
            intents: [
                {
                    kind: "materialize",
                    node: NODE_K,
                    nodeIdentifier: makeNodeIdentifier(FINGERPRINT, 1),
                    payload: { type: "entry_description", description: "first" },
                    createdAt: TFUTURE,
                    modifiedAt: TNOW,
                    inputs: [],
                },
            ],
            publicationInstant: 1577923200000,
            allocatorWatermark: 1,
        });
        expect(pub1).not.toBeInstanceOf(Error);
        if (pub1 instanceof Error) {
            throw pub1;
        }

        // Second publication: recompute with a new value. The recompute path
        // (recompute.js handleChanged) preserves createdAt from the existing
        // timestamp and sets modifiedAt to the new wall clock. We simulate the
        // recompute by issuing another materialize intent with the same
        // createdAt (Tfuture) but a different modifiedAt (still < Tfuture).
        const TNOW2 = "2020-03-04T00:00:00.000Z";
        const state2 = pub1.writerState;
        const pub2 = finalizeEmission({
            state: state2,
            intents: [
                {
                    kind: "materialize",
                    node: NODE_K,
                    nodeIdentifier: makeNodeIdentifier(FINGERPRINT, 1),
                    payload: { type: "entry_description", description: "second" },
                    createdAt: TFUTURE,
                    modifiedAt: TNOW2,
                    inputs: [],
                },
            ],
            publicationInstant: 1583280000000,
            allocatorWatermark: 1,
        });
        expect(pub2).not.toBeInstanceOf(Error);
        if (pub2 instanceof Error) {
            throw pub2;
        }

        const valueEvents = pub2.records.filter(isValueEvent);
        expect(valueEvents).toHaveLength(1);
        const recomputeEvent = valueEvents[0];
        if (recomputeEvent === undefined) {
            throw new Error("expected a ValueEvent");
        }

        // The recompute preserves the future createdAt and uses the new modifiedAt.
        expect(recomputeEvent.createdAt).toBe(TFUTURE);
        expect(recomputeEvent.modifiedAt).toBe(TNOW2);
        // The new modifiedAt is still before the preserved createdAt.
        expect(recomputeEvent.modifiedAt < recomputeEvent.createdAt).toBe(true);
    });
});
