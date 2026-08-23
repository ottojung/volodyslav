#!/usr/bin/env node
const fs = require("fs");
const fixturePath = "scripts/fixtures/possible-change-token-v1.json";
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const U64 = 18446744073709551615n;
const wildcardIdentity = JSON.stringify(["wildcard"]);

function validConst(value) {
    if (value === null || value === undefined) return false;
    if (["string", "boolean"].includes(typeof value)) return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every((entry, index) => Object.hasOwn(value, index) && validConst(entry));
    return typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).every(key => validConst(value[key]));
}
function validFilterIdentity(identityString) {
    if (typeof identityString !== "string") return false;
    let identity;
    try { identity = JSON.parse(identityString); } catch { return false; }
    if (JSON.stringify(identity) !== identityString || !Array.isArray(identity)) return false;
    if (identity.length === 1 && identity[0] === "wildcard") return true;
    if (identity.length === 3 && identity[0] === "ground" && typeof identity[1] === "string" && Array.isArray(identity[2])) {
        return identity[2].every(argument => argument === null || validConst(argument));
    }
    return identity.length === 3 && identity[0] === "union"
        && typeof identity[1] === "string" && typeof identity[2] === "string"
        && identity[1] <= identity[2]
        && validFilterIdentity(identity[1]) && validFilterIdentity(identity[2]);
}
function reconstruct(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).join() !== "change,cursor,filter,v" || parsed.v !== 1) throw new Error("shape");
    const change = parsed.change;
    if (!change || typeof change !== "object" || Array.isArray(change) || Object.keys(change).join() !== "nodeName,bindings,action,time") throw new Error("change");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(change.nodeName) || !Array.isArray(change.bindings) || !change.bindings.every(validConst)) throw new Error("bindings");
    if (!["add", "edit", "delete", "invalidate", "validate"].includes(change.action) || !Number.isSafeInteger(change.time) || Math.abs(change.time) > 8640000000000000) throw new Error("change scalars");
    if (!Array.isArray(parsed.cursor)) throw new Error("cursor");
    let prior = "";
    for (const coordinate of parsed.cursor) {
        if (!Array.isArray(coordinate) || coordinate.length !== 2 || !/^[a-z]{16}$/.test(coordinate[0]) || !/^[1-9][0-9]*$/.test(coordinate[1])) throw new Error("coordinate");
        if (coordinate[0] <= prior || BigInt(coordinate[1]) > U64) throw new Error("coordinate order");
        prior = coordinate[0];
    }
    if (!validFilterIdentity(parsed.filter)) throw new Error("filter");
    return { change: { nodeName: change.nodeName, bindings: change.bindings, action: change.action, time: change.time }, cursor: parsed.cursor, filter: parsed.filter, v: 1 };
}
function validToken(token) {
    try { const parsed = JSON.parse(token); return JSON.stringify(reconstruct(parsed)) === token; } catch { return false; }
}
function tokenValue(bindings = [1], cursor = [[A, "1"]], filter = wildcardIdentity) {
    return { change: { nodeName: "event", bindings, action: "edit", time: 40 }, cursor: [...cursor].filter(([, value]) => value !== "0").sort(([left], [right]) => left.localeCompare(right)), filter, v: 1 };
}
function canonical(name, bindings, cursor, filter) { const value = tokenValue(bindings, cursor, filter); return { name, value, token: JSON.stringify(value) }; }
function buildFixture() {
    const numericA = {}; numericA["2"] = "two"; numericA["1"] = "one";
    const numericB = {}; numericB["1"] = "one"; numericB["2"] = "two";
    const groundWildcard = JSON.stringify(["ground", "X", [null]]);
    const groundConcrete = JSON.stringify(["ground", "X", [["wildcard"]]]);
    const canonicalVectors = [
        canonical("single-author"), canonical("encoder-sorts-cursor", [1], [[B, "7"], [A, "3"]]),
        canonical("nested-bindings", [{ outer: [1e-7, 1e-6, { ok: true }] }]),
        canonical("large-finite-number", [1.7976931348623157e308]),
        canonical("integer-index-order-a", [numericA]), canonical("integer-index-order-b", [numericB]),
        canonical("negative-zero", [-0]), canonical("positive-zero", [0]),
        canonical("uint64-upper-boundary", [1], [[A, U64.toString()]]), canonical("baseline-empty-cursor", [1], []),
        canonical("ground-wildcard-filter", [1], [[A, "1"]], groundWildcard),
        canonical("ground-concrete-wildcard-shaped-value", [1], [[A, "1"]], groundConcrete),
    ];
    const base = tokenValue();
    const invalid = [];
    const add = (name, token) => invalid.push({ name, token });
    add("noncanonical-json-whitespace", JSON.stringify(base, null, 2));
    add("wrong-field-order", JSON.stringify({ v: 1, filter: base.filter, cursor: base.cursor, change: base.change }));
    add("unknown-top-level", JSON.stringify({ ...base, extra: 1 }));
    add("unknown-version", JSON.stringify({ ...base, v: 2 }));
    add("duplicate-coordinate", JSON.stringify({ ...base, cursor: [[A, "1"], [A, "2"]] }));
    add("unsorted-coordinates", JSON.stringify({ ...base, cursor: [[B, "1"], [A, "2"]] }));
    add("explicit-zero-coordinate", JSON.stringify({ ...base, cursor: [[A, "0"]] }));
    add("invalid-fingerprint", JSON.stringify({ ...base, cursor: [["bad", "1"]] }));
    add("out-of-range-coordinate", JSON.stringify({ ...base, cursor: [[A, (U64 + 1n).toString()]] }));
    add("null-binding", JSON.stringify({ ...base, change: { ...base.change, bindings: [null] } }));
    add("negative-zero-binding", JSON.stringify({ ...base, change: { ...base.change, bindings: [0] } }).replace("[0]", "[-0]"));
    add("malformed-filter-identity", JSON.stringify({ ...base, filter: '["bad"]' }));
    return { description: "Normative PossibleChangeCursor v1 vectors generated and checked with JavaScript JSON.stringify.", canonical: canonicalVectors, invalid };
}
const generated = `${JSON.stringify(buildFixture(), null, 2)}\n`;
if (process.argv.includes("--write")) fs.writeFileSync(fixturePath, generated);
else if (fs.readFileSync(fixturePath, "utf8") !== generated) throw new Error(`Run ${process.argv[1]} --write`);
const fixture = JSON.parse(generated);
if (!fixture.canonical.every(vector => validToken(vector.token)) || fixture.invalid.some(vector => validToken(vector.token))) throw new Error("Fixture codec validation failed");
console.log("possible-change token v1 JavaScript fixtures verified");
