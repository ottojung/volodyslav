const path = require("path");
const fs = require("fs");
const {
    fromRequest,
    makeDirectory,
    markDone,
    isDone,
    MissingRequestIdentifierError,
} = require("../src/request_identifier");

const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("Request Identifier", () => {
    describe("fromRequest", () => {
        it("extracts request identifier from query params", () => {
            const req = { query: { request_identifier: "test123" } };
            const reqId = fromRequest(req);
            expect(reqId.identifier).toBe("test123");
        });

        it("throws error when request_identifier is missing", () => {
            const req = { query: {} };
            expect(() => fromRequest(req)).toThrow(MissingRequestIdentifierError);
        });

        it("throws error when request_identifier is empty", () => {
            const req = { query: { request_identifier: "" } };
            expect(() => fromRequest(req)).toThrow(MissingRequestIdentifierError);
        });

        it("trims whitespace from request_identifier", () => {
            const req = { query: { request_identifier: "  test123  " } };
            const reqId = fromRequest(req);
            expect(reqId.identifier).toBe("test123");
        });

        it("throws error when request_identifier is only whitespace", () => {
            const req = { query: { request_identifier: "   " } };
            expect(() => fromRequest(req)).toThrow(MissingRequestIdentifierError);
        });
    });

    describe("makeDirectory", () => {
        it("creates directory for request identifier", async () => {
            const capabilities = getTestCapabilities();
            const req = { query: { request_identifier: "test123" } };
            const reqId = fromRequest(req);
            const dirPath = await makeDirectory(capabilities, reqId);
            const uploadDir = capabilities.environment.workingDirectory();

            expect(fs.existsSync(dirPath)).toBe(true);
            expect(dirPath).toBe(path.join(uploadDir, "test123"));
        });

        it("handles special characters in request identifier", async () => {
            const capabilities = getTestCapabilities();
            const req = { query: { request_identifier: "test#123" } };
            const reqId = fromRequest(req);
            const dirPath = await makeDirectory(capabilities, reqId);
            const uploadDir = capabilities.environment.workingDirectory();

            expect(fs.existsSync(dirPath)).toBe(true);
            expect(dirPath).toBe(path.join(uploadDir, "test#123"));
        });
    });

    describe("markDone and isDone", () => {
        it("creates and checks done marker", async () => {
            const capabilities = getTestCapabilities();
            const req = { query: { request_identifier: "test123" } };
            const reqId = fromRequest(req);
            const uploadDir = capabilities.environment.workingDirectory();

            await expect(isDone(capabilities, reqId)).resolves.toBe(false);

            await markDone(capabilities, reqId);

            await expect(isDone(capabilities, reqId)).resolves.toBe(true);
            expect(fs.existsSync(path.join(uploadDir, "test123.done"))).toBe(
                true
            );
        });

        it("handles concurrent markDone calls", async () => {
            const capabilities = getTestCapabilities();
            const req = { query: { request_identifier: "test123" } };
            const reqId = fromRequest(req);

            await Promise.all([
                markDone(capabilities, reqId),
                markDone(capabilities, reqId),
                markDone(capabilities, reqId),
            ]);

            await expect(isDone(capabilities, reqId)).resolves.toBe(true);
        });
    });
});
