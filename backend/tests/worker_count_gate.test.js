const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    DEFAULT_WORKERS,
    RejectedWorkerCountError,
    isRejectedWorkerCountError,
    maxWorkersForConfiguration,
    readWorkerCount,
    workerCeiling,
} = require("../../scripts");

const REPOSITORY_ROOT = path.join(__dirname, "..", "..");
const ROOT_MANIFEST = "package.json";
const ROOT_CONFIGURATION = "jest.config.js";

/** The shell script every start of the suite is expected to pass through. */
const GATE_SCRIPT_NAME = "check-jest-max-workers";

/** The path of that script, which is itself the gate rather than a caller of it. */
const GATE_SCRIPT_PATH = `scripts/${GATE_SCRIPT_NAME}`;

/** The variable whose value decides the worker count. */
const WORKER_COUNT_VARIABLE = "JEST_MAX_WORKERS";

/** A value that is a whole number of workers, written the way the shell writes it. */
const WORKER_COUNT_DECLARATION = new RegExp(`${WORKER_COUNT_VARIABLE}\\s*=\\s*[0-9][0-9]*`);

/**
 * Every file name Jest takes a configuration from, plus the ones it accepts when
 * it is pointed at one: a file named `jest.something.cjs` is not resolved on its
 * own, but a run can be pointed at it, and then it is the global configuration
 * of that run.
 */
const JEST_CONFIGURATION_PATTERN = /^jest\.[\w.-]*\.(?:js|cjs|mjs|ts|mts|cts)$/;

/**
 * The command-line arguments that take the worker count, the configuration or
 * the project list away from the grammar.
 *
 * Jest parses its options itself and exposes no hook that observes or refuses
 * them, so these arguments cannot be refused by any configuration file. What
 * this repository can do is refuse to use them: every surface a reader could
 * copy a command from is walked, and a surface that names one of them is a
 * finding.
 */
const FORBIDDEN_JEST_ARGUMENTS = ["--maxWorkers", "--runInBand", "--config", "--projects", "-c", "-w"];

/** The runners that start Jest as a program of their own. */
const JEST_RUNNERS = new Set(["bun", "node", "npx", "pnpm", "yarn"]);

/** The tokens that end the arguments of one command. */
const COMMAND_SEPARATORS = new Set(["|", "&", "&&", "||", ";", ">", ">>"]);

/** The code fence languages whose contents are commands. */
const SHELL_FENCE_LANGUAGES = ["", "console", "sh", "shell", "bash", "zsh", "fish"];

/**
 * Directories that hold no file of this repository, and are never descended into
 * while looking for one: they contain other people's installed code or this
 * repository's own output.
 *
 * @param {string} directory
 * @returns {boolean}
 */
function isUninterestingDirectory(directory) {
    return ["node_modules", ".git", "dist", "coverage", "build"].includes(directory);
}

/** The walk of the repository, done once because every assertion reads it. */
let repositoryFilePaths;

/**
 * Every file in the repository, by path relative to the repository root.
 *
 * The census is a walk rather than a list so that a file added later is covered
 * by the same assertions without this file being edited.
 *
 * @returns {string[]}
 */
function everyRepositoryFilePath() {
    if (repositoryFilePaths !== undefined) {
        return repositoryFilePaths;
    }

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
            } else {
                found.push(path.relative(REPOSITORY_ROOT, entryPath));
            }
        }
    }

    walk(REPOSITORY_ROOT);
    repositoryFilePaths = found.sort();

    return repositoryFilePaths;
}

/**
 * @param {string} relativePath
 * @returns {string}
 */
function readRepositoryFile(relativePath) {
    return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8");
}

/**
 * @param {string[]} paths
 * @returns {string[]}
 */
function pathsMatching(paths, pattern) {
    return paths.filter((relativePath) => pattern.test(relativePath));
}

/** @returns {string[]} */
function everyManifestPath() {
    return pathsMatching(everyRepositoryFilePath(), /(^|\/)package\.json$/);
}

/** @returns {string[]} */
function everyJestConfigurationPath() {
    return everyRepositoryFilePath().filter((relativePath) =>
        JEST_CONFIGURATION_PATTERN.test(path.basename(relativePath)));
}

/**
 * The files that start the suite on their own: the scripts folder, the workflows,
 * the makefile, the Dockerfiles and every shell script in the tree. A package
 * manifest is walked separately, because a script in it is an entry point of its
 * own with its own name.
 *
 * @returns {string[]}
 */
function everyAutomationPath() {
    const shellScript = /(?:\.sh|\.bash|\.zsh)$/;
    const buildFile = /^(?:[Gg][Nn][Uu][Mm]akefile|[Mm]akefile|[Dd]ockerfile([.-].*)?|.*\.dockerfile)$/;

    return everyRepositoryFilePath().filter((relativePath) => {
        if (relativePath.startsWith("scripts/")) {
            return true;
        }
        if (relativePath.startsWith(".github/workflows/")) {
            return true;
        }
        const name = path.basename(relativePath);
        return buildFile.test(name) || shellScript.test(name);
    });
}

/**
 * The documents a reader could copy a command out of.
 *
 * A record of a review is not one of them: it quotes the commands a reviewer
 * ran, and nothing executes it. The exclusion is a fixed list so that adding
 * another excluded document is a change to this file rather than a silent hole.
 */
const DOCUMENT_PREFIXES_EXCLUDED = ["docs/reviews/"];

/** @returns {string[]} */
function everyDocumentPath() {
    return everyRepositoryFilePath().filter((relativePath) => {
        if (!relativePath.endsWith(".md")) {
            return false;
        }
        return !DOCUMENT_PREFIXES_EXCLUDED.some((prefix) => relativePath.startsWith(prefix));
    });
}

/**
 * The source of a file with its comments removed.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The source of a file with its string literals replaced by empty ones.
 *
 * @param {string} source
 * @returns {string}
 */
function withoutStringLiterals(source) {
    return withoutComments(source)
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
    return text.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Whether a token names the Jest program. A file that merely begins with the same
 * letters is a different thing: `jest.config.js` is a configuration, `babel-jest`
 * is a transform and `jest-environment-jsdom` is an environment.
 *
 * @param {string} token
 * @returns {boolean}
 */
function namesJestProgram(token) {
    const unquoted = token.replace(/^['"]|['"]$/g, "");
    const name = unquoted.slice(unquoted.lastIndexOf("/") + 1);
    return ["jest", "jest.js", "jest.cjs", "jest.mjs"].includes(name);
}

/**
 * The index of the token that names the Jest program, or -1 when the text names
 * no Jest program.
 *
 * @param {string[]} tokens
 * @param {number} from
 * @returns {number}
 */
function jestProgramIndex(tokens, from) {
    if (namesJestProgram(tokens[from])) {
        return from;
    }
    if (JEST_RUNNERS.has(tokens[from]) && from + 1 < tokens.length && namesJestProgram(tokens[from + 1])) {
        return from + 1;
    }
    return -1;
}

/**
 * Every way the text starts Jest, with the arguments each start was given.
 *
 * @param {string} command
 * @returns {{ program: string, arguments: string[] }[]}
 */
function jestInvocations(command) {
    const tokens = tokenize(command);
    /** @type {{ program: string, arguments: string[] }[]} */
    const invocations = [];

    for (let index = 0; index < tokens.length; index += 1) {
        const program = jestProgramIndex(tokens, index);
        if (program < 0) {
            continue;
        }

        /** @type {string[]} */
        const argumentsList = [];
        let cursor = program + 1;
        while (cursor < tokens.length) {
            const token = tokens[cursor];
            if (token === "--" || COMMAND_SEPARATORS.has(token)) {
                break;
            }
            argumentsList.push(token.replace(/^['"]|['"]$/g, ""));
            cursor += 1;
        }

        invocations.push({ program: tokens[program], arguments: argumentsList });
        index = cursor;
    }

    return invocations;
}

/**
 * The commands a document shows a reader, which are the lines of a shell fence
 * and the lines a transcript prompts. Prose is not a command, and a flag named
 * in prose is not a flag passed to Jest.
 *
 * @param {string} source
 * @returns {string[]}
 */
function documentCommands(source) {
    /** @type {string[]} */
    const commands = [];
    let insideShellFence = false;

    for (const line of source.split("\n")) {
        const fence = /^\s*```(.*)$/.exec(line);
        if (fence !== null) {
            const language = fence[1].trim().toLowerCase();
            if (insideShellFence) {
                insideShellFence = false;
            } else {
                insideShellFence = SHELL_FENCE_LANGUAGES.includes(language);
            }
            continue;
        }
        if (insideShellFence || /^\s*\$\s+\S/.test(line)) {
            commands.push(line);
        }
    }

    return commands;
}

/**
 * The commands a build file, a workflow or a shell script runs, which are its
 * lines.
 *
 * @param {string} source
 * @returns {string[]}
 */
function fileCommands(source) {
    return source.split("\n");
}

/**
 * Every command this repository asks a reader, a workflow or a developer to run.
 *
 * @returns {{ where: string, command: string }[]}
 */
function everyCommand() {
    /** @type {{ where: string, command: string }[]} */
    const commands = [];

    for (const manifestPath of everyManifestPath()) {
        const manifest = JSON.parse(readRepositoryFile(manifestPath));
        for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
            if (typeof command === "string") {
                commands.push({ where: `${manifestPath} "${scriptName}"`, command });
            }
        }
    }

    for (const relativePath of everyAutomationPath()) {
        for (const command of fileCommands(readRepositoryFile(relativePath))) {
            commands.push({ where: relativePath, command });
        }
    }

    for (const relativePath of everyDocumentPath()) {
        for (const command of documentCommands(readRepositoryFile(relativePath))) {
            commands.push({ where: relativePath, command });
        }
    }

    return commands;
}

/**
 * @param {string} command
 * @returns {string[]} the arguments in `command` that take the worker count, the
 *   configuration or the project list away from the grammar.
 */
function forbiddenArguments(command) {
    /** @type {string[]} */
    const forbidden = [];

    for (const invocation of jestInvocations(command)) {
        for (const argument of invocation.arguments) {
            const name = argument.split("=")[0];
            if (FORBIDDEN_JEST_ARGUMENTS.includes(name)) {
                forbidden.push(`${invocation.program} ${argument}`);
            }
        }
    }

    return forbidden;
}

/**
 * @typedef {object} StartPoint
 * @property {string} name - how this entry point is addressed in a finding.
 * @property {string} text - the command this entry point runs.
 * @property {string} manifestPath - the manifest a package script name in this
 *   entry point resolves against.
 */

/** @returns {StartPoint[]} */
function everyStartPoint() {
    /** @type {StartPoint[]} */
    const startPoints = [];

    for (const manifestPath of everyManifestPath()) {
        const manifest = JSON.parse(readRepositoryFile(manifestPath));
        for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
            if (typeof command === "string") {
                startPoints.push({
                    name: `${manifestPath} "${scriptName}"`,
                    text: command,
                    manifestPath,
                });
            }
        }
    }

    for (const relativePath of everyAutomationPath()) {
        if (!relativePath.startsWith("scripts/")) {
            continue;
        }
        startPoints.push({
            name: relativePath,
            text: readRepositoryFile(relativePath),
            manifestPath: ROOT_MANIFEST,
        });
    }

    return startPoints;
}

/**
 * @param {string} argument
 * @returns {{ name: string, inlineValue: string | undefined }}
 */
function splitOption(argument) {
    const equalsSign = argument.indexOf("=");
    if (equalsSign < 0) {
        return { name: argument, inlineValue: undefined };
    }
    return { name: argument.slice(0, equalsSign), inlineValue: argument.slice(equalsSign + 1) };
}

/**
 * The name of the package script an npm invocation runs, with the options and
 * their values stepped over.
 *
 * @param {string[]} tokens
 * @returns {string | undefined}
 */
function scriptNameIn(tokens) {
    let awaitingValue = false;

    for (const token of tokens) {
        if (awaitingValue) {
            awaitingValue = false;
            continue;
        }
        if (token.startsWith("-")) {
            awaitingValue = splitOption(token).inlineValue === undefined;
            continue;
        }
        if (token === "run") {
            continue;
        }
        return token;
    }

    return undefined;
}

/**
 * The value an option was given inside a command, if it was given one.
 *
 * @param {string[]} tokens
 * @param {string} name
 * @returns {string | undefined}
 */
function optionValue(tokens, name) {
    for (let index = 0; index < tokens.length; index += 1) {
        const option = splitOption(tokens[index]);
        if (option.name !== name) {
            continue;
        }
        return option.inlineValue === undefined ? tokens[index + 1] : option.inlineValue;
    }
    return undefined;
}

/**
 * @param {string | undefined} directory
 * @returns {string | undefined} the manifest of the package rooted at `directory`.
 */
function manifestAt(directory) {
    let current = directory;

    while (current !== undefined && current.startsWith(REPOSITORY_ROOT)) {
        const candidate = path.join(current, "package.json");
        if (fs.existsSync(candidate)) {
            return path.relative(REPOSITORY_ROOT, candidate);
        }
        current = path.dirname(current);
    }

    return undefined;
}

/**
 * The start points a command reaches by name: the package scripts it runs and
 * the scripts in the scripts folder it calls.
 *
 * @param {string} text
 * @param {string} manifestPath
 * @param {StartPoint[]} startPoints
 * @returns {string[]}
 */
function referencedStartPoints(text, manifestPath, startPoints) {
    const tokens = tokenize(text);
    /** @type {string[]} */
    const names = [];

    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index] === "npm") {
            const rest = [];
            let cursor = index + 1;
            while (cursor < tokens.length && !COMMAND_SEPARATORS.has(tokens[cursor])) {
                rest.push(tokens[cursor]);
                cursor += 1;
            }
            const scriptToken = scriptNameIn(rest);
            const workspace = optionValue(rest, "-w") ?? optionValue(rest, "--workspace");
            const prefix = optionValue(rest, "--prefix");
            const resolved = manifestAt(prefix === undefined
                ? (workspace === undefined ? undefined : path.resolve(REPOSITORY_ROOT, workspace))
                : path.resolve(REPOSITORY_ROOT, prefix));
            const name = `${resolved ?? manifestPath} "${scriptToken ?? ""}"`;
            if (startPoints.some((startPoint) => startPoint.name === name)) {
                names.push(name);
            }
            index = cursor - 1;
            continue;
        }

        const unquoted = tokens[index].replace(/^['"]|['"]$/g, "");
        const normalized = unquoted.replace(/^\.\.\//, "").replace(/^\.\//, "");
        if (normalized.startsWith("scripts/") && startPoints.some((point) => point.name === normalized)) {
            names.push(normalized);
        }
    }

    return names;
}

/**
 * Which start points start Jest, and which of those reach the gate.
 *
 * Both questions are answered by a least fixed point over the name references, so
 * a start point counts as starting Jest when it names one that starts Jest, and
 * as reaching the gate when it names one that reaches it.
 *
 * @param {StartPoint[]} startPoints
 * @returns {{ startsJest: Set<string>, reachesGate: Set<string> }}
 */
function analyseStartPoints(startPoints) {
    const references = new Map(startPoints.map((startPoint) => [
        startPoint.name,
        referencedStartPoints(startPoint.text, startPoint.manifestPath, startPoints),
    ]));

    const startsJest = new Set();
    const reachesGate = new Set();
    let changed = true;

    while (changed) {
        changed = false;
        for (const startPoint of startPoints) {
            const referenced = references.get(startPoint.name) ?? [];
            const named = referenced.some((name) => startsJest.has(name))
                || jestInvocations(startPoint.text).length > 0;
            const gated = startPoint.name === GATE_SCRIPT_PATH
                || startPoint.text.includes(GATE_SCRIPT_NAME)
                || referenced.some((name) => reachesGate.has(name));
            if (named && !startsJest.has(startPoint.name)) {
                startsJest.add(startPoint.name);
                changed = true;
            }
            if (gated && !reachesGate.has(startPoint.name)) {
                reachesGate.add(startPoint.name);
                changed = true;
            }
        }
    }

    return { startsJest, reachesGate };
}

/**
 * @param {string} command
 * @param {string} manifestPath
 * @param {StartPoint[]} startPoints
 * @param {Set<string>} reachesGate
 * @returns {boolean}
 */
function reachesGatedStartPoint(command, manifestPath, startPoints, reachesGate) {
    return referencedStartPoints(command, manifestPath, startPoints)
        .some((name) => reachesGate.has(name));
}

/**
 * Every directory that holds a file Jest would collect as a test.
 *
 * @returns {string[]}
 */
function everyDirectoryHoldingTests() {
    const testFile = /\.(?:test|spec)\.(?:jsx?|tsx?)$/;
    const directories = new Set();

    for (const relativePath of everyRepositoryFilePath()) {
        if (testFile.test(path.basename(relativePath))) {
            directories.add(path.dirname(relativePath));
        }
    }

    return [...directories].sort();
}

/**
 * The Jest configuration that governs a directory: the nearest one at or above
 * it. The repository configuration governs nothing on its own when the run it
 * belongs to names its projects, so a directory it covers is claimed by the
 * project entry instead.
 *
 * @param {string} relativeDirectory
 * @returns {string | undefined}
 */
function governingConfiguration(relativeDirectory) {
    const repositoryFilePaths = everyRepositoryFilePath();
    let current = relativeDirectory;

    while (true) {
        const candidate = repositoryFilePaths.find((relativePath) => {
            const directory = path.dirname(relativePath);
            return directory === current && JEST_CONFIGURATION_PATTERN.test(path.basename(relativePath));
        });
        if (candidate !== undefined && candidate !== ROOT_CONFIGURATION) {
            return candidate;
        }
        if (current === ".") {
            return undefined;
        }
        current = path.dirname(current);
    }
}

/**
 * The directories the repository configuration names as projects, as absolute
 * real paths.
 *
 * @returns {string[]}
 */
function repositoryProjectDirectories() {
    const configuration = require(path.join(REPOSITORY_ROOT, ROOT_CONFIGURATION));
    /** @type {string[]} */
    const directories = [];

    for (const project of configuration.projects ?? []) {
        const relative = project.replace("<rootDir>/", "");
        const absolute = path.resolve(REPOSITORY_ROOT, relative);
        directories.push(fs.realpathSync(fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute)));
    }

    return directories;
}

/**
 * @param {string} absolute
 * @param {string} relativeDirectory
 * @returns {boolean}
 */
function containsDirectory(absolute, relativeDirectory) {
    const resolved = path.resolve(REPOSITORY_ROOT, relativeDirectory);
    return resolved === absolute || resolved.startsWith(absolute + path.sep);
}

/**
 * The directories that hold test files and no Jest configuration collects them.
 *
 * Each one is recorded in the test that follows with the reason it is outside
 * Jest, so that a directory added without either a configuration or a decision is
 * a finding rather than a silence.
 */
const TEST_DIRECTORIES_OUTSIDE_JEST = {
    "tools/eslint-plugin-volodyslav/tests": "run one file at a time with node by `npm run rules:test`",
};

const PROBE_SOURCE = [
    'const configuration = require(process.env["PROBE_CONFIGURATION"]);',
    "process.stdout.write(JSON.stringify({",
    '    statesMaxWorkers: Object.hasOwn(configuration, "maxWorkers"),',
    "    maxWorkers: configuration.maxWorkers,",
    "}));",
].join("\n");

describe("the worker count of the suite", () => {
    it("refuses every value that is not a worker count", () => {
        const refusedValues = ["", "0", "00", "-1", "+4", "3.5", "4.0", "1e2", " 4", "4 ", "abc", "4a", "0x4", "١"];
        const statuses = refusedValues.map((value) => readWorkerCount(value, workerCeiling()).status);
        expect(statuses).toEqual(refusedValues.map(() => "rejected"));
    });

    it("accepts a whole number of one or more workers", () => {
        expect(readWorkerCount("1", 32)).toEqual({ status: "accepted", workers: 1 });
        expect(readWorkerCount("4", 32)).toEqual({ status: "accepted", workers: 4 });
        expect(readWorkerCount("08", 32)).toEqual({ status: "accepted", workers: 8 });
    });

    it("accepts no count above the parallelism this host has", () => {
        expect(readWorkerCount("32", 32)).toEqual({ status: "accepted", workers: 32 });
        expect(readWorkerCount("33", 32).status).toBe("rejected");
        expect(readWorkerCount("64", 32).status).toBe("rejected");
        expect(readWorkerCount("99999999999999999999", 32).status).toBe("rejected");
        expect(readWorkerCount("64", 32).reason).toMatch(/more workers than this host has/);
    });

    it("refuses a count above the parallelism this host reports", () => {
        const ceiling = workerCeiling();
        expect(maxWorkersForConfiguration({ [WORKER_COUNT_VARIABLE]: String(ceiling) })).toBe(ceiling);
        expect(() => maxWorkersForConfiguration({ [WORKER_COUNT_VARIABLE]: String(ceiling + 1) }))
            .toThrow(/more workers than this host has/);
    });

    it("runs the suite at one worker when the variable is unset", () => {
        expect(readWorkerCount(undefined, workerCeiling())).toEqual({ status: "unset" });
        expect(maxWorkersForConfiguration({})).toBe(DEFAULT_WORKERS);
        expect(DEFAULT_WORKERS).toBeLessThanOrEqual(workerCeiling());
    });

    it("refuses a guessed worker count out of a Jest configuration", () => {
        expect(() => maxWorkersForConfiguration({ [WORKER_COUNT_VARIABLE]: "abc" })).toThrow(
            /must be a whole number of workers between 1 and/
        );

        let refused;
        try {
            maxWorkersForConfiguration({ [WORKER_COUNT_VARIABLE]: "abc" });
        } catch (error) {
            refused = error;
        }

        expect(isRejectedWorkerCountError(refused)).toBe(true);
        expect(refused.message).toMatch(/"abc"/);
        expect(refused).toBeInstanceOf(RejectedWorkerCountError);
    });
});

describe("the configurations of this repository", () => {
    const configurations = everyJestConfigurationPath();

    it("has exactly the three that resolve through the grammar", () => {
        expect(configurations).toEqual([
            "backend/jest.config.js",
            "frontend/jest.config.js",
            "jest.config.js",
        ]);
    });

    it("resolves the worker count of every Jest configuration through the one grammar", () => {
        for (const configuration of configurations) {
            const source = withoutComments(readRepositoryFile(configuration));
            expect(source).toContain("maxWorkersForConfiguration");
            expect(source).not.toMatch(new RegExp(WORKER_COUNT_VARIABLE));
        }
    });

    it("resolves the count on every path, including the path that states nothing", () => {
        const unconditional = /maxWorkers:\s*maxWorkersForConfiguration\(process\.env\)/;
        const observations = configurations.map((configuration) => {
            const source = withoutComments(readRepositoryFile(configuration));
            const resolution = source.indexOf("maxWorkersForConfiguration(process.env)");
            const decision = source.indexOf("isGlobalConfigurationOfThisRun(");

            return {
                configuration,
                statesTheCountOnlyInItsOwnRun: decision >= 0,
                resolvesTheCount: resolution >= 0
                    && (decision >= 0 ? resolution < decision : unconditional.test(source)),
            };
        });

        expect(observations.filter((observation) => !observation.resolvesTheCount)).toEqual([]);
        expect(observations.map((observation) => [
            observation.configuration,
            observation.statesTheCountOnlyInItsOwnRun,
        ])).toEqual([
            ["backend/jest.config.js", true],
            ["frontend/jest.config.js", true],
            ["jest.config.js", false],
        ]);
    });

    it("reads the count from the scripts surface rather than a second grammar", () => {
        for (const configuration of configurations) {
            const source = withoutComments(readRepositoryFile(configuration));
            expect(source).toMatch(/require\("\.\.?\/scripts"\)/);
        }
    });
});

describe("the ways a configuration of this repository can be read", () => {
    let probeDirectory;

    beforeAll(() => {
        probeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-count-gate-"));
        fs.writeFileSync(path.join(probeDirectory, "read-configuration.cjs"), PROBE_SOURCE);
    });

    afterAll(() => {
        fs.rmSync(probeDirectory, { recursive: true, force: true });
    });

    /**
     * Read one configuration the way a caller reached it: from a working
     * directory, with the arguments of the command line, and with an environment
     * that carries the worker count or carries nothing.
     *
     * The reads run at the same time, because a refusal that is measured by
     * waiting for one process after another is a refusal that eventually fails on
     * a loaded machine rather than on a wrong answer.
     *
     * @param {{ configuration: string, workingDirectory: string, arguments: string[], workerCount: string | undefined }} request
     * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
     */
    function readConfiguration(request) {
        const environment = { ...process.env, PROBE_CONFIGURATION: path.join(REPOSITORY_ROOT, request.configuration) };
        if (request.workerCount === undefined) {
            delete environment[WORKER_COUNT_VARIABLE];
        } else {
            environment[WORKER_COUNT_VARIABLE] = request.workerCount;
        }

        const probe = path.join(probeDirectory, "read-configuration.cjs");
        const workingDirectory = path.join(REPOSITORY_ROOT, request.workingDirectory);

        return new Promise((resolve) => {
            const child = spawn(process.execPath, [probe, ...request.arguments], { cwd: workingDirectory, env: environment });
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => { stdout += chunk; });
            child.stderr.on("data", (chunk) => { stderr += chunk; });
            child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
        });
    }

    const configurations = [
        { configuration: ROOT_CONFIGURATION, isGlobalOfARepositoryRun: true },
        { configuration: "backend/jest.config.js", isGlobalOfARepositoryRun: false },
        { configuration: "frontend/jest.config.js", isGlobalOfARepositoryRun: false },
    ];

    it.each(configurations)(
        "refuses a rejected count however $configuration is read",
        async ({ configuration }) => {
            const ownDirectory = path.dirname(configuration);
            const ways = [
                { workingDirectory: ".", arguments: [] },
                { workingDirectory: ".", arguments: ["--config", configuration] },
                { workingDirectory: ".", arguments: ["--projects", ownDirectory] },
                { workingDirectory: ownDirectory, arguments: [] },
                { workingDirectory: ".", arguments: ["--config", '{"maxWorkers":31}'] },
            ];

            const outcomes = await Promise.all(ways.map(async (way) => {
                const result = await readConfiguration({ configuration, ...way, workerCount: "abc" });
                return {
                    way: `${configuration} from ${way.workingDirectory} with ${way.arguments.join(" ")}`,
                    acceptedTheRun: result.status === 0,
                    namedTheVariable: result.stderr.includes("RejectedWorkerCountError"),
                };
            }));

            expect(outcomes).toEqual(outcomes.map((outcome) => ({
                ...outcome,
                acceptedTheRun: false,
                namedTheVariable: true,
            })));
        }
    );

    it.each(configurations)(
        "states the count of $configuration only in the run it is the global configuration of",
        async ({ configuration, isGlobalOfARepositoryRun }) => {
            const ownDirectory = path.dirname(configuration);
            const reads = await Promise.all([
                readConfiguration({
                    configuration, workingDirectory: ".", arguments: ["--config", configuration], workerCount: "4",
                }),
                readConfiguration({
                    configuration, workingDirectory: ownDirectory, arguments: [], workerCount: "4",
                }),
                readConfiguration({
                    configuration, workingDirectory: ".", arguments: [], workerCount: "4",
                }),
                readConfiguration({
                    configuration, workingDirectory: ".", arguments: [], workerCount: undefined,
                }),
            ]);
            const [statedAsGlobal, statedInItsOwnDirectory, readAsAProject, unsetWithoutStatements] = reads;

            expect(JSON.parse(statedAsGlobal.stdout)).toEqual({ statesMaxWorkers: true, maxWorkers: 4 });
            expect(JSON.parse(statedInItsOwnDirectory.stdout)).toEqual({ statesMaxWorkers: true, maxWorkers: 4 });
            expect(JSON.parse(readAsAProject.stdout).statesMaxWorkers).toBe(isGlobalOfARepositoryRun);
            expect(JSON.parse(unsetWithoutStatements.stdout))
                .toEqual({
                    statesMaxWorkers: isGlobalOfARepositoryRun,
                    maxWorkers: isGlobalOfARepositoryRun ? 1 : undefined,
                });
        }
    );
});

describe("every way of starting the suite", () => {
    it("enumerates the surfaces it claims to walk", () => {
        const files = everyRepositoryFilePath();
        expect(files.length).toBeGreaterThan(500);
        expect(files.some((relativePath) => relativePath.includes("node_modules"))).toBe(false);
        expect(everyManifestPath().length).toBeGreaterThanOrEqual(3);
        expect(everyJestConfigurationPath()).toEqual([
            "backend/jest.config.js",
            "frontend/jest.config.js",
            "jest.config.js",
        ]);
        expect(everyAutomationPath().some((path_) => path_.startsWith(".github/workflows/"))).toBe(true);
        expect(everyAutomationPath()).toContain("Makefile");
        expect(everyAutomationPath()).toContain("Dockerfile");
        expect(everyAutomationPath().some((path_) => path_.startsWith("scripts/"))).toBe(true);
        expect(everyDocumentPath()).toContain("README.md");
        expect(everyDocumentPath()).toContain("AGENTS.md");
        expect(everyDocumentPath().some((path_) => path_.startsWith("docs/reviews/"))).toBe(false);
        expect(everyCommand().length).toBeGreaterThan(10);
    });

    it("finds a Jest invocation and the arguments it was given", () => {
        const invocations = jestInvocations('run: TZ=UTC npx jest --maxWorkers=31 && echo done');
        expect(invocations).toHaveLength(1);
        expect(invocations[0].program).toBe("jest");
        expect(invocations[0].arguments).toEqual(["--maxWorkers=31"]);

        expect(jestInvocations("bun jest")).toHaveLength(1);
        expect(jestInvocations("./node_modules/.bin/jest --silent")).toHaveLength(1);
        expect(jestInvocations("npm test")).toHaveLength(0);
        expect(jestInvocations("Jest & React Testing Library")).toHaveLength(0);
        expect(jestInvocations("babel-jest")).toHaveLength(0);
        expect(jestInvocations("npm run test-only")).toHaveLength(0);
        expect(jestInvocations("run: npx jest -- --maxWorkers=31").length).toBe(1);
    });

    it("names the arguments that take the worker count away from the grammar", () => {
        expect(forbiddenArguments("npx jest --maxWorkers=31")).toEqual(["jest --maxWorkers=31"]);
        expect(forbiddenArguments("npx jest -w 31")).toEqual(["jest -w"]);
        expect(forbiddenArguments("npx jest --config backend/jest.config.js")).toEqual(["jest --config"]);
        expect(forbiddenArguments("npx jest --projects frontend")).toEqual(["jest --projects"]);
        expect(forbiddenArguments("npx jest --runInBand")).toEqual(["jest --runInBand"]);
        expect(forbiddenArguments("npm run build -w frontend")).toEqual([]);
        expect(forbiddenArguments("npx jest --showConfig")).toEqual([]);
        expect(forbiddenArguments("npx jest")).toEqual([]);
    });

    it("has no command that names a worker count, a configuration or a project list on Jest's command line", () => {
        const findings = [];

        for (const { where, command } of everyCommand()) {
            for (const forbidden of forbiddenArguments(command)) {
                findings.push(`${where}: ${forbidden}`);
            }
        }

        expect(findings).toEqual([]);
    });

    it("reads a flag named in prose as prose, and a flag in a shell fence as a flag", () => {
        const document = [
            "Jest answers the count of a run through --maxWorkers.",
            "",
            "```bash",
            "npm test",
            "```",
        ].join("\n");

        expect(documentCommands(document)).toEqual(["npm test"]);

        const transcript = ["$ npx jest --maxWorkers=31", "done"].join("\n");
        expect(forbiddenArguments(documentCommands(transcript)[0])).toEqual(["jest --maxWorkers=31"]);
    });

    it("has no command of its own outside the grammar", () => {
        const startPoints = everyStartPoint();
        const { startsJest, reachesGate } = analyseStartPoints(startPoints);
        const ungated = [...startsJest].filter((name) => !reachesGate.has(name));

        expect(ungated).toEqual([]);
        expect(startsJest.size).toBeGreaterThan(0);
        expect([...startsJest].sort()).toEqual(expect.arrayContaining([
            'frontend/package.json "test"',
            'package.json "test"',
            'package.json "test-only"',
            "scripts/run-jest",
            "scripts/run-tests",
        ]));
    });

    it("has no workflow, Dockerfile, Makefile or shell script that starts Jest beside the gate", () => {
        const startPoints = everyStartPoint();
        const { reachesGate } = analyseStartPoints(startPoints);
        const findings = [];

        for (const relativePath of everyAutomationPath()) {
            if (relativePath.startsWith("scripts/")) {
                continue;
            }
            for (const command of fileCommands(readRepositoryFile(relativePath))) {
                for (const invocation of jestInvocations(command)) {
                    if (command.includes(GATE_SCRIPT_NAME)) {
                        continue;
                    }
                    if (reachesGatedStartPoint(command, ROOT_MANIFEST, startPoints, reachesGate)) {
                        continue;
                    }
                    findings.push(`${relativePath}: ${invocation.program}`);
                }
            }
        }

        expect(findings).toEqual([]);
    });

    it("routes the frontend workspace script through the gate", () => {
        const manifest = JSON.parse(readRepositoryFile("frontend/package.json"));
        expect(manifest.scripts.test).toContain("sh ../scripts/check-jest-max-workers");
        expect(manifest.scripts.test).toMatch(/jest(\s|$)/);
    });

    it("gives every directory that holds tests a configuration that resolves the count", () => {
        const projectDirectories = repositoryProjectDirectories();
        const unclaimed = everyDirectoryHoldingTests().filter((relativeDirectory) => {
            if (governingConfiguration(relativeDirectory) !== undefined) {
                return false;
            }
            return !projectDirectories.some((absolute) => containsDirectory(absolute, relativeDirectory));
        });

        expect(unclaimed).toEqual(Object.keys(TEST_DIRECTORIES_OUTSIDE_JEST).sort());
    });

    it("runs every directory it declared outside Jest without Jest", () => {
        for (const relativeDirectory of Object.keys(TEST_DIRECTORIES_OUTSIDE_JEST)) {
            let current = path.join(REPOSITORY_ROOT, relativeDirectory);
            while (!fs.existsSync(path.join(current, "package.json"))) {
                current = path.dirname(current);
            }
            const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"));
            expect(typeof manifest.scripts.test).toBe("string");
            expect(jestInvocations(manifest.scripts.test)).toEqual([]);
        }
    });

    it("states the grammar once, in the module every caller reads", () => {
        expect(readRepositoryFile("scripts/check-jest-max-workers")).toContain("jest-max-workers.js");
        expect(readRepositoryFile("scripts/jest-max-workers.js"))
            .not.toMatch(new RegExp(`${WORKER_COUNT_VARIABLE}[^\\n]*\\bcase\\b`));
        expect(readRepositoryFile("scripts/check-jest-max-workers"))
            .not.toMatch(new RegExp(`${WORKER_COUNT_VARIABLE}[^\\n]*\\bcase\\b`));
    });

    it("names no worker count in a file of this repository", () => {
        const exemptions = [
            "backend/tests/worker_count_gate.test.js",
            "scripts/jest-max-workers.js",
        ];
        const declaring = everyRepositoryFilePath()
            .filter((relativePath) => !exemptions.includes(relativePath))
            .filter((relativePath) => WORKER_COUNT_DECLARATION.test(readRepositoryFile(relativePath)));

        expect(declaring).toEqual([]);
    });

    it("states no worker count, no configuration and no project list outside a string literal of itself", () => {
        const outside = withoutStringLiterals(fs.readFileSync(__filename, "utf8"));
        const tokens = tokenize(outside);

        expect(tokens.filter((token) => FORBIDDEN_JEST_ARGUMENTS.includes(token))).toEqual([]);
        expect(tokens.filter((token) => namesJestProgram(token))).toEqual([]);
        expect(tokens.filter((token) => WORKER_COUNT_DECLARATION.test(token))).toEqual([]);
    });
});
