const event = require("../src/event/structure");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");

/**
 * @param {string} date
 * @returns {import("../src/event/structure").SerializedEvent}
 */
function makeSerializedEvent(date) {
    return {
        id: "evt-1",
        date,
        original: "original",
        input: "input",
        creator: {
            name: "test",
            uuid: "00000000-0000-0000-0000-000000000001",
            version: "0.0.0",
            hostname: "test-host",
        },
    };
}

/**
 * @param {import("../src/datetime").DateTime} date
 * @returns {import("../src/event/structure").Event}
 */
function makeEvent(date) {
    return {
        id: eventId.fromString("evt-1"),
        date,
        original: "original",
        input: "input",
        creator: {
            name: "test",
            uuid: "00000000-0000-0000-0000-000000000001",
            version: "0.0.0",
            hostname: "test-host",
        },
    };
}

/**
 * Capabilities fixture with a non-UTC timezone to ensure serialization does
 * not depend on the capability timezone.
 */
const losAngelesCapabilities = {
    datetime: {
        timeZone: () => "America/Los_Angeles",
    },
};

describe("event date timezone preservation", () => {
    test("deserialize keeps UTC date components for +0000 input", () => {
        const originalDate = "2026-03-18T02:06:19+0000";
        const deserialized = event.deserialize(makeSerializedEvent(originalDate));
        expect(deserialized.date.day).toBe(18);
        expect(deserialized.date.hour).toBe(2);
        expect(deserialized.date.minute).toBe(6);
        expect(event.serialize(losAngelesCapabilities, deserialized).date).toBe(originalDate);
    });

    test("deserialize keeps non-UTC offsets unchanged", () => {
        const originalDate = "2026-03-18T02:06:19-0700";
        const deserialized = event.deserialize(makeSerializedEvent(originalDate));
        expect(deserialized.date.day).toBe(18);
        expect(deserialized.date.hour).toBe(2);
        expect(event.serialize(losAngelesCapabilities, deserialized).date).toBe(originalDate);
    });

    test("serialize preserves +0000 instead of converting to capability timezone", () => {
        const serialized = event.serialize(
            losAngelesCapabilities,
            makeEvent(fromISOString("2026-03-18T02:06:19+0000"))
        );
        expect(serialized.date).toBe("2026-03-18T02:06:19+0000");
    });

    test("serialize preserves negative offsets instead of converting to capability timezone", () => {
        const serialized = event.serialize(
            losAngelesCapabilities,
            makeEvent(fromISOString("2026-03-18T02:06:19-0700"))
        );
        expect(serialized.date).toBe("2026-03-18T02:06:19-0700");
    });

    test("serialize preserves positive offsets instead of converting to capability timezone", () => {
        const serialized = event.serialize(
            losAngelesCapabilities,
            makeEvent(fromISOString("2026-03-18T02:06:19+0530"))
        );
        expect(serialized.date).toBe("2026-03-18T02:06:19+0530");
    });

    test("deserialize then serialize keeps +0000 on the same day", () => {
        const original = makeSerializedEvent("2026-03-18T02:06:19+0000");
        const deserialized = event.deserialize(original);
        const roundTrip = event.serialize(losAngelesCapabilities, deserialized);
        expect(roundTrip.date).toBe("2026-03-18T02:06:19+0000");
    });

    test("tryDeserialize accepts +0000 and serialization preserves timezone", () => {
        const result = event.tryDeserialize(makeSerializedEvent("2026-03-18T02:06:19+0000"));
        if (event.isTryDeserializeError(result)) {
            throw new Error("unexpected deserialization error");
        }
        expect(event.serialize(losAngelesCapabilities, result).date).toBe("2026-03-18T02:06:19+0000");
    });
});
