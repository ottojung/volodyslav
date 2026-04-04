const request = require("supertest");
const expressApp = require("../src/express_app");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

jest.mock("../src/jobs/diary_summary", () => ({
    runDiarySummaryPipeline: jest.fn(),
    diarySummaryExclusiveProcess: {
        invoke: jest.fn(),
        getState: jest.fn(),
    },
}));

const { diarySummaryExclusiveProcess } = require("../src/jobs/diary_summary");
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
        processedEntries: {},
        updatedAt: "2024-03-02T10:00:00.000Z",
        model: "gpt-5.4",
        version: "1",
    };
}

/** @type {{ started_at: string, finished_at: string }} */
const TIMESTAMPS = {
    started_at: "2024-01-01T00:00:00.000Z",
    finished_at: "2024-01-01T00:01:00.000Z",
};

describe("diary summary route", () => {
    beforeEach(() => {
        diarySummaryExclusiveProcess.invoke.mockReset();
        diarySummaryExclusiveProcess.getState.mockReset();
        diarySummaryExclusiveProcess.getState.mockReturnValue({ status: "idle" });
    });

    it("starts pipeline in the background and reports progress via GET /api/diary-summary/run", async () => {
        const deferred = makeDeferred();
        const runningState = { status: "running", started_at: TIMESTAMPS.started_at, entries: [] };
        const successState = {
            status: "success",
            started_at: TIMESTAMPS.started_at,
            finished_at: TIMESTAMPS.finished_at,
            entries: [],
            summary: makeSummaryEntry(),
        };

        diarySummaryExclusiveProcess.invoke.mockImplementation(() => {
            diarySummaryExclusiveProcess.getState.mockReturnValue(runningState);
            const result = deferred.promise.then((summary) => {
                diarySummaryExclusiveProcess.getState.mockReturnValue({ ...successState, summary });
                return summary;
            });
            return { isInitiator: true, result };
        });

        const app = await makeApp();

        const startResponse = await request(app).post("/api/diary-summary/run").send();

        expect(startResponse.statusCode).toBe(202);
        expect(startResponse.body.status).toBe("running");

        const runningResponse = await request(app).get("/api/diary-summary/run");
        expect(runningResponse.statusCode).toBe(202);
        expect(runningResponse.body.status).toBe("running");

        deferred.resolve(makeSummaryEntry());
        await new Promise((resolve) => setImmediate(resolve));

        const finishedResponse = await request(app).get("/api/diary-summary/run");
        expect(finishedResponse.statusCode).toBe(200);
        expect(finishedResponse.body.status).toBe("success");
        expect(finishedResponse.body.summary).toMatchObject({ type: "diary_most_important_info_summary" });
    });

    it("returns a running state with empty entries array on initial POST", async () => {
        const deferred = makeDeferred();
        const runningState = { status: "running", started_at: TIMESTAMPS.started_at, entries: [] };

        diarySummaryExclusiveProcess.invoke.mockImplementation(() => {
            diarySummaryExclusiveProcess.getState.mockReturnValue(runningState);
            return { isInitiator: true, result: deferred.promise };
        });

        const app = await makeApp();

        const startResponse = await request(app).post("/api/diary-summary/run").send();

        expect(startResponse.statusCode).toBe(202);
        expect(startResponse.body.entries).toEqual([]);

        deferred.resolve(makeSummaryEntry());
    });

    it("reports queued entries during a run via GET", async () => {
        const deferred = makeDeferred();
        const runningStateWithEntry = {
            status: "running",
            started_at: TIMESTAMPS.started_at,
            entries: [{ eventId: "event-1", status: "pending" }],
        };

        diarySummaryExclusiveProcess.invoke.mockImplementation(() => {
            diarySummaryExclusiveProcess.getState.mockReturnValue(runningStateWithEntry);
            return { isInitiator: true, result: deferred.promise };
        });

        const app = await makeApp();
        await request(app).post("/api/diary-summary/run").send();

        const runningResponse = await request(app).get("/api/diary-summary/run");
        expect(runningResponse.statusCode).toBe(202);
        expect(runningResponse.body.entries).toEqual([
            { eventId: "event-1", status: "pending" },
        ]);

        deferred.resolve(makeSummaryEntry());
    });

    it("updates entry status to success after processing", async () => {
        const summary = makeSummaryEntry();
        const successState = {
            status: "success",
            started_at: TIMESTAMPS.started_at,
            finished_at: TIMESTAMPS.finished_at,
            entries: [{ eventId: "event-1", status: "success" }],
            summary,
        };

        diarySummaryExclusiveProcess.invoke.mockImplementation(() => {
            diarySummaryExclusiveProcess.getState.mockReturnValue(successState);
            return { isInitiator: true, result: Promise.resolve(summary) };
        });

        const app = await makeApp();
        await request(app).post("/api/diary-summary/run").send();
        await new Promise((resolve) => setImmediate(resolve));

        const finishedResponse = await request(app).get("/api/diary-summary/run");
        expect(finishedResponse.statusCode).toBe(200);
        expect(finishedResponse.body.entries).toEqual([
            { eventId: "event-1", status: "success" },
        ]);
    });

    it("updates entry status to error on processing failure", async () => {
        const summary = makeSummaryEntry();
        const successState = {
            status: "success",
            started_at: TIMESTAMPS.started_at,
            finished_at: TIMESTAMPS.finished_at,
            entries: [{ eventId: "event-1", status: "error" }],
            summary,
        };

        diarySummaryExclusiveProcess.invoke.mockImplementation(() => {
            diarySummaryExclusiveProcess.getState.mockReturnValue(successState);
            return { isInitiator: true, result: Promise.resolve(summary) };
        });

        const app = await makeApp();
        await request(app).post("/api/diary-summary/run").send();
        await new Promise((resolve) => setImmediate(resolve));

        const finishedResponse = await request(app).get("/api/diary-summary/run");
        expect(finishedResponse.statusCode).toBe(200);
        expect(finishedResponse.body.entries).toEqual([
            { eventId: "event-1", status: "error" },
        ]);
    });

    it("returns error state when the pipeline throws", async () => {
        const errorState = {
            status: "error",
            started_at: TIMESTAMPS.started_at,
            finished_at: TIMESTAMPS.finished_at,
            entries: [],
            error: "AI service unavailable",
        };

        diarySummaryExclusiveProcess.invoke.mockImplementation(() => {
            const result = Promise.reject(new Error("AI service unavailable"));
            result.catch(() => {
                diarySummaryExclusiveProcess.getState.mockReturnValue(errorState);
            });
            diarySummaryExclusiveProcess.getState.mockReturnValue({
                status: "running",
                started_at: TIMESTAMPS.started_at,
                entries: [],
            });
            return { isInitiator: true, result };
        });

        const app = await makeApp();

        await request(app).post("/api/diary-summary/run").send();
        await new Promise((resolve) => setImmediate(resolve));

        const failedResponse = await request(app).get("/api/diary-summary/run");
        expect(failedResponse.statusCode).toBe(500);
        expect(failedResponse.body.status).toBe("error");
        expect(failedResponse.body.error).toBe("AI service unavailable");
    });

    it("POST /diary-summary/run observes background rejection to avoid unhandled promise rejection", async () => {
        diarySummaryExclusiveProcess.invoke.mockImplementation(() => {
            const result = Promise.reject(new Error("AI service unavailable"));
            result.catch(() => {});
            diarySummaryExclusiveProcess.getState.mockReturnValue({
                status: "running",
                started_at: TIMESTAMPS.started_at,
                entries: [],
            });
            return { isInitiator: true, result };
        });
        const app = await makeApp();

        const response = await request(app).post("/api/diary-summary/run").send();
        await new Promise((resolve) => setImmediate(resolve));

        expect(response.statusCode).toBe(202);
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

    it("returns running state when POST is called while already running (invoke called twice)", async () => {
        const deferred = makeDeferred();
        const runningState = { status: "running", started_at: TIMESTAMPS.started_at, entries: [] };

        diarySummaryExclusiveProcess.invoke.mockImplementation(() => {
            diarySummaryExclusiveProcess.getState.mockReturnValue(runningState);
            return { isInitiator: false, currentState: runningState, result: deferred.promise };
        });

        const app = await makeApp();

        const first = await request(app).post("/api/diary-summary/run").send();
        const second = await request(app).post("/api/diary-summary/run").send();

        expect(first.statusCode).toBe(202);
        expect(second.statusCode).toBe(202);
        expect(diarySummaryExclusiveProcess.invoke).toHaveBeenCalledTimes(2);

        deferred.resolve(makeSummaryEntry());
    });
});
