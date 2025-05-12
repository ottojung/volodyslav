const path = require("path");
const fs = require("fs");
const {
    fromRequest,
    makeDirectory,
    markDone,
    isDone,
} = require("../src/request_identifier");
const { uploadDir } = require("../src/config");
const temporary = require("./temporary");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

// Mock environment exports
jest.mock("../src/environment", () => {
    const temporary = require("./temporary");
    return {
        openaiAPIKey: jest.fn().mockReturnValue("test-key"),
        resultsDirectory: jest.fn().mockImplementation(temporary.output),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("silent"),
    };
});

describe("Request Identifier", () => {
    describe("fromRequest", () => {
        it("extracts request identifier from query params", () => {
            const req = { query: { request_identifier: "test123" } };
            const reqId = fromRequest(req);
            expect(reqId.identifier).toBe("test123");
        });

        it("throws error when request_identifier is missing", () => {
            const req = { query: {} };
            expect(() => fromRequest(req)).toThrow(
                "Missing request_identifier field"
            );
        });

        it("handles empty request_identifier", () => {
            const req = { query: { request_identifier: "" } };
            expect(() => fromRequest(req)).not.toThrow();
            const reqId = fromRequest(req);
            expect(reqId.identifier).toBe("");
        });
    });

    describe("makeDirectory", () => {
        it("creates directory for request identifier", async () => {
            const req = { query: { request_identifier: "test123" } };
            const reqId = fromRequest(req);
            const dirPath = await makeDirectory(reqId);

            expect(fs.existsSync(dirPath)).toBe(true);
            expect(dirPath).toBe(path.join(uploadDir, "test123"));
        });

        it("handles special characters in request identifier", async () => {
            const req = { query: { request_identifier: "test#123" } };
            const reqId = fromRequest(req);
            const dirPath = await makeDirectory(reqId);

            expect(fs.existsSync(dirPath)).toBe(true);
            expect(dirPath).toBe(path.join(uploadDir, "test#123"));
        });
    });

    describe("markDone and isDone", () => {
        it("creates and checks done marker", async () => {
            const req = { query: { request_identifier: "test123" } };
            const reqId = fromRequest(req);

            await expect(isDone(reqId)).resolves.toBe(false);

            await markDone(reqId);

            await expect(isDone(reqId)).resolves.toBe(true);
            expect(fs.existsSync(path.join(uploadDir, "test123.done"))).toBe(
                true
            );
        });

        it("handles concurrent markDone calls", async () => {
            const req = { query: { request_identifier: "test123" } };
            const reqId = fromRequest(req);

            await Promise.all([
                markDone(reqId),
                markDone(reqId),
                markDone(reqId),
            ]);

            await expect(isDone(reqId)).resolves.toBe(true);
        });
    });
});
