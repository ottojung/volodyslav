/**
 * Tests that the shipped entry point configures the deployment sources the
 * Journal 3 lifecycle consumes.
 *
 * `database-lifecycle.md` §4 and `incremental-graph-journal-migrations.md` §4
 * carry the installation-recovery and canonical-bootstrap sources as deployment
 * configuration. The backend entry point forwards that configuration to the root
 * capabilities, and the shipped deployment wrapper loads it from the module the
 * deployment names. These tests exercise both halves and fail if the entry point
 * stops forwarding the configuration.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../src/capabilities/root", () => ({
    make: jest.fn(() => ({
        logger: {
            logError: jest.fn(),
            logInfo: jest.fn(),
            logDebug: jest.fn(),
            printf: jest.fn(),
        },
        exiter: { exit: jest.fn() },
    })),
}));

jest.mock("../src/server", () => ({
    start: jest.fn(() => async () => undefined),
}));

const root = require("../src/capabilities/root");
const { entry } = require("../src/index");
const { makeDeploymentSources } = require("../../scripts/run-entry.js");

/**
 * Run `body` with `process.argv` set to a `start` invocation.
 *
 * @param {() => Promise<void>} body
 * @returns {Promise<void>}
 */
async function withStartArgument(body) {
    const previous = process.argv;
    process.argv = ["node", "index.js", "start"];
    try {
        await body();
    } finally {
        process.argv = previous;
    }
}

/**
 * Run `body` with `VOLODYSLAV_DEPLOYMENT_SOURCES` set to `value`.
 *
 * @param {string | undefined} value
 * @param {() => void} body
 * @returns {void}
 */
function withDeploymentSourcesVariable(value, body) {
    const previous = process.env.VOLODYSLAV_DEPLOYMENT_SOURCES;
    if (value === undefined) {
        delete process.env.VOLODYSLAV_DEPLOYMENT_SOURCES;
    } else {
        process.env.VOLODYSLAV_DEPLOYMENT_SOURCES = value;
    }
    try {
        body();
    } finally {
        if (previous === undefined) {
            delete process.env.VOLODYSLAV_DEPLOYMENT_SOURCES;
        } else {
            process.env.VOLODYSLAV_DEPLOYMENT_SOURCES = previous;
        }
    }
}

/**
 * Write a deployment sources module exporting `makeDeploymentSources`.
 *
 * @param {string} source
 * @returns {{ file: string, cleanup: () => void }}
 */
function writeDeploymentSourcesModule(source) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deployment-sources-"));
    const file = path.join(directory, "deployment-sources.js");
    fs.writeFileSync(file, source);
    return {
        file,
        cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
}

describe("the backend entry point forwards deployment configuration", () => {
    test("entry passes the deployment sources through to the root capabilities", async () => {
        const options = {
            cohortBootstrapSource: { tag: "cohort" },
            installationRecoverySource: { tag: "recovery" },
        };
        root.make.mockClear();

        await withStartArgument(() => entry(options));

        expect(root.make).toHaveBeenCalledTimes(1);
        expect(root.make).toHaveBeenCalledWith(options);
    });

    test("entry without configuration still asks the root capabilities for none", async () => {
        root.make.mockClear();

        await withStartArgument(() => entry());

        expect(root.make).toHaveBeenCalledTimes(1);
        expect(root.make).toHaveBeenCalledWith(undefined);
    });
});

describe("the deployment wrapper loads the deployment sources", () => {
    test("no named module means no deployment sources", () => {
        withDeploymentSourcesVariable(undefined, () => {
            expect(makeDeploymentSources()).toEqual({});
        });
    });

    test("the named module supplies both sources unchanged", () => {
        const module = writeDeploymentSourcesModule(
            "module.exports = {\n" +
                "    makeDeploymentSources: () => ({\n" +
                "        cohortBootstrapSource: { tag: 'cohort' },\n" +
                "        installationRecoverySource: { tag: 'recovery' },\n" +
                "    }),\n" +
                "};\n"
        );
        try {
            withDeploymentSourcesVariable(module.file, () => {
                const options = makeDeploymentSources();
                expect(options.cohortBootstrapSource).toEqual({ tag: "cohort" });
                expect(options.installationRecoverySource).toEqual({ tag: "recovery" });
            });
        } finally {
            module.cleanup();
        }
    });

    test("a module without a factory is refused", () => {
        const module = writeDeploymentSourcesModule("module.exports = {};\n");
        try {
            withDeploymentSourcesVariable(module.file, () => {
                expect(() => makeDeploymentSources()).toThrow(/makeDeploymentSources function/);
            });
        } finally {
            module.cleanup();
        }
    });

    test("a factory returning a non-object is refused", () => {
        const module = writeDeploymentSourcesModule(
            "module.exports = { makeDeploymentSources: () => null };\n"
        );
        try {
            withDeploymentSourcesVariable(module.file, () => {
                expect(() => makeDeploymentSources()).toThrow(/not an object/);
            });
        } finally {
            module.cleanup();
        }
    });
});
