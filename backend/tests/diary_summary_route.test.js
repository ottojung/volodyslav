const request = require("supertest");
const expressApp = require("../src/express_app");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

jest.mock("../src/jobs/diary_summary", () => ({
    runDiarySummaryPipeline: jest.fn(),
}));

const { runDiarySummaryPipeline } = require("../src/jobs/diary_summary");
const { makeRouter } = require("../src/routes/diary_summary");

/** @returns {import('../src/capabilities/root').Capabilities} */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    capabilities.interface = {
        isInitialized: jest.fn().mockReturnValue(true),
        getDiarySummary: jest.fn(),
    };
    return capabilities;
}

function makeDeferred() {
    /** @type {(value?: unknown) => void} */
    let resolve = () => {};
    /** @type {(reason?: unknown) => void} */
    let reject = () => {};

    const promise = new Promise((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });

    return { promise, resolve, reject };
}

async function makeApp() {
    const capabilities = getTestCapabilities();
    const app = expressApp.make();
    app.use("/api", makeRouter(capabilities));
    return app;
}

async function makeAppWithCapabilities() {
    const capabilities = getTestCapabilities();
    const app = expressApp.make();
    app.use("/api", makeRouter(capabilities));
    return { app, capabilities };
}

/** @returns {import('../src/generators/incremental_graph/database/types').DiaryMostImportantInfoSummaryEntry} */
function makeSummaryEntry() {
    return {
        type: "diary_most_important_info_summary",
        markdown: "## Summary",
        summaryDate: "2024-03-01T00:00:00.000Z",
        processedTranscriptions: {},
        updatedAt: "2024-03-02T10:00:00.000Z",
        model: "gpt-5.4",
        version: "1",
    };
}

describe("diary summary route", () => {
    beforeEach(() => {
        runDiarySummaryPipeline.mockReset();
    });

    it("starts pipeline in the background and reports progress via GET /api/diary-summary/run", async () => {
        const deferred = makeDeferred();
        runDiarySummaryPipeline.mockReturnValue(deferred.promise);
        const app = await makeApp();

        const startResponse = await request(app).post("/api/diary-summary/run").send();

        expect(startResponse.statusCode).toBe(202);
        expect(startResponse.body.status).toBe("running");

        const runningResponse = await request(app).get("/api/diary-summary/run");
        expect(runningResponse.statusCode).toBe(202);
        expect(runningResponse.body.status).toBe("running");

        const summary = makeSummaryEntry();
        deferred.resolve(summary);
        await new Promise((resolve) => setImmediate(resolve));

        const finishedResponse = await request(app).get("/api/diary-summary/run");
        expect(finishedResponse.statusCode).toBe(200);
        expect(finishedResponse.body.status).toBe("success");
        expect(finishedResponse.body.summary).toMatchObject({ type: "diary_most_important_info_summary" });
    });

    it("returns a running state with empty entries array on initial POST", async () => {
        const deferred = makeDeferred();
        runDiarySummaryPipeline.mockReturnValue(deferred.promise);
        const app = await makeApp();

        const startResponse = await request(app).post("/api/diary-summary/run").send();

        expect(startResponse.statusCode).toBe(202);
        expect(startResponse.body.entries).toEqual([]);

        deferred.resolve(makeSummaryEntry());
    });

    it("reports queued entries during a run via GET", async () => {
        const deferred = makeDeferred();

        runDiarySummaryPipeline.mockImplementation((_capabilities, callbacks) => {
            callbacks?.onEntryQueued?.("assets/audio1.wav");
            return deferred.promise;
        });

        const app = await makeApp();
        await request(app).post("/api/diary-summary/run").send();

        const runningResponse = await request(app).get("/api/diary-summary/run");
        expect(runningResponse.statusCode).toBe(202);
        expect(runningResponse.body.entries).toEqual([
            { path: "assets/audio1.wav", status: "pending" },
        ]);

        deferred.resolve(makeSummaryEntry());
    });

    it("updates entry status to success after processing", async () => {
        runDiarySummaryPipeline.mockImplementation((_capabilities, callbacks) => {
            callbacks?.onEntryQueued?.("assets/audio1.wav");
            callbacks?.onEntryProcessed?.("assets/audio1.wav", "success");
            return Promise.resolve(makeSummaryEntry());
        });

        const app = await makeApp();
        await request(app).post("/api/diary-summary/run").send();
        await new Promise((resolve) => setImmediate(resolve));

        const finishedResponse = await request(app).get("/api/diary-summary/run");
        expect(finishedResponse.statusCode).toBe(200);
        expect(finishedResponse.body.entries).toEqual([
            { path: "assets/audio1.wav", status: "success" },
        ]);
    });

    it("updates entry status to error on processing failure", async () => {
        runDiarySummaryPipeline.mockImplementation((_capabilities, callbacks) => {
            callbacks?.onEntryQueued?.("assets/audio1.wav");
            callbacks?.onEntryProcessed?.("assets/audio1.wav", "error");
            return Promise.resolve(makeSummaryEntry());
        });

        const app = await makeApp();
        await request(app).post("/api/diary-summary/run").send();
        await new Promise((resolve) => setImmediate(resolve));

        const finishedResponse = await request(app).get("/api/diary-summary/run");
        expect(finishedResponse.statusCode).toBe(200);
        expect(finishedResponse.body.entries).toEqual([
            { path: "assets/audio1.wav", status: "error" },
        ]);
    });

    it("returns error state when the pipeline throws", async () => {
        runDiarySummaryPipeline.mockRejectedValue(new Error("AI service unavailable"));
        const app = await makeApp();

        await request(app).post("/api/diary-summary/run").send();
        await new Promise((resolve) => setImmediate(resolve));

        const failedResponse = await request(app).get("/api/diary-summary/run");
        expect(failedResponse.statusCode).toBe(500);
        expect(failedResponse.body.status).toBe("error");
        expect(failedResponse.body.error).toBe("AI service unavailable");
    });

    it("returns idle state before any run has been triggered", async () => {
        const app = await makeApp();

        const idleResponse = await request(app).get("/api/diary-summary/run");
        expect(idleResponse.statusCode).toBe(200);
        expect(idleResponse.body.status).toBe("idle");
    });

    it("returns 503 when graph is not initialized on POST", async () => {
        const { app, capabilities } = await makeAppWithCapabilities();
        capabilities.interface.isInitialized.mockReturnValue(false);

        const response = await request(app).post("/api/diary-summary/run").send();

        expect(response.statusCode).toBe(503);
        expect(response.body.error).toBe("Graph not initialized");
    });

    it("reuses running state if POST is called while already running", async () => {
        const deferred = makeDeferred();
        runDiarySummaryPipeline.mockReturnValue(deferred.promise);
        const app = await makeApp();

        const first = await request(app).post("/api/diary-summary/run").send();
        const second = await request(app).post("/api/diary-summary/run").send();

        expect(first.statusCode).toBe(202);
        expect(second.statusCode).toBe(202);
        expect(runDiarySummaryPipeline).toHaveBeenCalledTimes(1);

        deferred.resolve(makeSummaryEntry());
    });
});
