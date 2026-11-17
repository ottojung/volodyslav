const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "../..");

/**
 * @param {string} relativePath
 * @returns {string}
 */
function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

// Every numbered obligation from the retired REQ-SYNC-01..27 contract,
// including its lettered refinements, must be dispositioned explicitly.
// Generate the original complete numeric range rather than hand-listing the
// subset the initial cutover happened to mention.
const RETIRED_SYNC_REQUIREMENTS = [
    ...Array.from({length: 27}, (_, index) =>
        "REQ-SYNC-" + String(index + 1).padStart(2, "0")
    ),
    ..."abcd".split("").map(letter => "REQ-SYNC-08" + letter),
    "REQ-SYNC-11a",
    "DEF-SYNC-02",
];

describe("Journal 3 documentation contracts restored against the pre-Journal baseline", () => {
    test("the retired synchronization pointer records the disposition of every retired merge obligation", () => {
        const text = read("docs/specs/incremental-graph-synchronization.md");
        expect(text).not.toContain("No normative requirement was dropped");
        for (const requirement of RETIRED_SYNC_REQUIREMENTS) {
            expect(text).toContain(requirement);
        }
        expect(text).toContain("Superseded");
        expect(text).toContain("Still applicable");
    });

    test("release policy describes Journal suffix import, not retired mutable-graph merging", () => {
        const text = read("docs/release-safety.md");
        expect(text).toContain("immutable foreign-writer suffixes");
        expect(text).toContain("atomically");
        expect(text).toContain("writer fork");
        expect(text).toContain("missing committed writer prefix");
        expect(text).not.toContain("merge graph records deliberately");
        expect(text).not.toContain("current merge algorithm");
    });

    test("the three previously omitted synchronization requirements explain their Journal 3 replacements", () => {
        const text = read("docs/specs/incremental-graph-synchronization.md");
        const old01 = text.split("`REQ-SYNC-01`")[1].split("`REQ-SYNC-07`")[0];
        const old02 = text.split("`REQ-SYNC-02`")[1].split("`REQ-SYNC-03`")[0];
        const old03 = text.split("`REQ-SYNC-03`")[1].split("`REQ-SYNC-04`")[0];
        expect(old01).toContain("ValueId");
        expect(old02).toContain("foreign Journal suffixes");
        expect(old03).toContain("retaining the receiver's observed immutable Journal history");
    });

    test("keys-design records replace as identifier-preserving", () => {
        const text = read("docs/specs/keys-design.md");
        expect(text).toMatch(
            /preserves identifiers for `keep`, `replace`, and `invalidate`/,
        );
    });

    test("database-lifecycle restores the ordinary-evolution invariants", () => {
        const text = read("docs/specs/database-lifecycle.md");
        expect(text).toContain("Version ownership");
        expect(text).toContain("Durable-before-visible commit");
        expect(text).toContain("Schema-mediated access");
        expect(text).toContain("## 13a. Implementation consequences");
        expect(text).toContain("## 14. Unsupported operations and states");
        expect(text).toContain("## 15. Corruption versus incompatibility");
    });

    test("migration-testing Layer 3 states its migration-coverage boundary", () => {
        const text = read("docs/migration_testing.md");
        expect(text).toMatch(
            /this layer does not exercise migration; Layer 2 owns .* migration coverage/,
        );
        expect(text).toMatch(
            /neither check migrates an old-version fixture/,
        );
    });

    test("the rollback-classification cross-reference points at the surviving unsupported-operations section", () => {
        const text = read("docs/specs/incremental-graph-journal-user-contract.md");
        expect(text).toContain("`database-lifecycle.md` §14");
    });
});
