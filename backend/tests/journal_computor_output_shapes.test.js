/**
 * Regression tests for the record layer's acceptance of the values this
 * repository's own computors produce.
 *
 * A `ComputedValue` member shape is the executable form of the member typedef it
 * claims, and the record layer applies that shape to two kinds of payload: the
 * live value a computor returned, on the write path, and the value parsed back
 * out of a persisted record, on the replay path (`codec_read.js` hands a parsed
 * payload to `makeValueEvent` again). A shape which admits only one of those two
 * representations rejects values the repository produces itself.
 *
 * Every fixture below is the output of the real computor named in the test, taken
 * by calling the computor's own entry point. A hand-written JSON-round-tripped
 * fixture cannot catch this class of defect, because the round-tripped form is
 * exactly the form which already passed.
 */

const {
    makeAuthorityTime,
    makeJournalFrontierFromText,
    encodeJournalRecord,
    makeValueEvent,
    tryDecodeJournalRecord,
} = require("../src/generators/incremental_graph/journal");

const { computedValueViolation } = require("../src/generators/incremental_graph/database");

const entryDescriptionComputor = require("../src/generators/individual/entry_description/wrapper")
    .computor;
const metaEventsComputor = require("../src/generators/individual/meta_events/wrapper").computor;
const eventContextComputor = require("../src/generators/individual/event_context/wrapper")
    .computor;
const eventTranscriptionComputorFactory = require("../src/generators/individual/event_transcription/wrapper")
    .makeComputor;

const { stubLogger } = require("./stubs");

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

const SERIALIZED_DIARY_EVENT = {
    id: "aaaaaaaaa:1",
    date: "2020-01-01T09:00:00.000Z",
    original: "today I ate a sandwich",
    input: "today I ate a sandwich",
    creator: CREATOR,
};

const SERIALIZED_PLAIN_EVENT = {
    id: "aaaaaaaaa:2",
    date: "2020-01-01T10:00:00.000Z",
    original: "the sky is blue",
    input: "the sky is blue",
    creator: CREATOR,
};

const NOW = "2020-01-02T00:00:00.000Z";
const WRITER = "aaaaaaaaa";

/** @type {import("../src/generators/incremental_graph/database/types").ComputedValue} */
let diarised;

beforeAll(async () => {
    diarised = { type: "all_events", events: [SERIALIZED_DIARY_EVENT] };
    const meta = await metaEventsComputor([diarised], undefined, []);
    const transcribed = await eventTranscriptionComputorFactory({ logger: loggerStub() })(
        [
            { type: "event", value: SERIALIZED_PLAIN_EVENT },
            {
                type: "transcription",
                value: {
                    text: "the sky is blue",
                    transcriber: { name: "whisper", creator: "someone" },
                    creator: CREATOR,
                },
            },
        ],
        undefined,
        [{}, "2020-01/01/aaaaaaaaa:2/sky.wav"]
    );
    transcribedEvent = transcribed;
    metaEvents = meta;
    eventContexts = await eventContextComputor([meta], undefined, []);
});

/** @type {unknown} */
let metaEvents;
/** @type {unknown} */
let eventContexts;
/** @type {unknown} */
let transcribedEvent;

function loggerStub() {
    const capabilities = {};
    stubLogger(capabilities);
    return capabilities.logger;
}

/**
 * A value record built from `payload`, or the validation error the record layer
 * returns for it. Each call uses a distinct record identity so two records in one
 * test never claim one identity.
 * @param {object} node
 * @param {unknown} payload
 * @param {string} id
 * @returns {object}
 */
function valueRecordOf(node, payload, id) {
    return makeValueEvent(
        {
            id: WRITER + ":" + id,
            context: makeJournalFrontierFromText([]),
            authorityTime: makeAuthorityTime(1000, "0"),
            node,
        },
        node.args[0].id + "-abcdefghi",
        payload,
        NOW,
        NOW,
        "compute"
    );
}

const NODE_ENTRY_DESCRIPTION = { head: "entry_description", args: [{ id: 1 }] };
const NODE_META_EVENTS = { head: "meta_events", args: [{ id: 2 }] };
const NODE_EVENT_CONTEXT = { head: "event_context", args: [{ id: 3 }] };
const NODE_EVENT_TRANSCRIPTION = { head: "event_transcription", args: [{ id: 4 }] };

describe("the record layer accepts the live output of the entry_description computor", () => {
    test("the computor returns an own description member whose value is undefined", async () => {
        const payload = await entryDescriptionComputor(
            [{ type: "event", value: SERIALIZED_PLAIN_EVENT }]
        );
        expect(Object.prototype.hasOwnProperty.call(payload, "description")).toBe(true);
        expect(payload.description).toBeUndefined();
    });

    test("a value record built from that output is not rejected", async () => {
        const payload = await entryDescriptionComputor(
            [{ type: "event", value: SERIALIZED_PLAIN_EVENT }]
        );
        const record = valueRecordOf(NODE_ENTRY_DESCRIPTION, payload, "1");
        expect(record).not.toBeInstanceOf(Error);
    });

    test("a value record built from the persisted form of that output is not rejected either", async () => {
        const payload = await entryDescriptionComputor(
            [{ type: "event", value: SERIALIZED_PLAIN_EVENT }]
        );
        const record = valueRecordOf(
            NODE_ENTRY_DESCRIPTION,
            JSON.parse(JSON.stringify(payload)),
            "2"
        );
        expect(record).not.toBeInstanceOf(Error);
    });

    test("a description of a member's declared type is still required", () => {
        const record = valueRecordOf(
            NODE_ENTRY_DESCRIPTION,
            { type: "entry_description", description: 7 },
            "3"
        );
        expect(record).toBeInstanceOf(Error);
        expect(String(record.message)).toContain("payload.description must be a string");
    });
});

describe("the record layer accepts the live output of the meta_events computor", () => {
    test("the computor output holds a live event, not a round-tripped one", () => {
        expect(Object.getOwnPropertyNames(metaEvents.meta_events[0].event.id)).toEqual([
            "identifier",
            "__brand",
        ]);
    });

    test("a value record built from that output is not rejected", () => {
        const record = valueRecordOf(NODE_META_EVENTS, metaEvents, "4");
        expect(record).not.toBeInstanceOf(Error);
    });

    test("a value record built from the persisted form of that output is not rejected either", () => {
        const record = valueRecordOf(
            NODE_META_EVENTS,
            JSON.parse(JSON.stringify(metaEvents)),
            "5"
        );
        expect(record).not.toBeInstanceOf(Error);
    });

    test("a meta event whose event carries an undeclared member is still rejected", () => {
        const tampered = JSON.parse(JSON.stringify(metaEvents));
        tampered.meta_events[0].event.surprise = "value";
        expect(computedValueViolation(tampered)).toBeDefined();
        const record = valueRecordOf(NODE_META_EVENTS, tampered, "15");
        expect(record).toBeInstanceOf(Error);
    });
});

describe("the record layer accepts the live output of the event_context computor", () => {
    test("the computor output holds a live event, not a round-tripped one", () => {
        expect(Object.getOwnPropertyNames(eventContexts.contexts[0].context[0].id)).toEqual([
            "identifier",
            "__brand",
        ]);
    });

    test("a value record built from that output is not rejected", () => {
        const record = valueRecordOf(NODE_EVENT_CONTEXT, eventContexts, "6");
        expect(record).not.toBeInstanceOf(Error);
    });

    test("a value record built from the persisted form of that output is not rejected either", () => {
        const record = valueRecordOf(
            NODE_EVENT_CONTEXT,
            JSON.parse(JSON.stringify(eventContexts)),
            "7"
        );
        expect(record).not.toBeInstanceOf(Error);
    });

    test("a context event whose date is not a date is still rejected", () => {
        const tampered = JSON.parse(JSON.stringify(eventContexts));
        tampered.contexts[0].context[0].date = { _luxonDateTime: { year: 2020 } };
        expect(computedValueViolation(tampered)).toBeDefined();
        const record = valueRecordOf(NODE_EVENT_CONTEXT, tampered, "16");
        expect(record).toBeInstanceOf(Error);
    });
});

describe("the record layer accepts the live output of the event_transcription computor", () => {
    test("a value record built from that output is not rejected", () => {
        const record = valueRecordOf(NODE_EVENT_TRANSCRIPTION, transcribedEvent, "8");
        expect(record).not.toBeInstanceOf(Error);
    });

    test("a value record built from the persisted form of that output is not rejected either", () => {
        const record = valueRecordOf(
            NODE_EVENT_TRANSCRIPTION,
            JSON.parse(JSON.stringify(transcribedEvent)),
            "9"
        );
        expect(record).not.toBeInstanceOf(Error);
    });

    test("a transcription error result is still accepted on the live event", () => {
        const record = valueRecordOf(
            NODE_EVENT_TRANSCRIPTION,
            { type: "event_transcription", event: transcribedEvent.event, transcription: { message: "no audio" } },
            "10"
        );
        expect(record).not.toBeInstanceOf(Error);
    });
});

describe("a value record survives the persisted text and replays back through the record layer", () => {
    test.each([
        ["entry_description", NODE_ENTRY_DESCRIPTION, "11"],
        ["meta_events", NODE_META_EVENTS, "12"],
        ["event_context", NODE_EVENT_CONTEXT, "13"],
        ["event_transcription", NODE_EVENT_TRANSCRIPTION, "14"],
    ])("the %s record replays from its own persisted text", async (tag, node, id) => {
        const payload = await livePayloadOf(tag);
        const record = valueRecordOf(node, payload, id);
        expect(record).not.toBeInstanceOf(Error);
        const read = tryDecodeJournalRecord(encodeJournalRecord(record));
        expect(read).not.toBeInstanceOf(Error);
    });
});

/**
 * The live computed value the named union member's own computor produces.
 * @param {string} tag
 * @returns {Promise<unknown>}
 */
async function livePayloadOf(tag) {
    if (tag === "entry_description") {
        return entryDescriptionComputor([{ type: "event", value: SERIALIZED_PLAIN_EVENT }]);
    }
    if (tag === "meta_events") {
        return metaEvents;
    }
    if (tag === "event_context") {
        return eventContexts;
    }
    return transcribedEvent;
}
