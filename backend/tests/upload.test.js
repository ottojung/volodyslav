const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const {
    sanitizeFilename,
    FilenameValidationError,
    isFilenameValidationError,
    stringToTempKey,
} = require("../src/temporary");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

async function makeApp(capabilities) {
    const app = expressApp.make();
    await capabilities.logger.setup();
    await capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return app;
}

async function readBinaryTemporaryValue(temporary, key) {
    return temporary.getBinarySublevel("binary").get(key);
}

describe("POST /api/upload", () => {
    it("uploads a single file successfully", async () => {
        const capabilities = getTestCapabilities();    
        const app = await makeApp(capabilities);
        const reqId = "testreq";
        const res = await request(app)
            .post(`/api/upload?request_identifier=${reqId}`)
            .attach("files", Buffer.from("test content"), "test1.jpg");

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, files: ["test1.jpg"] });

        // Verify the file was stored in the temporary database.
        const { fromRequest } = require("../src/request_identifier");
        const reqIdObj = fromRequest({ query: { request_identifier: reqId } });
        const buffer = await capabilities.temporary.getBlob(reqIdObj, "test1.jpg");
        expect(buffer).not.toBeNull();
        expect(buffer.toString()).toBe("test content");

        // Verify the request is marked done.
        const done = await capabilities.temporary.isDone(reqIdObj);
        expect(done).toBe(true);
    });

    it("uploads multiple files successfully", async () => {
        const capabilities = getTestCapabilities();    
        const app = await makeApp(capabilities);

        // Upload first file with a unique request_identifier
        const reqId1 = "testreq1";
        const res1 = await request(app)
            .post(`/api/upload?request_identifier=${reqId1}`)
            .attach("files", Buffer.from("first"), "first.jpg");

        expect(res1.statusCode).toBe(200);
        expect(res1.body).toEqual({ success: true, files: ["first.jpg"] });

        const { fromRequest } = require("../src/request_identifier");
        const reqIdObj1 = fromRequest({ query: { request_identifier: reqId1 } });
        const buf1 = await capabilities.temporary.getBlob(reqIdObj1, "first.jpg");
        expect(buf1).not.toBeNull();
        expect(buf1.toString()).toBe("first");

        // Upload second file with another unique request_identifier
        const reqId2 = "testreq2";
        const res2 = await request(app)
            .post(`/api/upload?request_identifier=${reqId2}`)
            .attach("files", Buffer.from("second"), "second.jpg");

        expect(res2.statusCode).toBe(200);
        expect(res2.body).toEqual({ success: true, files: ["second.jpg"] });

        const reqIdObj2 = fromRequest({ query: { request_identifier: reqId2 } });
        const buf2 = await capabilities.temporary.getBlob(reqIdObj2, "second.jpg");
        expect(buf2).not.toBeNull();
        expect(buf2.toString()).toBe("second");
    });

    it("responds with empty files array when no files are sent", async () => {
        const capabilities = getTestCapabilities();
        const app = await makeApp(capabilities);
        const res = await request(app).post(
            "/api/upload?request_identifier=foo"
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, files: [] });
    });

    it("returns 400 when storeBlobsAndMarkDone throws FilenameValidationError", async () => {
        const capabilities = getTestCapabilities();
        // Force storeBlobsAndMarkDone to throw a FilenameValidationError so we
        // can verify the route returns 400 and does not write a done marker.
        jest.spyOn(capabilities.temporary, "storeBlobsAndMarkDone").mockImplementationOnce(() => {
            throw new FilenameValidationError(".");
        });
        const app = await makeApp(capabilities);
        const reqId = "testreq-invalid";
        const res = await request(app)
            .post(`/api/upload?request_identifier=${reqId}`)
            .attach("files", Buffer.from("data"), "valid.jpg");

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);

        // No done marker should have been written because the mock threw before
        // any write to the database.
        const { fromRequest } = require("../src/request_identifier");
        const reqIdObj = fromRequest({ query: { request_identifier: reqId } });
        const done = await capabilities.temporary.isDone(reqIdObj);
        expect(done).toBe(false);
    });

    it("returns 500 when storeBlobsAndMarkDone throws a generic storage error", async () => {
        const capabilities = getTestCapabilities();
        jest.spyOn(capabilities.temporary, "storeBlobsAndMarkDone").mockImplementationOnce(() => {
            throw new Error("LevelDB write failure");
        });
        const app = await makeApp(capabilities);
        const reqId = "testreq-storage-err";
        const res = await request(app)
            .post(`/api/upload?request_identifier=${reqId}`)
            .attach("files", Buffer.from("data"), "valid.jpg");

        expect(res.statusCode).toBe(500);
        expect(res.body.success).toBe(false);
    });
});

describe("sanitizeFilename", () => {
    it("accepts a normal filename unchanged", () => {
        expect(sanitizeFilename("audio.weba")).toBe("audio.weba");
    });

    it("strips leading path components", () => {
        expect(sanitizeFilename("../secret/audio.weba")).toBe("audio.weba");
        expect(sanitizeFilename("/etc/passwd")).toBe("passwd");
    });

    it("throws FilenameValidationError for a bare dot", () => {
        expect(() => sanitizeFilename(".")).toThrow(FilenameValidationError);
        expect(isFilenameValidationError(new FilenameValidationError("."))).toBe(true);
    });

    it("throws FilenameValidationError for double-dot", () => {
        expect(() => sanitizeFilename("..")).toThrow(FilenameValidationError);
    });

    it("throws FilenameValidationError for empty string", () => {
        expect(() => sanitizeFilename("")).toThrow(FilenameValidationError);
    });
});

describe("temporary legacy compatibility", () => {
    it("migrates legacy base64 blob entries when reading via getBlob", async () => {
        const capabilities = getTestCapabilities();
        const { fromRequest } = require("../src/request_identifier");
        const reqIdObj = fromRequest({ query: { request_identifier: "legacy-blob-req" } });
        const key = stringToTempKey(`blob/${reqIdObj.identifier}/legacy.jpg`);
        await capabilities.temporary.putEntry(key, {
            type: "blob",
            data: Buffer.from("legacy content").toString("base64"),
        });

        const value = await capabilities.temporary.getBlob(reqIdObj, "legacy.jpg");
        expect(value).not.toBeNull();
        expect(value.toString()).toBe("legacy content");

        const legacyEntry = await capabilities.temporary.getEntry(key);
        expect(legacyEntry).toBeUndefined();
        const migrated = await readBinaryTemporaryValue(capabilities.temporary, key);
        expect(migrated).toEqual(Buffer.from("legacy content"));
    });

    it("migrates legacy done entries when checking isDone", async () => {
        const capabilities = getTestCapabilities();
        const { fromRequest } = require("../src/request_identifier");
        const reqIdObj = fromRequest({ query: { request_identifier: "legacy-done-req" } });
        const key = stringToTempKey(`done/${reqIdObj.identifier}`);
        await capabilities.temporary.putEntry(key, { type: "done" });

        const done = await capabilities.temporary.isDone(reqIdObj);
        expect(done).toBe(true);

        const legacyEntry = await capabilities.temporary.getEntry(key);
        expect(legacyEntry).toBeUndefined();
        const migrated = await readBinaryTemporaryValue(capabilities.temporary, key);
        expect(migrated).toEqual(Buffer.alloc(0));
    });
});
