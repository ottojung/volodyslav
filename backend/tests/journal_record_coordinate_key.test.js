/**
 * The Journal sequence type is arbitrary precision. Storage's record-key
 * lexical order must therefore remain numeric beyond its historical 30 digits.
 */
const { makeJournalAuthor, makeJournalSequence, journalSequenceToString } =
    require("../src/generators/incremental_graph/journal");
const { makeJournalRecordKey } =
    require("../src/generators/incremental_graph/journal_store/journal_database");
const { decodeRecordCoordinate, encodeRecordCoordinate } =
    require("../src/generators/incremental_graph/journal_store/record_coordinate_key");
const { readRetainedLengths } =
    require("../src/generators/incremental_graph/journal_store/sublevel_source");
const { snapshotFromRenderedReplica } =
    require("../src/generators/incremental_graph/journal_git_recovery");

const AUTHOR = "aaaaaaaaa";

/** @param {string} digits */
function storageKeyOf(digits) {
    const author = makeJournalAuthor(AUTHOR);
    const sequence = makeJournalSequence(digits);
    if (author instanceof Error || sequence instanceof Error) {
        throw new Error("the test built an invalid writer/coordinate");
    }
    const key = makeJournalRecordKey(author, sequence);
    if (key instanceof Error) {
        throw key;
    }
    return key;
}

test("arbitrary-width record keys round-trip and retain old 30-digit keys", () => {
    const sequences = [
        "0", "1", "9", "10", "9".repeat(29), "1" + "0".repeat(29),
        "9".repeat(30), "1" + "0".repeat(30), "2" + "0".repeat(30),
        "9".repeat(31), "1" + "0".repeat(31), "1" + "0".repeat(200),
    ];
    const keys = sequences.map(storageKeyOf);
    expect(keys[0]).toBe("record|" + AUTHOR + "|" + "0".repeat(30));
    expect(keys[1]).toBe("record|" + AUTHOR + "|" + "0".repeat(29) + "1");
    expect(keys).toEqual([...keys].sort());
    for (let index = 0; index < sequences.length; index++) {
        const encoded = keys[index].split("|").pop();
        expect(decodeRecordCoordinate(encoded)).toBe(sequences[index]);
    }
});

test("the extended coordinate decoder rejects noncanonical lengths and digits", () => {
    const d31 = "1" + "0".repeat(30);
    expect(encodeRecordCoordinate(d31)).toBe("z110310" + d31);
    for (const bad of [
        "z0" + d31, "z110300" + d31, "z110310" + "0".repeat(31),
        "z110310" + d31 + "0", "z1100310" + d31, "z110320" + d31,
        "z1110310" + d31,
        "0".repeat(31), "0".repeat(29), "not-a-coordinate",
    ]) {
        expect(decodeRecordCoordinate(bad)).toBeUndefined();
    }
});

test("reverse retained-length lookup chooses the numeric maximum above 30 digits", async () => {
    const keys = [
        storageKeyOf("9".repeat(30)), storageKeyOf("1" + "0".repeat(30)),
        storageKeyOf("9".repeat(31)), storageKeyOf("1" + "0".repeat(31)),
    ];
    const values = new Map(keys.map((key) => [key, "{}"]));
    const journal = {
        async *keys() {
            for (const key of [...values.keys()].sort()) yield key;
        },
        iterator({ gte, lte, reverse, limit }) {
            const entries = [...values].filter(([key]) => key >= gte && (lte === undefined || key <= lte))
                .sort(([a], [b]) => reverse ? b.localeCompare(a) : a.localeCompare(b));
            return (async function* () {
                for (const entry of entries.slice(0, limit ?? entries.length)) yield entry;
            })();
        },
    };
    const lengths = await readRetainedLengths(journal);
    if (lengths instanceof Error) throw lengths;
    const maximum = lengths.get(AUTHOR);
    expect(maximum).toBeDefined();
    expect(journalSequenceToString(maximum)).toBe("1" + "0".repeat(31));
});

test("Git checkpoint parser recognizes extended keys before decoding body", async () => {
    const file = "/virtual/journal/" + storageKeyOf("1" + "0".repeat(30));
    const source = {
        scanner: { async scanDirectory() { return [{ path: file }]; } },
        reader: { async readFileAsText() { throw new Error("BODY_READER_REACHED"); } },
    };
    await expect(snapshotFromRenderedReplica(source, "/virtual"))
        .rejects.toThrow("BODY_READER_REACHED");
});
