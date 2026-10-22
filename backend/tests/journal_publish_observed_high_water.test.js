/**
 * The observed union high-water synchronization and reset allocate above.
 *
 * `incremental-graph-journal-types.md` §Ordinary authority allocation defines each
 * writable database's committed high-water as at least the greatest `AuthorityTime`
 * among the semantic events it has observed, and
 * `incremental-graph-journal-storage.md` §Synchronization/reset validation requires a
 * synchronization or reset to derive the high-water it allocates above from committed
 * metadata rather than by rescanning retained history. `greatestObservedHighWater` is
 * that derivation: the maximum of the receiver's and the held snapshot's committed
 * high-waters, which covers the observed union `J0` because every retained record of
 * either side was observed by that side's writer.
 */

const {
    makeAuthorityTime,
} = require("../src/generators/incremental_graph/journal");
const {
    greatestObservedHighWater,
} = require("../src/generators/incremental_graph/journal_publish/observed_high_water");

/**
 * @param {number} physical
 * @param {string} [logical]
 * @returns {import("../src/generators/incremental_graph/journal").AuthorityTime}
 */
function authority(physical, logical = "0") {
    const time = makeAuthorityTime(physical, logical);
    if (time instanceof Error) {
        throw time;
    }
    return time;
}

describe("greatestObservedHighWater", () => {
    test("returns the source high-water when the source observed a later authority", () => {
        const receiver = authority(100, "0");
        const source = authority(200, "0");
        expect(greatestObservedHighWater(receiver, source)).toEqual(source);
    });

    test("returns the receiver high-water when the receiver observed a later authority", () => {
        const receiver = authority(300, "0");
        const source = authority(200, "5");
        expect(greatestObservedHighWater(receiver, source)).toEqual(receiver);
    });

    test("orders by logical time when the physical times are equal", () => {
        const receiver = authority(200, "1");
        const source = authority(200, "2");
        expect(greatestObservedHighWater(receiver, source)).toEqual(source);
        expect(greatestObservedHighWater(source, receiver)).toEqual(source);
    });

    test("returns the shared value when the two high-waters are equal", () => {
        const receiver = authority(200, "7");
        const source = authority(200, "7");
        expect(greatestObservedHighWater(receiver, source)).toEqual(receiver);
    });
});
