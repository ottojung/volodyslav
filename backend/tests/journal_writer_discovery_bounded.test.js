const { readRetainedLengths } =
    require("../src/generators/incremental_graph/journal_store/sublevel_source");
const { makeJournalAuthor, makeJournalSequence, journalSequenceToString } =
    require("../src/generators/incremental_graph/journal");
const { makeJournalRecordKey } =
    require("../src/generators/incremental_graph/journal_store/journal_database");

/** @param {string} writer @param {string} sequence */
function keyOf(writer, sequence) {
    const author = makeJournalAuthor(writer);
    const seq = makeJournalSequence(sequence);
    if (author instanceof Error || seq instanceof Error) throw new Error("bad fixture");
    const key = makeJournalRecordKey(author, seq);
    if (key instanceof Error) throw key;
    return key;
}

/** @param {string[]} keys */
function journalFor(keys) {
    let lookups = 0;
    let yielded = 0;
    const ordered = [...keys].sort();
    return {
        stats: () => ({lookups, yielded}),
        keys() { throw new Error("full retained-key enumeration is forbidden"); },
        iterator({ gte, lte, reverse, limit }) {
            if (limit !== 1) throw new Error("writer discovery must use single-entry seeks");
            lookups++;
            const within = ordered.filter(key => key >= gte && (lte === undefined || key <= lte));
            if (reverse) within.reverse();
            return (async function* () {
                for (const key of within.slice(0, limit)) {
                    yielded++;
                    yield [key, "{}"];
                }
            })();
        },
    };
}

test("one writer with 1000 retained keys needs constant metadata probes", async () => {
    const journal = journalFor(
        Array.from({length:1000}, (_, index) => keyOf("aaaaaaaaa", String(index+1))));
    const lengths = await readRetainedLengths(journal);
    if (lengths instanceof Error) throw lengths;
    expect(journalSequenceToString(lengths.get("aaaaaaaaa"))).toBe("1000");
    expect(journal.stats()).toEqual({lookups: 3, yielded: 2});
});

test("distinct writer discovery handles prefix-overlapping names without scanning", async () => {
    const authors = ["aaaaaaaaaa", "aaaaaaaaa", "aaaaaaaab", "zzzzzzzzz"];
    const expected = [["aaaaaaaaa", "1000"], ["aaaaaaaaaa", "2"],
        ["aaaaaaaab", "9"], ["zzzzzzzzz", "1" + "0".repeat(30)]];
    const entries = [
        ...Array.from({length:1000}, (_, index) => keyOf("aaaaaaaaa", String(index+1))),
        keyOf("aaaaaaaaaa", "1"), keyOf("aaaaaaaaaa", "2"),
        keyOf("aaaaaaaab", "9"), keyOf("zzzzzzzzz", "1" + "0".repeat(30)),
    ];
    const journal = journalFor(entries);
    const lengths = await readRetainedLengths(journal);
    if (lengths instanceof Error) throw lengths;
    expect([...lengths].map(([writer, sequence]) =>
        [writer, journalSequenceToString(sequence)])).toEqual(expected);
    expect(journal.stats()).toEqual({lookups: authors.length * 2 + 1,
        yielded: authors.length * 2});
});

test("malformed writer key fails closed", async () => {
    const result = await readRetainedLengths(journalFor(["record|bad-author|00001"]));
    expect(result).toBeInstanceOf(Error);
});

test("empty Journal needs one seek", async () => {
    const journal = journalFor([]);
    const lengths = await readRetainedLengths(journal);
    if (lengths instanceof Error) throw lengths;
    expect(lengths.size).toBe(0);
    expect(journal.stats()).toEqual({lookups:1, yielded:0});
});
