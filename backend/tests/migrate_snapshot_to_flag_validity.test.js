const fs = require("fs");
const os = require("os");
const path = require("path");
const { migrateSnapshot } = require("../../scripts/migrate-snapshot-to-flag-validity");
const { serializeNodeKey, stringToNodeName } = require("../src/generators/incremental_graph/database");

function nodeKey(head, args = []) {
    return serializeNodeKey({ head: stringToNodeName(head), args });
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeSnapshot({ parentFreshness = "up-to-date", inputCounters = [1], counter = 1, includeCounter = true, inputId = "a" } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "volodyslav-migration-"));
    const r = path.join(root, "rendered", "r");
    writeJson(path.join(r, "global", "identifiers_keys_map"), [
        ["a", nodeKey("all_events")],
        ["b", nodeKey("events_count")],
    ]);
    writeJson(path.join(r, "global", "fingerprint"), "testfingerprint");
    writeJson(path.join(r, "global", "last_node_index"), 1);
    writeJson(path.join(r, "global", "version"), "0.0.0-dev");
    writeJson(path.join(r, "values", "a"), { type: "all_events", events: [] });
    writeJson(path.join(r, "values", "b"), { type: "events_count", count: 0 });
    writeJson(path.join(r, "freshness", "a"), "up-to-date");
    writeJson(path.join(r, "freshness", "b"), parentFreshness);
    writeJson(path.join(r, "inputs", "b"), { inputs: [inputId], inputCounters });
    fs.mkdirSync(path.join(r, "revdeps"), { recursive: true });
    writeJson(path.join(r, "revdeps", "a"), ["b"]);
    if (includeCounter) writeJson(path.join(r, "counters", "a"), counter);
    return root;
}

describe("migrate-snapshot-to-flag-validity", () => {
    test("up-to-date non-source node preserves freshness and writes complete validity flags", () => {
        const root = makeSnapshot();
        migrateSnapshot(root);
        const r = path.join(root, "rendered", "r");
        expect(JSON.parse(fs.readFileSync(path.join(r, "freshness", "b"), "utf8"))).toBe("up-to-date");
        expect(JSON.parse(fs.readFileSync(path.join(r, "valid", "a"), "utf8"))).toEqual(["b"]);
    });

    test("potentially-outdated node with all counters matching writes complete flags", () => {
        const root = makeSnapshot({ parentFreshness: "potentially-outdated", inputCounters: [7], counter: 7 });
        migrateSnapshot(root);
        const r = path.join(root, "rendered", "r");
        expect(JSON.parse(fs.readFileSync(path.join(r, "freshness", "b"), "utf8"))).toBe("potentially-outdated");
        expect(JSON.parse(fs.readFileSync(path.join(r, "valid", "a"), "utf8"))).toEqual(["b"]);
    });

    test("potentially-outdated node with one counter mismatch omits that flag", () => {
        const root = makeSnapshot({ parentFreshness: "potentially-outdated", inputCounters: [6], counter: 7 });
        migrateSnapshot(root);
        expect(fs.existsSync(path.join(root, "rendered", "r", "valid", "a"))).toBe(false);
    });

    test("zero-input stale node writes no flags", () => {
        const root = makeSnapshot();
        const r = path.join(root, "rendered", "r");
        fs.rmSync(path.join(r, "values", "b"));
        fs.rmSync(path.join(r, "freshness", "b"));
        fs.rmSync(path.join(r, "inputs", "b"));
        writeJson(path.join(r, "freshness", "a"), "stale");
        migrateSnapshot(root);
        expect(JSON.parse(fs.readFileSync(path.join(r, "freshness", "a"), "utf8"))).toBe("potentially-outdated");
        expect(fs.readdirSync(path.join(r, "valid"))).toEqual([]);
    });

    test("dependency changes before parent pull is represented by missing validity", () => {
        const root = makeSnapshot({ parentFreshness: "potentially-outdated", inputCounters: [1], counter: 2 });
        migrateSnapshot(root);
        expect(fs.existsSync(path.join(root, "rendered", "r", "valid", "a"))).toBe(false);
    });

    test.each([
        ["missing identifiers entry", (r) => writeJson(path.join(r, "global", "identifiers_keys_map"), [["a", nodeKey("all_events")]])],
        ["missing counter", (r) => fs.rmSync(path.join(r, "counters", "a"))],
        ["input mismatch", (r) => writeJson(path.join(r, "inputs", "b"), { inputs: ["missing"], inputCounters: [1] })],
    ])("malformed source snapshot fails: %s", (_name, mutate) => {
        const root = makeSnapshot();
        mutate(path.join(root, "rendered", "r"));
        expect(() => migrateSnapshot(root)).toThrow();
    });

    test("target shape removes source sublevels and writes graph_scheme and valid", () => {
        const root = makeSnapshot();
        migrateSnapshot(root);
        const r = path.join(root, "rendered", "r");
        expect(fs.existsSync(path.join(r, "inputs"))).toBe(false);
        expect(fs.existsSync(path.join(r, "revdeps"))).toBe(false);
        expect(fs.existsSync(path.join(r, "counters"))).toBe(false);
        expect(fs.existsSync(path.join(r, "global", "graph_scheme"))).toBe(true);
        expect(fs.existsSync(path.join(r, "valid"))).toBe(true);
    });
});
