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

const RETIRED_SYNC_REQUIREMENTS = [
    "REQ-SYNC-04",
    "REQ-SYNC-05",
    "REQ-SYNC-06",
    "REQ-SYNC-07",
    "REQ-SYNC-08",
    "REQ-SYNC-08a",
    "REQ-SYNC-08b",
    "REQ-SYNC-08c",
    "REQ-SYNC-08d",
    "REQ-SYNC-09",
    "REQ-SYNC-10",
    "REQ-SYNC-11",
    "REQ-SYNC-11a",
    "REQ-SYNC-12",
    "REQ-SYNC-13",
    "REQ-SYNC-14",
    "REQ-SYNC-15",
    "REQ-SYNC-16",
    "REQ-SYNC-17",
    "REQ-SYNC-18",
    "REQ-SYNC-19",
    "REQ-SYNC-20",
    "REQ-SYNC-21",
    "REQ-SYNC-22",
    "REQ-SYNC-23",
    "REQ-SYNC-24",
    "REQ-SYNC-25",
    "REQ-SYNC-26",
    "REQ-SYNC-27",
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
        expect(text).not.toMatch(/operations over migrated state/);
        expect(text).toMatch(
            /operations over a restored current-version replica/,
        );
    });

    test("the rollback-classification cross-reference points at the surviving unsupported-operations section", () => {
        const text = read("docs/specs/incremental-graph-journal-user-contract.md");
        expect(text).toContain("`database-lifecycle.md` §14");
    });
});
