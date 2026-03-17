const { extractHashtags } = require("../src/event");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { getEventBasicContext } = require("../src/generators/event_context");
const {
    computeBasicContextForEventId,
} = require("../src/generators/individual/basic_context");

/**
 * @param {string} id
 * @param {string} input
 * @returns {import("../src/event").Event}
 */
function makeEvent(id, input) {
    return {
        id: eventId.fromString(id),
        date: fromISOString("2024-01-01T00:00:00.000Z"),
        original: input,
        input,
        creator: {
            name: "test",
            uuid: "00000000-0000-0000-0000-000000000001",
            version: "0.0.0",
            hostname: "test-host",
        },
    };
}

/**
 * @param {string} id
 * @param {string} input
 * @returns {import("../src/event").SerializedEvent}
 */
function makeSerializedEvent(id, input) {
    return {
        id,
        date: "2024-01-01T00:00:00.000Z",
        original: input,
        input,
        creator: {
            name: "test",
            uuid: "00000000-0000-0000-0000-000000000001",
            version: "0.0.0",
            hostname: "test-host",
        },
    };
}

describe("basic context with hyphenated hashtags", () => {
    test("extractHashtags keeps hyphenated hashtags intact", () => {
        const hashtags = extractHashtags({
            input: "food #subway-sandwich-3, text #same-meal-1",
        });

        expect(hashtags).toEqual(new Set(["subway-sandwich-3", "same-meal-1"]));
    });

    test("getEventBasicContext matches exact hyphenated hashtags", () => {
        const targetEvent = makeEvent("target", "food #subway-sandwich-3");
        const exactMatch = makeEvent("exact", "text more details #subway-sandwich-3");
        const prefixOnlyMatch = makeEvent(
            "prefix-only",
            "text different sandwich #subway-sandwich-2"
        );

        const context = getEventBasicContext(
            [targetEvent, exactMatch, prefixOnlyMatch],
            targetEvent
        );

        expect(context.map((event) => event.id.identifier)).toEqual([
            "target",
            "exact",
        ]);
    });

    test("computeBasicContextForEventId keeps only exact serialized matches", () => {
        const serializedEvents = [
            makeSerializedEvent("target", "food #subway-sandwich-3"),
            makeSerializedEvent("exact", "text more details #subway-sandwich-3"),
            makeSerializedEvent(
                "prefix-only",
                "text different sandwich #subway-sandwich-2"
            ),
        ];

        const basicContext = computeBasicContextForEventId(
            "target",
            undefined,
            serializedEvents
        );

        expect(basicContext).toMatchObject({
            type: "basic_context",
            eventId: "target",
        });
        expect(basicContext.events.map((event) => event.id)).toEqual([
            "target",
            "exact",
        ]);
    });

    test("computeBasicContextForEventId keeps only exact serialized matches 2", () => {
        const serializedEvents = [
            makeSerializedEvent("target", "food [when 0 hours ago] One bottle of yogurt. 100 grams total. Detailed at #yogurt-yoplait1. Small cup of mixed nuts. About 30 grams total. See photo #mixed-nuts-3."),
            makeSerializedEvent("prefix-only", "text different yogurt #yogurt-yoplait2"),
            makeSerializedEvent("prefix-only2", "text different yogurt #yogurt-yoplait"),
            makeSerializedEvent("unrelated", "text unrelated #unrelated"),
            makeSerializedEvent("unrelated2", "photo unrelated #unrelated2"),
            makeSerializedEvent("photo1", "photo #yogurt-yoplait1"),
            makeSerializedEvent("exact1", "register #yogurt-yoplait1"),
            makeSerializedEvent("exact2", "register [phone_take_photo] #mixed-nuts-3"),
            makeSerializedEvent("exact3", "register [phone_take_photo] #mixed-nuts-3"),
        ];

        const basicContext = computeBasicContextForEventId(
            "target",
            undefined,
            serializedEvents
        );

        expect(basicContext).toMatchObject({
            type: "basic_context",
            eventId: "target",
        });
        expect(basicContext.events.map((event) => event.id)).toEqual(["target", "photo1", "exact1", "exact2", "exact3"]);
    });
});
