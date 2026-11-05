/**
 * Checklist §4 / emission.md §Staging: failed transactions consume no durable
 * sequence coordinate, so a failed publication must not leave a hole the next
 * success skips over.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const {
    validateJournalReplica,
    journalSequenceToString,
} = require("../src/generators/incremental_graph/journal");

const allEventsModule = require("../src/generators/individual/all_events/wrapper");
const metaEventsComputor = require("../src/generators/individual/meta_events/wrapper").computor;
const eventContextComputor = require("../src/generators/individual/event_context/wrapper").computor;

const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

/**
 * @param {object} capabilities
 * @param {object} db
 * @returns {Promise<import("../src/generators/incremental_graph").IncrementalGraph>}
 */
async function makeRealGraph(capabilities, db) {
    const box = allEventsModule.makeBox();
    box.value = [
        {
            id: eventId.fromString("aaaaaaaaa:1"),
            date: fromISOString("2020-01-01T09:00:00.000Z"),
            original: "today I ate a sandwich",
            input: "today I ate a sandwich",
            creator: CREATOR,
        },
        {
            id: eventId.fromString("aaaaaaaaa:2"),
            date: fromISOString("2020-01-01T10:00:00.000Z"),
            original: "the sky is blue",
            input: "the sky is blue",
            creator: CREATOR,
        },
    ];
    const allEventsComputor = allEventsModule.makeComputor(box, {});
    return await createIncrementalGraph(capabilities, db, [
        {
            output: "all_events",
            inputs: [],
            computor: allEventsComputor,
            isDeterministic: false,
            hasSideEffects: false,
        },
        {
            output: "meta_events",
            inputs: ["all_events"],
            computor: metaEventsComputor,
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "event_context",
            inputs: ["meta_events"],
            computor: eventContextComputor,
            isDeterministic: true,
            hasSideEffects: false,
        },
    ]);
}

describe("failed local publication consumes no durable sequence", () => {
    test("a retry after an injected failure starts at sequence 1 with no hole", async () => {
        fs.mkdtempSync(path.join(os.tmpdir(), "journal-sequence-hole-"));
        const capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
        stubEnvironment(capabilities);
        const db = await getRootDatabase(capabilities);
        const graph = await makeRealGraph(capabilities, db);
        try {
            const namespaceSublevel = db.getSchemaStorage();
            const batch = namespaceSublevel.batch;
            namespaceSublevel.batch = async () => {
                throw new Error("injected publication failure");
            };
            try {
                await expect(graph.pull("event_context")).rejects.toThrow(
                    "injected publication failure"
                );
            } finally {
                namespaceSublevel.batch = batch;
            }

            await graph.pull("event_context");

            const replica = await readRetainedJournal(db.getSchemaStorage().journal);
            expect(replica).not.toBeInstanceOf(Error);
            if (replica instanceof Error) {
                throw replica;
            }
            expect(validateJournalReplica(replica)).not.toBeInstanceOf(Error);
            const records = [...replica.values()].flat();
            expect(records.length).toBeGreaterThan(0);
            const sequences = records
                .map((record) => Number(journalSequenceToString(record.id.sequence)))
                .sort((left, right) => left - right);
            expect(sequences[0]).toBe(1);
            for (let index = 1; index < sequences.length; index += 1) {
                expect(sequences[index]).toBe(sequences[index - 1] + 1);
            }
        } finally {
            await db.close();
        }
    });
});
