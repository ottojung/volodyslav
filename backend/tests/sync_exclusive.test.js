/**
 * Integration tests for the ExclusiveProcess adoption in the sync module.
 * Validates that the scheduled job and the HTTP route share the same exclusive
 * process, options are never silently dropped, and step callbacks are
 * forwarded to all concurrent callers.
 */

const request = require("supertest");
const expressApp = require("../src/express_app");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const { makeRouter } = require("../src/routes/sync");

// Mock the assets module to avoid real rsync calls.
jest.mock("../src/assets", () => ({
    synchronize: jest.fn().mockResolvedValue(undefined),
    isAssetsSynchronizationError: jest.fn(() => false),
}));

const { synchronize: assetsSynchronize } = require("../src/assets");

const {
    synchronizeAll,
    synchronizeAllExclusiveProcess,
} = require("../src/sync");

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
        synchronizeDatabase: jest.fn().mockResolvedValue(undefined),
    };
    return capabilities;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("sync — ExclusiveProcess adoption", () => {
    beforeEach(() => {
        assetsSynchronize.mockResolvedValue(undefined);
    });

    describe("compatible-options: attach to the running run", () => {
        it("second call with no options attaches to the first run", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            let syncDatabaseCallCount = 0;
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation(() => {
                    syncDatabaseCallCount++;
                    return deferred.promise;
                });

            const p1 = synchronizeAll(capabilities);
            const p2 = synchronizeAll(capabilities);

            // Both promises should be the SAME object.
            expect(p1).toBe(p2);

            deferred.resolve();
            await Promise.all([p1, p2]);

            // The underlying sync ran only once.
            expect(syncDatabaseCallCount).toBe(1);
        });

        it("error propagates to all concurrent callers on the same run", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            const p1 = synchronizeAll(capabilities);
            const p2 = synchronizeAll(capabilities);

            deferred.reject(new Error("db-crash"));

            await Promise.all([
                expect(p1).rejects.toMatchObject({ name: "SynchronizeAllError" }),
                expect(p2).rejects.toMatchObject({ name: "SynchronizeAllError" }),
            ]);
        });

        it("process resets after a crash so the next call starts fresh", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            const p1 = synchronizeAll(capabilities);
            deferred.reject(new Error("crash"));
            await p1.catch(() => {});

            // EP is idle again.
            expect(synchronizeAllExclusiveProcess.isRunning()).toBe(false);
        });
    });

    describe("P1 — conflicting options are queued, not silently ignored", () => {
        it("call with reset_to_hostname is queued when a plain sync is already running", async () => {
            const capabilities = getTestCapabilities();
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();

            let callIndex = 0;
            const deferreds = [deferred1, deferred2];
            const capturedOptions = [];

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation((opts) => {
                    capturedOptions.push(opts);
                    return deferreds[callIndex++].promise;
                });

            // First run: job with no options.
            const p1 = synchronizeAll(capabilities);
            expect(synchronizeAllExclusiveProcess.isRunning()).toBe(true);
            expect(callIndex).toBe(1);

            // Second call with reset — should be queued, not started yet.
            const p2 = synchronizeAll(capabilities, { resetToHostname: "alice" });
            expect(callIndex).toBe(1); // still only one DB call

            // Resolve first run.
            deferred1.resolve();
            await p1;
            await new Promise((r) => setImmediate(r));

            // Now the queued reset run should have started.
            expect(callIndex).toBe(2);
            expect(capturedOptions[1]).toEqual({ resetToHostname: "alice" });

            // Resolve the reset run so p2 settles.
            deferred2.resolve();
            await p2;
        });

        it("caller with conflicting options gets a promise that resolves after the queued run", async () => {
            const capabilities = getTestCapabilities();
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();

            let callIndex = 0;
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation(() => [deferred1, deferred2][callIndex++].promise);

            const p1 = synchronizeAll(capabilities);
            const p2 = synchronizeAll(capabilities, { resetToHostname: "alice" });

            // p2 must NOT be the same object as p1 (it's a queued promise).
            expect(p1).not.toBe(p2);

            // Resolve first run: p1 resolves but p2 should NOT resolve yet.
            deferred1.resolve();
            await p1;

            let p2Resolved = false;
            p2.then(() => { p2Resolved = true; });

            await new Promise((r) => setImmediate(r));
            expect(p2Resolved).toBe(false); // pending run still in progress

            // Resolve the queued run.
            deferred2.resolve();
            await p2;
            expect(p2Resolved).toBe(true);
        });

        it("last-write-wins when multiple conflicting calls queue up during a single run", async () => {
            const capabilities = getTestCapabilities();
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();

            let callIndex = 0;
            const capturedOptions = [];
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation((opts) => {
                    capturedOptions.push(opts);
                    return [deferred1, deferred2][callIndex++].promise;
                });

            const p1 = synchronizeAll(capabilities);
            // Two conflicting callers — last write wins for the queued args.
            const p2a = synchronizeAll(capabilities, { resetToHostname: "alice" });
            const p2b = synchronizeAll(capabilities, { resetToHostname: "bob" });

            // Both p2a and p2b share the same queued promise.
            expect(p2a).toBe(p2b);

            deferred1.resolve();
            await p1;
            await new Promise((r) => setImmediate(r));

            // The queued run used the last-written options ("bob").
            expect(capturedOptions[1]).toEqual({ resetToHostname: "bob" });

            deferred2.resolve();
            await Promise.all([p2a, p2b]);
        });

        it("a plain attach is not confused with a conflicting queue", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            let callCount = 0;
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation(() => {
                    callCount++;
                    return deferred.promise;
                });

            // Run with reset.
            const p1 = synchronizeAll(capabilities, { resetToHostname: "alice" });

            // Second call with the SAME reset — should attach (no conflict).
            const p2 = synchronizeAll(capabilities, { resetToHostname: "alice" });
            expect(p1).toBe(p2);
            expect(callCount).toBe(1);

            deferred.resolve();
            await Promise.all([p1, p2]);
        });

        it("step callbacks are forwarded to attached callers", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation(() => deferred.promise);

            const initiatorSteps = [];
            const attacherSteps = [];

            const p1 = synchronizeAll(capabilities, undefined, (step) => initiatorSteps.push(step));
            const p2 = synchronizeAll(capabilities, undefined, (step) => attacherSteps.push(step));

            // Both should share the same run (no options conflict).
            expect(p1).toBe(p2);

            deferred.resolve();
            await Promise.all([p1, p2]);

            // generators step fired for both.
            expect(initiatorSteps).toContainEqual({ name: "generators", status: "success" });
            expect(attacherSteps).toContainEqual({ name: "generators", status: "success" });
        });
    });

    describe("route controller attaches to a running job-level invocation", () => {
        it("returns running state when sync is already running (initiated by job)", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            // Simulate the job starting the sync.
            const jobPromise = synchronizeAll(capabilities);
            expect(synchronizeAllExclusiveProcess.isRunning()).toBe(true);

            // Now the route is invoked.
            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            const startResponse = await request(app).post("/api/sync").send({});
            expect(startResponse.statusCode).toBe(202);
            expect(startResponse.body.status).toBe("running");

            // Finish the job's run.
            deferred.resolve();
            await jobPromise;
            await new Promise((r) => setImmediate(r));

            // Route should now reflect success.
            const finishedResponse = await request(app).get("/api/sync");
            expect(finishedResponse.statusCode).toBe(200);
            expect(finishedResponse.body.status).toBe("success");
        });

        it("route controller transitions to error when the job-level run crashes", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            // Simulate the job starting the sync.
            const jobPromise = synchronizeAll(capabilities);

            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            // Route attaches while job is running.
            await request(app).post("/api/sync").send({});

            // Job crashes.
            deferred.reject(new Error("db-failure"));
            await jobPromise.catch(() => {});
            await new Promise((r) => setImmediate(r));

            // Route should reflect the error.
            const failedResponse = await request(app).get("/api/sync");
            expect(failedResponse.statusCode).toBe(500);
            expect(failedResponse.body.status).toBe("error");
        });

        it("does not start a second sync run when the route calls start() twice while attached", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            let syncCallCount = 0;
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation(() => {
                    syncCallCount++;
                    return deferred.promise;
                });

            const jobPromise = synchronizeAll(capabilities);

            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            const r1 = await request(app).post("/api/sync").send({});
            const r2 = await request(app).post("/api/sync").send({});

            expect(r1.statusCode).toBe(202);
            expect(r2.statusCode).toBe(202);

            // Only one underlying sync call.
            expect(syncCallCount).toBe(1);

            deferred.resolve();
            await jobPromise;
        });

        it("route request with reset_to_hostname is queued when a job run is active", async () => {
            const capabilities = getTestCapabilities();
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();

            let callIndex = 0;
            const capturedOptions = [];
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation((opts) => {
                    capturedOptions.push(opts);
                    return [deferred1, deferred2][callIndex++].promise;
                });

            // Job starts a plain sync.
            const jobPromise = synchronizeAll(capabilities);

            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            // Route requests sync with reset — this should be queued.
            const routeStartResp = await request(app)
                .post("/api/sync")
                .send({ reset_to_hostname: "alice" });
            expect(routeStartResp.statusCode).toBe(202);
            expect(routeStartResp.body.status).toBe("running");

            // Only one DB call so far (the job's plain sync).
            expect(callIndex).toBe(1);

            // Finish the job run.
            deferred1.resolve();
            await jobPromise;
            await new Promise((r) => setImmediate(r));

            // Now the reset run should have started.
            expect(callIndex).toBe(2);
            expect(capturedOptions[1]).toEqual({ resetToHostname: "alice" });

            // Finish the reset run.
            deferred2.resolve();
            await new Promise((r) => setImmediate(r));

            // Route should show success.
            const finishedResp = await request(app).get("/api/sync");
            expect(finishedResp.statusCode).toBe(200);
            expect(finishedResp.body.status).toBe("success");
        });
    });
});
