const fs = require("fs");
const path = require("path");
const {
    RejectedWorkerCountError,
    isRejectedWorkerCountError,
    maxWorkersForConfiguration,
    readWorkerCount,
} = require("../../scripts");

const REPOSITORY_ROOT = path.join(__dirname, "..", "..");

/**
 * Directories that hold a package of this repository and are never descended
 * into while looking for one: they contain other people's installed code.
 *
 * @param {string} directory
 * @returns {boolean}
 */
function isUninterestingDirectory(directory) {
    return ["node_modules", ".git", "dist", "coverage", "build"].includes(directory);
}

/**
 * Every package.json in the repository, by path relative to the repository root.
 *
 * The census is a walk rather than a list so that a package added later is
 * covered by the same assertions without this file being edited.
 *
 * @returns {string[]}
 */
function everyPackageManifestPath() {
    /** @type {string[]} */
    const found = [];

    /**
     * @param {string} directory
     * @returns {void}
     */
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory() && isUninterestingDirectory(entry.name)) {
                continue;
            }
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(entryPath);
            } else if (entry.name === "package.json") {
                found.push(path.relative(REPOSITORY_ROOT, entryPath));
            }
        }
    }

    walk(REPOSITORY_ROOT);

    return found.sort();
}

/**
 * Every Jest configuration in the repository, by path relative to the root.
 *
 * @returns {string[]}
 */
function everyJestConfigurationPath() {
    /** @type {string[]} */
    const found = [];

    /**
     * @param {string} directory
     * @returns {void}
     */
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory() && isUninterestingDirectory(entry.name)) {
                continue;
            }
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(entryPath);
            } else if (entry.name === "jest.config.js") {
                found.push(path.relative(REPOSITORY_ROOT, entryPath));
            }
        }
    }

    walk(REPOSITORY_ROOT);

    return found.sort();
}

/**
 * @param {string} relativePath
 * @returns {string}
 */
function readRepositoryFile(relativePath) {
    return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8");
}

/**
 * The source of a file with its comments removed.
 *
 * A configuration is allowed to name the variable while explaining it; what it
 * may not do is read it. Only executable text decides how a worker count is
 * resolved, so only executable text is examined.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("the worker count of the suite", () => {
    it("refuses every value that is not a worker count", () => {
        const refusedValues = ["", "0", "00", "-1", "+4", "3.5", "4.0", "1e2", " 4", "4 ", "abc", "4a", "0x4", "١"];
        const acceptedResults = refusedValues.map((value) => readWorkerCount(value).status);
        expect(acceptedResults).toEqual(refusedValues.map(() => "rejected"));
    });

    it("accepts a whole number of one or more workers", () => {
        expect(readWorkerCount("1")).toEqual({ status: "accepted", workers: 1 });
        expect(readWorkerCount("4")).toEqual({ status: "accepted", workers: 4 });
        expect(readWorkerCount("08")).toEqual({ status: "accepted", workers: 8 });
    });

    it("runs the suite at one worker when the variable is unset", () => {
        expect(readWorkerCount(undefined)).toEqual({ status: "unset" });
        expect(maxWorkersForConfiguration({})).toBe(1);
    });

    it("refuses a guessed worker count out of a Jest configuration", () => {
        expect(() => maxWorkersForConfiguration({ JEST_MAX_WORKERS: "abc" })).toThrow(
            /JEST_MAX_WORKERS must be a whole number of 1 or more/
        );

        let refused;
        try {
            maxWorkersForConfiguration({ JEST_MAX_WORKERS: "abc" });
        } catch (error) {
            refused = error;
        }

        expect(isRejectedWorkerCountError(refused)).toBe(true);
        expect(refused.message).toMatch(/"abc"/);
        expect(refused).toBeInstanceOf(RejectedWorkerCountError);
    });
});

describe("every way of starting the suite", () => {
    it("has no package script that starts Jest outside the gate", () => {
        /** @type {string[]} */
        const unguarded = [];

        for (const manifestPath of everyPackageManifestPath()) {
            const manifest = JSON.parse(readRepositoryFile(manifestPath));
            for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
                if (typeof command !== "string") {
                    continue;
                }
                const startsJest = /(^|[\s&|(])((bun|npx|node\s+\S*jest)\s+)?jest(\s|$)/.test(command);
                if (startsJest && !command.includes("check-jest-max-workers")) {
                    unguarded.push(`${manifestPath} "${scriptName}": ${command}`);
                }
            }
        }

        expect(unguarded).toEqual([]);
    });

    it("routes the frontend workspace script through the gate", () => {
        const manifest = JSON.parse(readRepositoryFile("frontend/package.json"));
        expect(manifest.scripts.test).toContain("sh ../scripts/check-jest-max-workers");
        expect(manifest.scripts.test).toMatch(/jest(\s|$)/);
    });

    it("resolves the worker count of every Jest configuration through the one grammar", () => {
        const configurationPaths = everyJestConfigurationPath();

        expect(configurationPaths).toEqual([
            "backend/jest.config.js",
            "frontend/jest.config.js",
            "jest.config.js",
        ]);

        for (const configurationPath of configurationPaths) {
            const source = withoutComments(readRepositoryFile(configurationPath));
            expect(source).toContain("maxWorkersForConfiguration");
            expect(source).not.toMatch(/JEST_MAX_WORKERS/);
        }
    });

    it("states the grammar once, in the module every caller reads", () => {
        expect(readRepositoryFile("scripts/check-jest-max-workers")).toContain("jest-max-workers.js");
        expect(readRepositoryFile("scripts/jest-max-workers.js")).not.toMatch(/JEST_MAX_WORKERS[^\n]*\bcase\b/);
    });
});