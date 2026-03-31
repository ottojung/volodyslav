const {
    makeExclusiveProcess,
    makeExclusiveProcessHandle,
    isExclusiveProcess,
    isExclusiveProcessHandle,
} = require("../src/exclusive_process");

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

describe("ExclusiveProcess", () => {
    describe("makeExclusiveProcess", () => {
        it("returns an ExclusiveProcess instance", () => {
            const ep = makeExclusiveProcess(() => Promise.resolve());
            expect(isExclusiveProcess(ep)).toBe(true);
        });

        it("creates independent instances that do not share state", () => {
            const deferred = makeDeferred();
            const ep1 = makeExclusiveProcess(() => deferred.promise);
            const ep2 = makeExclusiveProcess(() => deferred.promise);

            const h1 = ep1.invoke([]);
            expect(h1.isInitiator).toBe(true);

            const h2 = ep2.invoke([]);
            expect(h2.isInitiator).toBe(true); // ep2 is idle, so also initiator

            deferred.resolve();
        });

        it("procedure is called with the args array spread as positional arguments", async () => {
            const received = [];
            const ep = makeExclusiveProcess((...args) => {
                received.push(...args);
                return Promise.resolve();
            });
            await ep.invoke(["a", "b", "c"]).result;
            expect(received).toEqual(["a", "b", "c"]);
        });
    });

    describe("invoke — idle process", () => {
        it("starts the procedure and returns an initiator handle", async () => {
            let called = false;
            const ep = makeExclusiveProcess(async () => {
                called = true;
                return 42;
            });

            const handle = ep.invoke([]);

            expect(isExclusiveProcessHandle(handle)).toBe(true);
            expect(handle.isInitiator).toBe(true);
            await expect(handle.result).resolves.toBe(42);
            expect(called).toBe(true);
        });

        it("resets to idle after a successful run", async () => {
            let run = 0;
            const ep = makeExclusiveProcess(() => Promise.resolve(++run));

            await ep.invoke([]).result;

            const h = ep.invoke([]);
            expect(h.isInitiator).toBe(true);
            await expect(h.result).resolves.toBe(2);
        });

        it("resets to idle after a failed run", async () => {
            let fail = true;
            const ep = makeExclusiveProcess(() =>
                fail ? Promise.reject(new Error("boom")) : Promise.resolve("recovered")
            );

            await ep.invoke([]).result.catch(() => {});

            fail = false;
            const h = ep.invoke([]);
            expect(h.isInitiator).toBe(true);
            await expect(h.result).resolves.toBe("recovered");
        });

        it("handles a synchronously throwing procedure", async () => {
            const ep = makeExclusiveProcess(() => {
                throw new Error("sync throw");
            });

            const handle = ep.invoke([]);

            expect(handle.isInitiator).toBe(true);
            await expect(handle.result).rejects.toThrow("sync throw");

            // Process should be idle again
            const ep2 = makeExclusiveProcess(() => Promise.resolve("ok"));
            const h2 = ep2.invoke([]);
            expect(h2.isInitiator).toBe(true);
        });
    });

    describe("invoke — running process (attaching)", () => {
        it("returns an attacher handle when a run is already in progress", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess(() => deferred.promise);

            const h1 = ep.invoke([]);
            const h2 = ep.invoke([]);

            expect(h1.isInitiator).toBe(true);
            expect(h2.isInitiator).toBe(false);

            deferred.resolve("result");
            await Promise.all([h1.result, h2.result]);
        });

        it("attacher shares the same result promise as the initiator", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess(() => deferred.promise);

            const h1 = ep.invoke([]);
            const h2 = ep.invoke([]);

            deferred.resolve("shared-value");

            const [r1, r2] = await Promise.all([h1.result, h2.result]);
            expect(r1).toBe("shared-value");
            expect(r2).toBe("shared-value");
        });

        it("procedure only runs once even with multiple concurrent invocations", async () => {
            const deferred = makeDeferred();
            let procedureCallCount = 0;
            const ep = makeExclusiveProcess(() => {
                procedureCallCount++;
                return deferred.promise;
            });

            ep.invoke([]);
            ep.invoke([]);
            ep.invoke([]);

            deferred.resolve();
            await deferred.promise;
            await new Promise((r) => setTimeout(r, 0));

            expect(procedureCallCount).toBe(1);
        });

        it("multiple attachers all receive the same result", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess(() => deferred.promise);

            const handles = [
                ep.invoke([]),
                ep.invoke([]),
                ep.invoke([]),
                ep.invoke([]),
            ];

            expect(handles[0].isInitiator).toBe(true);
            for (let i = 1; i < handles.length; i++) {
                expect(handles[i].isInitiator).toBe(false);
            }

            deferred.resolve("all-get-this");

            const results = await Promise.all(handles.map((h) => h.result));
            for (const r of results) {
                expect(r).toBe("all-get-this");
            }
        });
    });

    describe("error propagation", () => {
        it("propagates errors to the initiator", async () => {
            const ep = makeExclusiveProcess(() => Promise.reject(new Error("failure")));

            const handle = ep.invoke([]);

            await expect(handle.result).rejects.toThrow("failure");
        });

        it("propagates errors to all attachers", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess(() => deferred.promise);

            const h1 = ep.invoke([]);
            const h2 = ep.invoke([]);
            const h3 = ep.invoke([]);

            const err = new Error("pipeline crashed");
            deferred.reject(err);

            await Promise.all([
                expect(h1.result).rejects.toThrow("pipeline crashed"),
                expect(h2.result).rejects.toThrow("pipeline crashed"),
                expect(h3.result).rejects.toThrow("pipeline crashed"),
            ]);
        });

        it("allows a fresh run after a crash", async () => {
            let fail = true;
            const ep = makeExclusiveProcess(() =>
                fail ? Promise.reject(new Error("crash")) : Promise.resolve("fresh")
            );

            const h1 = ep.invoke([]);
            await h1.result.catch(() => {});

            fail = false;
            const h2 = ep.invoke([]);
            expect(h2.isInitiator).toBe(true);
            await expect(h2.result).resolves.toBe("fresh");
        });

        it("allows a fresh run after a crash that propagated to attachers", async () => {
            const deferred = makeDeferred();
            let fail = true;
            const ep = makeExclusiveProcess(() =>
                fail ? deferred.promise : Promise.resolve("new-run")
            );

            const h1 = ep.invoke([]);
            const h2 = ep.invoke([]);

            deferred.reject(new Error("crash"));
            await Promise.all([
                h1.result.catch(() => {}),
                h2.result.catch(() => {}),
            ]);

            fail = false;
            const h3 = ep.invoke([]);
            expect(h3.isInitiator).toBe(true);
            await expect(h3.result).resolves.toBe("new-run");
        });
    });

    describe("isExclusiveProcess type guard", () => {
        it("returns true for an ExclusiveProcess", () => {
            expect(isExclusiveProcess(makeExclusiveProcess(() => Promise.resolve()))).toBe(true);
        });

        it("returns false for non-ExclusiveProcess values", () => {
            expect(isExclusiveProcess(null)).toBe(false);
            expect(isExclusiveProcess(undefined)).toBe(false);
            expect(isExclusiveProcess({})).toBe(false);
            expect(isExclusiveProcess("string")).toBe(false);
            expect(isExclusiveProcess(42)).toBe(false);
        });
    });

    describe("isExclusiveProcessHandle type guard", () => {
        it("returns true for a handle returned by invoke", () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess(() => deferred.promise);
            const handle = ep.invoke([]);
            expect(isExclusiveProcessHandle(handle)).toBe(true);
            deferred.resolve();
        });

        it("returns true for a handle created by makeExclusiveProcessHandle", () => {
            const handle = makeExclusiveProcessHandle(false, Promise.resolve());
            expect(isExclusiveProcessHandle(handle)).toBe(true);
        });

        it("returns false for non-handle values", () => {
            expect(isExclusiveProcessHandle(null)).toBe(false);
            expect(isExclusiveProcessHandle(undefined)).toBe(false);
            expect(isExclusiveProcessHandle({})).toBe(false);
            expect(isExclusiveProcessHandle("string")).toBe(false);
        });
    });

    describe("isRunning", () => {
        it("returns false when the process is idle", () => {
            const ep = makeExclusiveProcess(() => Promise.resolve());
            expect(ep.isRunning()).toBe(false);
        });

        it("returns true while a computation is active", () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess(() => deferred.promise);
            ep.invoke([]);
            expect(ep.isRunning()).toBe(true);
            deferred.resolve();
        });

        it("returns false after a successful run completes", async () => {
            const ep = makeExclusiveProcess(() => Promise.resolve("done"));
            await ep.invoke([]).result;
            expect(ep.isRunning()).toBe(false);
        });

        it("returns false after a failed run completes", async () => {
            const ep = makeExclusiveProcess(() => Promise.reject(new Error("fail")));
            await ep.invoke([]).result.catch(() => {});
            expect(ep.isRunning()).toBe(false);
        });
    });

    describe("sequential runs", () => {
        it("allows a second run after the first completes", async () => {
            let runCount = 0;
            const ep = makeExclusiveProcess(async () => ++runCount);

            const h1 = ep.invoke([]);
            await h1.result;

            const h2 = ep.invoke([]);
            await h2.result;

            expect(runCount).toBe(2);
            expect(h1.isInitiator).toBe(true);
            expect(h2.isInitiator).toBe(true);
        });

        it("processes sequential invocations correctly", async () => {
            let runCount = 0;
            const ep = makeExclusiveProcess(async () => ++runCount);
            const results = [];

            for (let i = 0; i < 3; i++) {
                await ep.invoke([]).result.then((v) => results.push(v));
            }

            expect(results).toEqual([1, 2, 3]);
        });
    });
});
