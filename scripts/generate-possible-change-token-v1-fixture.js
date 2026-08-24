#!/usr/bin/env node
const fs = require("fs");

const fixturePath = "scripts/fixtures/possible-change-token-v1.json";
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const U64_MAX = 18446744073709551615n;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function compareUtf16(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function isConstValue(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) {
        return value.every((entry, index) =>
            Object.hasOwn(value, index) && isConstValue(entry));
    }
    return typeof value === "object"
        && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).every(key => isConstValue(value[key]));
}

function identityValue(filter) {
    if (filter.kind === "wildcard") return ["wildcard"];
    if (filter.kind === "ground") {
        if (!IDENT.test(filter.head)) throw new Error("invalid ground head");
        const args = filter.args.map(argument =>
            argument === WILDCARD_ARGUMENT ? null : argument);
        if (!args.every(argument => argument === null || isConstValue(argument))) {
            throw new Error("invalid ground argument");
        }
        return ["ground", filter.head, args];
    }
    if (filter.kind === "union") {
        const children = [identityValue(filter.left), identityValue(filter.right)];
        children.sort((left, right) =>
            compareUtf16(JSON.stringify(left), JSON.stringify(right)));
        return ["union", children[0], children[1]];
    }
    throw new Error("invalid filter");
}

function filterIdentity(filter) {
    return JSON.stringify(identityValue(filter));
}

function isIdentityValue(value) {
    if (!Array.isArray(value)) return false;
    if (value.length === 1) return value[0] === "wildcard";
    if (value.length !== 3) return false;
    if (value[0] === "ground") {
        return typeof value[1] === "string" && IDENT.test(value[1])
            && Array.isArray(value[2])
            && value[2].every(argument => argument === null || isConstValue(argument));
    }
    if (value[0] !== "union"
        || !isIdentityValue(value[1]) || !isIdentityValue(value[2])) return false;
    return compareUtf16(JSON.stringify(value[1]), JSON.stringify(value[2])) <= 0;
}

function isCanonicalToken(token) {
    try {
        const parsed = JSON.parse(token);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
            || Object.keys(parsed).join() !== "change,cursor,filter,v" || parsed.v !== 1) return false;
        const change = parsed.change;
        if (change === null || typeof change !== "object" || Array.isArray(change)
            || Object.keys(change).join() !== "nodeName,bindings,action,time"
            || typeof change.nodeName !== "string" || !IDENT.test(change.nodeName)
            || !Array.isArray(change.bindings) || !change.bindings.every(isConstValue)
            || !["add", "edit", "delete", "invalidate", "validate"].includes(change.action)
            || !Number.isSafeInteger(change.time)
            || Math.abs(change.time) > 8640000000000000) return false;
        if (!Array.isArray(parsed.cursor)) return false;
        let prior = "";
        for (const coordinate of parsed.cursor) {
            if (!Array.isArray(coordinate) || coordinate.length !== 2
                || !/^[a-z]{16}$/.test(coordinate[0])
                || compareUtf16(prior, coordinate[0]) >= 0
                || !/^[1-9][0-9]*$/.test(coordinate[1])
                || BigInt(coordinate[1]) > U64_MAX) return false;
            prior = coordinate[0];
        }
        if (typeof parsed.filter !== "string") return false;
        const identity = JSON.parse(parsed.filter);
        if (!isIdentityValue(identity) || JSON.stringify(identity) !== parsed.filter) return false;
        return JSON.stringify(parsed) === token;
    } catch {
        return false;
    }
}

const WILDCARD_ARGUMENT = Symbol("wildcard argument");
const wildcard = { kind: "wildcard" };
const ground = (head, args) => ({ kind: "ground", head, args });
const union = (left, right) => ({ kind: "union", left, right });

function tokenValue({
    bindings = [1],
    cursor = [[A, "1"]],
    filter = wildcard,
} = {}) {
    const canonicalCursor = cursor
        .filter(([, coordinate]) => coordinate !== "0")
        .sort(([left], [right]) => compareUtf16(left, right));
    return {
        change: { nodeName: "event", bindings, action: "edit", time: 40 },
        cursor: canonicalCursor,
        filter: filterIdentity(filter),
        v: 1,
    };
}

function canonical(name, options) {
    const value = tokenValue(options);
    return { name, value, token: JSON.stringify(value) };
}

function buildFixture() {
    const groundWildcard = ground("X", [WILDCARD_ARGUMENT]);
    const groundConcrete = ground("X", [["wildcard"]]);
    const emoji = ground("X", ["😀"]);
    const privateUse = ground("X", ["\uE000"]);
    const unicodeUnion = union(emoji, privateUse);
    const nestedUnion = union(union(ground("X", [1]), ground("X", [2])), emoji);

    let chain = ground("X", ["g"]);
    const linearSizes = [filterIdentity(chain).length];
    for (let depth = 1; depth <= 32; depth += 1) {
        chain = union(chain, ground("X", ["g"]));
        linearSizes.push(filterIdentity(chain).length);
    }
    const increments = linearSizes.slice(1).map((size, index) => size - linearSizes[index]);
    if (!increments.every(increment => increment === increments[0])) {
        throw new Error("nested-union identity growth is not linear");
    }

    const canonicalVectors = [
        canonical("baseline-empty-cursor", { cursor: [] }),
        canonical("one-author"),
        canonical("multiple-authors", { cursor: [[B, "7"], [A, "3"]] }),
        canonical("direct-nested-bindings", { bindings: [{ outer: [true, 1e-7, { inner: "x" }] }] }),
        canonical("negative-zero", { bindings: [-0] }),
        canonical("positive-zero", { bindings: [0] }),
        canonical("javascript-number-boundaries", { bindings: [1e-7, 1e-6] }),
        canonical("uint64-maximum", { cursor: [[A, U64_MAX.toString()]] }),
        canonical("wildcard-ground-argument", { filter: groundWildcard }),
        canonical("concrete-wildcard-shaped-binding", { filter: groundConcrete }),
        canonical("nested-unions", { filter: nestedUnion }),
        canonical("unicode-union-forward", { filter: unicodeUnion }),
        canonical("unicode-union-swapped", { filter: union(privateUse, emoji) }),
    ];

    const base = tokenValue();
    const change = base.change;
    const invalid = [
        ["whitespace", JSON.stringify(base, null, 2)],
        ["wrong-top-level-order", JSON.stringify({ v: 1, filter: base.filter, cursor: base.cursor, change })],
        ["wrong-change-order", JSON.stringify({ ...base, change: { time: 40, action: "edit", bindings: [1], nodeName: "event" } })],
        ["unknown-field", JSON.stringify({ ...base, unknown: true })],
        ["unknown-version", JSON.stringify({ ...base, v: 2 })],
        ["legacy-base64-outer-token", Buffer.from(JSON.stringify(base)).toString("base64url")],
        ["padded-base64-outer-token", `${Buffer.from(JSON.stringify(base)).toString("base64url")}=`],
        ["null-const-binding", JSON.stringify({ ...base, change: { ...change, bindings: [null] } })],
        ["nan-binding", JSON.stringify(base).replace("[1]", "[NaN]")],
        ["infinity-binding", JSON.stringify(base).replace("[1]", "[Infinity]")],
        ["duplicate-coordinate", JSON.stringify({ ...base, cursor: [[A, "1"], [A, "2"]] })],
        ["unsorted-coordinates", JSON.stringify({ ...base, cursor: [[B, "1"], [A, "2"]] })],
        ["explicit-zero-coordinate", JSON.stringify({ ...base, cursor: [[A, "0"]] })],
        ["malformed-coordinate", JSON.stringify({ ...base, cursor: [[A, "01"]] })],
        ["out-of-range-coordinate", JSON.stringify({ ...base, cursor: [[A, (U64_MAX + 1n).toString()]] })],
        ["malformed-fingerprint", JSON.stringify({ ...base, cursor: [["bad", "1"]] })],
        ["malformed-filter-identity", JSON.stringify({ ...base, filter: "[\"bad\"]" })],
        ["malformed-ground-head", JSON.stringify({ ...base, filter: JSON.stringify(["ground", "not a valid head!", []]) })],
    ].map(([name, token]) => ({ name, token }));

    return {
        description: "Normative v1 token strings generated with JavaScript JSON.stringify.",
        canonical: canonicalVectors,
        invalid,
        filterIdentity: {
            unicodeUnion: filterIdentity(unicodeUnion),
            unicodeUnionSwapped: filterIdentity(union(privateUse, emoji)),
            nestedUnionLinearSizes: linearSizes,
        },
    };
}

const generated = `${JSON.stringify(buildFixture(), null, 2)}\n`;
if (process.argv.includes("--write")) fs.writeFileSync(fixturePath, generated);
else if (fs.readFileSync(fixturePath, "utf8") !== generated) {
    throw new Error(`Run ${process.argv[1]} --write`);
}
const fixture = JSON.parse(generated);
if (!fixture.canonical.every(vector => isCanonicalToken(vector.token))
    || fixture.invalid.some(vector => isCanonicalToken(vector.token))) {
    throw new Error("fixture canonicality validation failed");
}
console.log("possible-change token v1 JavaScript fixtures verified");
