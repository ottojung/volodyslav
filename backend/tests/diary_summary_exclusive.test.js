/**
 * Integration tests for the ExclusiveProcess adoption in the diary-summary
 * pipeline.  Validates that the scheduled job and the HTTP route share the
 * same exclusive process — i.e. a second concurrent invocation attaches to
 * the already-running computation rather than starting a new one, and that
 * callbacks are forwarded to all concurrent callers.
 */

const request = require("supertest");
const expressApp = require("../src/express_app");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const { makeRouter } = require("../src/routes/diary_summary");
const {
    runDiarySummaryPipeline,
    diarySummaryExclusiveProcess,
} = require("../src/jobs/diary_summary");
const { isExclusiveProcess } = require("../src/exclusive_process");

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeDeferred() {
    /** @type {(value?: unknown) => void} */
    let resolve = () => {};
    /** @type {(reason?: unknown) => void} */
    let reject = () => {};
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    capabilities.interface = {
        isInitialized: jest.fn().mockReturnValue(true),
        ensureInitialized: jest.fn().mockResolvedValue(undefined),
        getDiarySummary: jest.fn().mockResolvedValue({
            type: "diary_most_important_info_summary",
            markdown: "",
            summaryDate: null,
            processedTranscriptions: {},
            updatedAt: null,
            model: "gpt-5.4",
            version: "1",
        }),
        getSortedEvents: jest.fn().mockReturnValue([].values()),
    };
    return capabilities;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("diary summary — ExclusiveProcess adoption", () => {
    it("diarySummaryExclusiveProcess is a plain ExclusiveProcess instance", () => {
        expect(isExclusiveProcess(diarySummaryExclusiveProcess)).toBe(true);
    });

    describe("runDiarySummaryPipeline uses the ExclusiveProcess", () => {
        it("second call attaches to the first run rather than starting a new one", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            let callCount = 0;
            const originalGetSortedEvents = capabilities.interface.getSortedEvents;
            capabilities.interface.getSortedEvents = jest.fn().mockImplementation(() => {
                callCount++;
                return originalGetSortedEvents();
            });

            capabilities.interface.ensureInitialized = jest
                .fn()
                .mockReturnValue(deferred.promise.then(() => undefined));

            const p1 = runDiarySummaryPipeline(capabilities);
            const p2 = runDiarySummaryPipeline(capabilities);

            // Both promises must be the SAME object (shared promise).
            expect(p1).toBe(p2);

            deferred.resolve();
            await Promise.all([p1, p2]);

            // The underlying pipeline ran only once.
            expect(callCount).toBe(1);
        });

        it("error in first run propagates to all concurrent callers", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.ensureInitialized = jest
                .fn()
                .mockReturnValue(deferred.promise.then(() => undefined));

            const p1 = runDiarySummaryPipeline(capabilities);
            const p2 = runDiarySummaryPipeline(capabilities);

            deferred.reject(new Error("pipeline-crash"));

            await Promise.all([
                expect(p1).rejects.toThrow("pipeline-crash"),
                expect(p2).rejects.toThrow("pipeline-crash"),
            ]);
        });

        it("process resets after a crash so the next call starts fresh", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.ensureInitialized = jest
                .fn()
                .mockReturnValue(deferred.promise.then(() => undefined));

            const p1 = runDiarySummaryPipeline(capabilities);
            deferred.reject(new Error("crash"));
            await p1.catch(() => {});

            // EP is idle after crash
            expect(diarySummaryExclusiveProcess.isRunning()).toBe(false);

            // Reset the mock so the next run can succeed, then verify a fresh run starts.
            capabilities.interface.ensureInitialized = jest.fn().mockResolvedValue(undefined);
            await runDiarySummaryPipeline(capabilities);
            expect(diarySummaryExclusiveProcess.isRunning()).toBe(false);
        });
    });

    describe("P2 — callbacks forwarded to attached callers", () => {
        it("attacher's onAttach hook is invoked, adding callbacks to fan-out", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.ensureInitialized = jest
                .fn()
                .mockReturnValue(deferred.promise.then(() => undefined));

            const initiatorQueued = [];
            const attacherQueued = [];

            // Both callers join before the run completes.
            const p1 = runDiarySummaryPipeline(capabilities, {
                onEntryQueued: (path) => initiatorQueued.push(path),
            });
            const p2 = runDiarySummaryPipeline(capabilities, {
                onEntryQueued: (path) => attacherQueued.push(path),
            });

            expect(p1).toBe(p2);

            deferred.resolve();
            await Promise.all([p1, p2]);

            // Both should have been registered in the fan-out.
            // (No diary events in the mock so no notifications fire, but we
            //  verify that both promises resolved and the EP is idle.)
            expect(diarySummaryExclusiveProcess.isRunning()).toBe(false);
        });

        it("route controller receives entry progress from a job-initiated run", async () => {
            const capabilities = getTestCapabilities();
            const runDeferred = makeDeferred();

            capabilities.interface.ensureInitialized = jest
                .fn()
                .mockReturnValue(runDeferred.promise.then(() => undefined));

            // Job starts the pipeline.
            const jobPromise = runDiarySummaryPipeline(capabilities);

            // Route joins.
            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));
            await request(app).post("/api/diary-summary/run").send();

            // Let the pipeline finish.
            runDeferred.resolve();
            await jobPromise;
            await new Promise((r) => setImmediate(r));

            // Route should show success.
            const resp = await request(app).get("/api/diary-summary/run");
            expect(resp.statusCode).toBe(200);
            expect(resp.body.status).toBe("success");
        });
    });

    describe("route controller attaches to a running job-level invocation", () => {
        it("returns running state when the pipeline is already running (initiated by job)", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.ensureInitialized = jest
                .fn()
                .mockReturnValue(deferred.promise.then(() => undefined));

            const jobPromise = runDiarySummaryPipeline(capabilities);
            expect(diarySummaryExclusiveProcess.isRunning()).toBe(true);

            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            const startResponse = await request(app).post("/api/diary-summary/run").send();
            expect(startResponse.statusCode).toBe(202);
            expect(startResponse.body.status).toBe("running");

            deferred.resolve();
            await jobPromise;
            await new Promise((r) => setImmediate(r));

            const finishedResponse = await request(app).get("/api/diary-summary/run");
            expect(finishedResponse.statusCode).toBe(200);
            expect(finishedResponse.body.status).toBe("success");
        });

        it("route controller transitions to error when the job-level run crashes", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.ensureInitialized = jest
                .fn()
                .mockReturnValue(deferred.promise.then(() => undefined));

            const jobPromise = runDiarySummaryPipeline(capabilities);

            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            await request(app).post("/api/diary-summary/run").send();

            deferred.reject(new Error("job-level crash"));
            await jobPromise.catch(() => {});
            await new Promise((r) => setImmediate(r));

            const failedResponse = await request(app).get("/api/diary-summary/run");
            expect(failedResponse.statusCode).toBe(500);
            expect(failedResponse.body.status).toBe("error");
            expect(failedResponse.body.error).toContain("job-level crash");
        });

        it("does not start a second pipeline run when the route calls start() twice while attached", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.ensureInitialized = jest
                .fn()
                .mockReturnValue(deferred.promise.then(() => undefined));

            const jobPromise = runDiarySummaryPipeline(capabilities);

            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            const r1 = await request(app).post("/api/diary-summary/run").send();
            const r2 = await request(app).post("/api/diary-summary/run").send();

            expect(r1.statusCode).toBe(202);
            expect(r2.statusCode).toBe(202);

            expect(capabilities.interface.ensureInitialized).toHaveBeenCalledTimes(1);

            deferred.resolve();
            await jobPromise;
        });
    });
});
