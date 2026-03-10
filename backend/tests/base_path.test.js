const path = require("path");
const fs = require("fs");
const os = require("os");

describe("getBasePath", () => {
    let tmpDir;
    let basePathModule;

    beforeEach(() => {
        // Each test gets a fresh module instance so the cache is cleared
        jest.resetModules();
        basePathModule = require("../src/base_path");
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jest-base-path-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeCapabilities(basePathFileContent) {
        const fileExists = basePathFileContent !== null;
        return {
            environment: {
                basePath: jest.fn().mockReturnValue(""),
            },
            checker: {
                instantiate: jest.fn(async (filePath) => {
                    if (!fileExists) {
                        throw new Error(`File not found: ${filePath}`);
                    }
                    return { path: filePath };
                }),
            },
            reader: {
                readFileAsText: jest.fn(async () => {
                    if (!fileExists) {
                        throw new Error("File not found");
                    }
                    return basePathFileContent;
                }),
            },
        };
    }

    it("returns empty string when BASE_PATH file does not exist", async () => {
        const capabilities = makeCapabilities(null);
        const result = await basePathModule.getBasePath(capabilities);
        expect(result).toBe("");
    });

    it("returns the base path from the BASE_PATH file", async () => {
        const capabilities = makeCapabilities("/some/path/1");
        const result = await basePathModule.getBasePath(capabilities);
        expect(result).toBe("/some/path/1");
    });

    it("trims whitespace from the BASE_PATH file content", async () => {
        const capabilities = makeCapabilities("  /some/path/1\n");
        const result = await basePathModule.getBasePath(capabilities);
        expect(result).toBe("/some/path/1");
    });

    it("memoizes the result after the first call", async () => {
        const capabilities = makeCapabilities("/some/path/1");
        const first = await basePathModule.getBasePath(capabilities);
        const second = await basePathModule.getBasePath(capabilities);
        expect(first).toBe("/some/path/1");
        expect(second).toBe("/some/path/1");
        // checker.instantiate should only be called once
        expect(capabilities.checker.instantiate).toHaveBeenCalledTimes(1);
    });

    it("extracts pathname from a full URL", async () => {
        const capabilities = makeCapabilities("https://example.com/app");
        const result = await basePathModule.getBasePath(capabilities);
        expect(result).toBe("/app");
    });

    it("extracts pathname from a full URL with trailing slash", async () => {
        const capabilities = makeCapabilities("https://example.com/app/");
        const result = await basePathModule.getBasePath(capabilities);
        expect(result).toBe("/app");
    });

    it("returns empty string for a full URL with no path", async () => {
        const capabilities = makeCapabilities("https://example.com");
        const result = await basePathModule.getBasePath(capabilities);
        expect(result).toBe("");
    });

    it("returns empty string for empty file", async () => {
        const capabilities = makeCapabilities("");
        const result = await basePathModule.getBasePath(capabilities);
        expect(result).toBe("");
    });

    it("prioritizes environment.basePath() over file when non-empty", async () => {
        // Even if a file with a different path exists, environment.basePath() wins
        const capabilities = makeCapabilities("/file/path");
        capabilities.environment.basePath = jest.fn().mockReturnValue("/env/path");
        const result = await basePathModule.getBasePath(capabilities);
        expect(result).toBe("/env/path");
        expect(capabilities.checker.instantiate).not.toHaveBeenCalled();
    });

    it("falls back to file when environment.basePath() returns empty string", async () => {
        const capabilities = makeCapabilities("/file/path");
        capabilities.environment.basePath = jest.fn().mockReturnValue("");
        const result = await basePathModule.getBasePath(capabilities);
        expect(result).toBe("/file/path");
    });

    it("memoizes per capabilities instance", async () => {
        const caps1 = makeCapabilities("/path/1");
        const caps2 = makeCapabilities("/path/2");
        const result1 = await basePathModule.getBasePath(caps1);
        const result2 = await basePathModule.getBasePath(caps2);
        expect(result1).toBe("/path/1");
        expect(result2).toBe("/path/2");
    });
});
