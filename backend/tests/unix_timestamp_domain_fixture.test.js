const { DateTime: LuxonDateTime } = require("luxon");
const timestampVectors = require("../../scripts/fixtures/unix-timestamp-domain.json");

describe("shared UnixTimestamp domain vectors", () => {
    test.each(timestampVectors)("Luxon agrees for $description", vector => {
        const timestamp = Number(vector.value);
        const dateTime = LuxonDateTime.fromMillis(timestamp, { zone: "utc" });
        const roundTripsExactly = dateTime.isValid && dateTime.toMillis() === timestamp;

        expect(roundTripsExactly).toBe(vector.valid);
    });
});
