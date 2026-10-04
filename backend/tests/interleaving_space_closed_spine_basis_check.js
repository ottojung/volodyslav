#!/usr/bin/env node
/**
 * Instrument for the `closedSpine` basis claim at `interleaving_space.js:1050-1053`.
 *
 * The claim under measurement is a count of *builders* — the fixture-producing
 * functions defined in the fixture section of `interleaving_space.js` — together
 * with how many of them are built on `closedSpine`. Both numbers must be derived
 * from the module as it stands, so this instrument derives them rather than
 * asserting them from a list written by hand.
 *
 * The instrument has three properties, and each one answers a way the measurement
 * can be wrong:
 *
 * 1. It drives *every* export of the module that produces fixtures. The exports
 *    are enumerated from the loaded module, not named in this file, and each
 *    zero-argument export is called and its result inspected. A builder reachable
 *    only through an export this instrument does not know about cannot be missed,
 *    because no export is skipped by name.
 * 2. It instruments the *body entry* of `closedSpine` and of every builder
 *    function. Instrumenting a call site measures the rewrite, not the calls, and
 *    a rewrite which matches nothing reports zero builders — indistinguishable
 *    from a real count of zero. Every rewrite here is checked against the
 *    un-rewritten source and throws if it changed nothing.
 * 3. It cross-checks the denominator two independent ways. The builder set is
 *    taken from execution — which builders actually ran — and from a static parse
 *    of the module's own function definitions. A disagreement fails the run
 *    instead of being resolved by preferring one of the two.
 *
 * Nothing is written to disk: the module source is read, rewritten in memory, and
 * compiled through `Module` under the *original* filename, so its relative
 * requires resolve exactly as they do at run time.
 *
 * Usage:
 *   node backend/tests/interleaving_space_closed_spine_basis_check.js
 *   node backend/tests/interleaving_space_closed_spine_basis_check.js --control=positive
 *   node backend/tests/interleaving_space_closed_spine_basis_check.js --control=negative
 *
 * The controls rewrite the module in memory only, run the same measurement over
 * the rewrite, and assert that the measurement moved as the rewrite requires.
 *
 * This file measures and reports; it does not hold the golden values. The gate
 * which pins the count is `interleaving_space_closed_spine_basis_check.test.js`,
 * which requires this module and asserts the measurement against the numbers the
 * comment in `interleaving_space.js` states. Keeping the goldens in the gate and
 * the derivation here means the values being checked are the ones the comment
 * publishes, and the instrument still re-derives every number it reports.
 */

const fs = require("fs");
const path = require("path");
const Module = require("module");

const MODULE_PATH = path.join(__dirname, "interleaving_space.js");

/**
 * The filename the instrumented copy is compiled under.
 *
 * It must not be the committed filename. Line and column numbers reported for a
 * stack frame are resolved against whatever compilation of a *path* the host
 * process has already registered, so a host which has compiled `interleaving_space.js`
 * from its own transformed source makes every frame of the instrumented copy
 * resolve against that transformed source and report positions that belong to a
 * different file. The attribution below maps those positions onto the source this
 * instrument read, so the numbers it consumes would then be silently wrong. A
 * filename of its own keeps the positions this instrument sees its own.
 *
 * The name is a sibling of the committed file and is never written to disk, so
 * the module's directory — and therefore every relative require and every
 * `__dirname`-derived path inside it — is the one it has at run time.
 */
const INSTRUMENTED_NAME = "interleaving_space.instrumented.js";

/** The path the instrumented copy is compiled under; never written to disk. */
const INSTRUMENTED_PATH = path.join(path.dirname(MODULE_PATH), INSTRUMENTED_NAME);

/**
 * A stack frame belonging to the instrumented copy, matched on its own filename so
 * a frame of the committed copy is not mistaken for one of the instrumented copy.
 * @type {RegExp}
 */
const INSTRUMENTED_FRAME = new RegExp(
    `\\((?:.*[/\\\\])${INSTRUMENTED_NAME.replace(/\./g, "\\.")}:(\\d+):(\\d+)\\)`
);

/** Builders defined by the fixture section, matched by the module's own naming. */
const BUILDER_NAME = /^function ([A-Za-z0-9_]*Fixtures?)\(/;

/** The anchor whose body entry is instrumented to attribute each call to its builder. */
const CLOSED_SPINE_ANCHOR = "function closedSpine() {";

/** Maps a `interleaving_space.js` line number to the builder whose body encloses it. */
let builderAtLine = new Map();

/** The line `closedSpine` itself is defined on, so its own stack frame is skipped. */
let closedSpineLine;

/** The fixture section's producers, as the module itself reports them. */
function isFixture(value) {
    return value !== null && typeof value === "object" && typeof value.isolates === "string";
}

/** A fixture, or a list of fixtures, as returned by the module's producers. */
function isFixtureResult(value) {
    return isFixture(value) || (Array.isArray(value) && value.length > 0 && value.every(isFixture));
}

/**
 * Replace an anchor with a prefix, refusing to continue when the anchor matched
 * nothing. A silently unmatched rewrite is an instrument reporting zero builders.
 * @param {string} source
 * @param {string} anchor
 * @param {string} prefix
 * @returns {string}
 */
function prefixBody(source, anchor, prefix) {
    const index = source.indexOf(anchor);
    if (index === -1) {
        throw new Error(`Instrument anchor did not match: ${JSON.stringify(anchor)}`);
    }
    const insertion = index + anchor.length;
    const rewritten = source.slice(0, insertion) + prefix + source.slice(insertion);
    if (rewritten === source) {
        throw new Error(`Instrument rewrite was a no-op for ${JSON.stringify(anchor)}`);
    }
    return rewritten;
}

/**
 * Index every line of the fixture section to the builder whose body encloses it,
 * so a stack frame inside a builder body is attributed to that builder rather
 * than to a helper it called.
 * @param {string} source
 * @returns {void}
 */
function indexBuilderLines(source) {
    builderAtLine = new Map();
    const definition = new RegExp(CLOSED_SPINE_ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gm");
    const matched = definition.exec(source);
    if (matched === null) {
        throw new Error(`Instrument anchor did not match: ${JSON.stringify(CLOSED_SPINE_ANCHOR)}`);
    }
    closedSpineLine = source.slice(0, matched.index).split("\n").length;
    let current;
    for (const [offset, line] of source.split("\n").entries()) {
        const match = BUILDER_NAME.exec(line);
        if (match !== null) {
            current = match[1];
        }
        if (current !== undefined) {
            builderAtLine.set(String(offset + 1), current);
        }
    }
}

/**
 * The builders the module defines, read statically from its own definitions.
 * @param {string} source
 * @returns {string[]}
 */
function staticallyDefinedBuilders(source) {
    return [...source.matchAll(new RegExp(BUILDER_NAME, "gm"))].map((match) => match[1]).sort();
}

/**
 * The `globalThis` a `Module._compile`d module sees, discovered from inside the
 * module itself. A host that compiles the module in its own realm — a test
 * runner's sandbox, for instance — gives the module a `globalThis` the host code
 * cannot see, so a trace kept on the host's `globalThis` would be unreachable
 * from the instrumented bodies and every measurement would report zero
 * builders.
 * @returns {object}
 */
const CAPTURE_GLOBAL = "module.exports.__instrumentGlobal = globalThis;";

/**
 * Load the module with every builder body entry and the `closedSpine` body entry
 * instrumented, recording into a shared trace.
 * @param {string} source
 * @returns {{ exports: object, traceHost: object }} the module's exports and the
 *   object the instrumented bodies record their trace on
 */
function loadInstrumented(source) {
    let rewritten = source;
    for (const builder of staticallyDefinedBuilders(source)) {
        rewritten = prefixBody(
            rewritten,
            `function ${builder}() {`,
            ` globalThis.__trace.builders.push("${builder}");`
        );
    }
    rewritten = prefixBody(
        rewritten,
        CLOSED_SPINE_ANCHOR,
        " globalThis.__trace.spine.push(new Error().stack);"
    );
    const loaded = new Module(INSTRUMENTED_PATH, null);
    loaded.filename = INSTRUMENTED_PATH;
    loaded.paths = Module._nodeModulePaths(path.dirname(MODULE_PATH));
    loaded._compile(`${rewritten}\n${CAPTURE_GLOBAL}`, INSTRUMENTED_PATH);
    const traceHost = loaded.exports.__instrumentGlobal;
    traceHost.__trace = { builders: [], spine: [] };
    return { exports: loaded.exports, traceHost };
}

/**
 * The builder which called `closedSpine`, read from the recorded stack.
 * @param {string} stack
 * @returns {string | undefined}
 */
function builderOfStack(stack) {
    const frames = stack
        .split("\n")
        .slice(1)
        .map((candidate) => INSTRUMENTED_FRAME.exec(candidate))
        .filter((match) => match !== null);
    const caller = frames.find((match) => match[1] !== String(closedSpineLine));
    if (caller === undefined) {
        return undefined;
    }
    return builderAtLine.get(caller[1]);
}

/**
 * Drive every export the module has and collect what ran while each ran.
 *
 * An export is a *builder* when its own body constructs a fixture, and an
 * *aggregator* when its own body only delegates to other builders. The two are
 * told apart by what the trace shows, not by a list written here: a producer
 * whose trace names a builder other than itself delegated, so it is not one of
 * the builders the comment counts.
 * @param {object} exportsOfModule
 * @param {object} traceHost the `globalThis` the instrumented module records on
 * @returns {{ producers: string[], aggregators: string[], builders: Set<string>, spineBuilders: Set<string>, spineCalls: number }}
 */
function driveEveryExport(exportsOfModule, traceHost) {
    const producers = [];
    const builders = new Set();
    const aggregators = new Set();
    const spineBuilders = new Set();
    let spineCalls = 0;
    let spineFramesResolved = 0;
    for (const name of Object.keys(exportsOfModule)) {
        const exported = exportsOfModule[name];
        if (typeof exported !== "function" || exported.length !== 0) {
            continue;
        }
        traceHost.__trace = { builders: [], spine: [] };
        let result;
        try {
            result = exported();
        } catch {
            continue;
        }
        if (!isFixtureResult(result)) {
            continue;
        }
        producers.push(name);
        const delegated = traceHost.__trace.builders.some((builder) => builder !== name);
        if (delegated) {
            aggregators.add(name);
        }
        for (const builder of traceHost.__trace.builders) {
            if (builder !== name || !delegated) {
                builders.add(builder);
            }
        }
        for (const stack of traceHost.__trace.spine) {
            spineCalls += 1;
            const builder = builderOfStack(stack);
            if (builder === undefined) {
                continue;
            }
            spineFramesResolved += 1;
            spineBuilders.add(builder);
        }
    }
    if (spineCalls !== spineFramesResolved) {
        throw new Error(
            `${spineCalls - spineFramesResolved} of ${spineCalls} closedSpine stacks named no builder`
        );
    }
    return { producers, aggregators: [...aggregators].sort(), builders, spineBuilders, spineCalls };
}

/**
 * Run the measurement over a source of the module.
 * @param {string} source
 * @returns {{ producers: string[], aggregators: string[], builders: string[], spineBuilders: string[], spineCalls: number, defined: string[] }}
 */
function measure(source) {
    indexBuilderLines(source);
    const { exports: exportsOfModule, traceHost } = loadInstrumented(source);
    const driven = driveEveryExport(exportsOfModule, traceHost);
    return {
        producers: driven.producers,
        aggregators: driven.aggregators,
        builders: [...driven.builders].sort(),
        spineBuilders: [...driven.spineBuilders].sort(),
        spineCalls: driven.spineCalls,
        defined: staticallyDefinedBuilders(source)
    };
}

/**
 * A builder reachable only through an export this instrument was not written
 * against: the positive control. It calls `closedSpine`, so a measurement which
 * drives every export must see it and must raise both the numerator and the
 * denominator.
 * @param {string} source
 * @returns {string}
 */
function addBuilderBehindNewExport(source) {
    const added = [
        "function positiveControlFixture() {",
        "    return { name: \"positive control\", isolates: \"positive control\", journal: closedSpine() };",
        "}",
        "",
        "function positiveControlFixtures() {",
        "    return [positiveControlFixture()];",
        "}",
        "",
        "module.exports = {",
        "    positiveControlFixtures,",
        ""].join("\n");
    const withExport = source.replace("module.exports = {", added);
    if (withExport === source) {
        throw new Error("Positive control could not attach its export.");
    }
    return withExport;
}

/**
 * One builder's `closedSpine` call replaced by a journal constructed directly:
 * the negative control. The count must fall by exactly one and the denominator
 * must not move, so the measurement neither matches every builder nor reports a
 * constant.
 * @param {string} source
 * @returns {string}
 */
function replaceOneSpineCall(source) {
    const replaced = source.replace(
        "        journal: journalOf(closedSpine()),",
        "        journal: journalOf({ aaaaaaaaa: [], bbbbbbbbb: [] }),"
    );
    if (replaced === source) {
        throw new Error("Negative control could not replace the closedSpine call.");
    }
    return replaced;
}

/**
 * @param {string} label
 * @param {{ producers: string[], builders: string[], spineBuilders: string[], spineCalls: number, defined: string[] }} result
 * @returns {void}
 */
function report(label, result) {
    process.stdout.write(`${label}\n`);
    process.stdout.write(`  fixture producers driven: ${result.producers.join(", ")}\n`);
    process.stdout.write(`  aggregators (producers which only delegate): ${result.aggregators.join(", ")}\n`);
    process.stdout.write(`  builders defined: ${result.defined.length}\n`);
    process.stdout.write(`  builders reached: ${result.builders.length}\n`);
    process.stdout.write(`  built on closedSpine: ${result.spineBuilders.length} -> ${result.spineBuilders.join(", ")}\n`);
    process.stdout.write(`  closedSpine calls: ${result.spineCalls}\n`);
}

/**
 * @param {string} message
 * @returns {void}
 */
function fail(message) {
    process.stderr.write(`FAIL: ${message}\n`);
    process.exitCode = 1;
}

function main() {
    const control = process.argv.find((argument) => argument.startsWith("--control="));
    const source = fs.readFileSync(MODULE_PATH, "utf8");
    const measured = measure(source);
    report("measurement of backend/tests/interleaving_space.js as committed:", measured);

    const accounted = [...measured.builders, ...measured.aggregators].sort();
    if (accounted.join(",") !== measured.defined.join(",")) {
        fail(
            `execution accounted for [${accounted.join(", ")}] but the module defines [${measured.defined.join(", ")}]`
        );
        return;
    }
    if (measured.spineBuilders.length === 0) {
        fail("no builder was observed calling closedSpine; the instrument is blind");
        return;
    }
    if (control === undefined) {
        return;
    }

    if (control === "--control=positive") {
        const positive = measure(addBuilderBehindNewExport(source));
        report("positive control: one builder added behind one new export:", positive);
        if (positive.spineBuilders.length !== measured.spineBuilders.length + 1) {
            fail("the positive control did not raise the closedSpine count");
            return;
        }
        if (positive.builders.length !== measured.builders.length + 1) {
            fail("the positive control did not raise the builder count");
            return;
        }
        process.stdout.write(
            "positive control PASSED: a builder behind an export this instrument was not written against is seen.\n"
        );
        return;
    }

    if (control === "--control=negative") {
        const negative = measure(replaceOneSpineCall(source));
        report("negative control: one builder's closedSpine call replaced by a direct journal:", negative);
        if (negative.spineBuilders.length !== measured.spineBuilders.length - 1) {
            fail("the negative control did not lower the closedSpine count");
            return;
        }
        if (negative.builders.length !== measured.builders.length) {
            fail("the negative control moved the denominator");
            return;
        }
        if (negative.spineCalls !== measured.spineCalls - 1) {
            fail("the negative control did not lower the closedSpine call count");
            return;
        }
        process.stdout.write(
            "negative control PASSED: dropping one spine call drops the count by one and moves nothing else.\n"
        );
        return;
    }

    throw new Error(`Unknown control ${control}`);
}

/**
 * Measure the module as it stands on disk.
 * @returns {{ producers: string[], aggregators: string[], builders: string[], spineBuilders: string[], spineCalls: number, defined: string[] }}
 */
function measureAsCommitted() {
    return measure(fs.readFileSync(MODULE_PATH, "utf8"));
}

module.exports = { measureAsCommitted };

if (require.main === module) {
    main();
}
