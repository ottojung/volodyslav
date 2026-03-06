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
});
