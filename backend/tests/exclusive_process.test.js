const {
    makeExclusiveProcess,
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
            const ep = makeExclusiveProcess();
            expect(isExclusiveProcess(ep)).toBe(true);
        });

        it("creates independent instances that do not share state", () => {
            const ep1 = makeExclusiveProcess();
            const ep2 = makeExclusiveProcess();
            const deferred = makeDeferred();

            const h1 = ep1.invoke(() => deferred.promise);
            expect(h1.isInitiator).toBe(true);

            const h2 = ep2.invoke(() => deferred.promise);
            expect(h2.isInitiator).toBe(true); // ep2 is idle, so also initiator

            deferred.resolve();
        });
    });

    describe("invoke — idle process", () => {
        it("starts the procedure and returns an initiator handle", async () => {
            const ep = makeExclusiveProcess();
            let called = false;

            const handle = ep.invoke(async () => {
                called = true;
                return 42;
            });

            expect(isExclusiveProcessHandle(handle)).toBe(true);
            expect(handle.isInitiator).toBe(true);
            await expect(handle.result).resolves.toBe(42);
            expect(called).toBe(true);
        });

        it("resets to idle after a successful run", async () => {
            const ep = makeExclusiveProcess();

            await ep.invoke(() => Promise.resolve("first")).result;

            // After reset, next invoke should be a new initiator
            const h = ep.invoke(() => Promise.resolve("second"));
            expect(h.isInitiator).toBe(true);
            await expect(h.result).resolves.toBe("second");
        });

        it("resets to idle after a failed run", async () => {
            const ep = makeExclusiveProcess();

            await ep
                .invoke(() => Promise.reject(new Error("boom")))
                .result.catch(() => {});

            // After reset, next invoke should start fresh
            const h = ep.invoke(() => Promise.resolve("recovered"));
            expect(h.isInitiator).toBe(true);
            await expect(h.result).resolves.toBe("recovered");
        });

        it("handles a synchronously throwing procedure", async () => {
            const ep = makeExclusiveProcess();

            const handle = ep.invoke(() => {
                throw new Error("sync throw");
            });

            expect(handle.isInitiator).toBe(true);
            await expect(handle.result).rejects.toThrow("sync throw");

            // Process should be idle again
            const h2 = ep.invoke(() => Promise.resolve("ok"));
            expect(h2.isInitiator).toBe(true);
        });
    });

    describe("invoke — running process (attaching)", () => {
        it("returns an attacher handle when a run is already in progress", async () => {
            const ep = makeExclusiveProcess();
            const deferred = makeDeferred();

            const h1 = ep.invoke(() => deferred.promise);
            const h2 = ep.invoke(() => Promise.resolve("ignored"));

            expect(h1.isInitiator).toBe(true);
            expect(h2.isInitiator).toBe(false);

            deferred.resolve("result");
            await Promise.all([h1.result, h2.result]);
        });

        it("attacher shares the same result promise as the initiator", async () => {
            const ep = makeExclusiveProcess();
            const deferred = makeDeferred();

            const h1 = ep.invoke(() => deferred.promise);
            const h2 = ep.invoke(() => Promise.resolve("should be ignored"));

            deferred.resolve("shared-value");

            const [r1, r2] = await Promise.all([h1.result, h2.result]);
            expect(r1).toBe("shared-value");
            expect(r2).toBe("shared-value");
        });

        it("ignores the attacher's procedure — only the initiator's runs", async () => {
            const ep = makeExclusiveProcess();
            const deferred = makeDeferred();
            let secondProcedureCalled = false;

            ep.invoke(() => deferred.promise);
            ep.invoke(() => {
                secondProcedureCalled = true;
                return Promise.resolve();
            });

            deferred.resolve();
            await deferred.promise;
            await new Promise((r) => setTimeout(r, 0));

            expect(secondProcedureCalled).toBe(false);
        });

        it("multiple attachers all receive the same result", async () => {
            const ep = makeExclusiveProcess();
            const deferred = makeDeferred();

            const handles = [
                ep.invoke(() => deferred.promise),
                ep.invoke(() => Promise.resolve()),
                ep.invoke(() => Promise.resolve()),
                ep.invoke(() => Promise.resolve()),
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
            const ep = makeExclusiveProcess();

            const handle = ep.invoke(() => Promise.reject(new Error("failure")));

            await expect(handle.result).rejects.toThrow("failure");
        });

        it("propagates errors to all attachers", async () => {
            const ep = makeExclusiveProcess();
            const deferred = makeDeferred();

            const h1 = ep.invoke(() => deferred.promise);
            const h2 = ep.invoke(() => Promise.resolve("ignored"));
            const h3 = ep.invoke(() => Promise.resolve("also ignored"));

            const err = new Error("pipeline crashed");
            deferred.reject(err);

            await Promise.all([
                expect(h1.result).rejects.toThrow("pipeline crashed"),
                expect(h2.result).rejects.toThrow("pipeline crashed"),
                expect(h3.result).rejects.toThrow("pipeline crashed"),
            ]);
        });

        it("allows a fresh run after a crash", async () => {
            const ep = makeExclusiveProcess();

            const h1 = ep.invoke(() => Promise.reject(new Error("crash")));
            await h1.result.catch(() => {});

            // Process should be idle; next invoke is a new initiator
            const h2 = ep.invoke(() => Promise.resolve("fresh"));
            expect(h2.isInitiator).toBe(true);
            await expect(h2.result).resolves.toBe("fresh");
        });

        it("allows a fresh run after a crash that propagated to attachers", async () => {
            const ep = makeExclusiveProcess();
            const deferred = makeDeferred();

            const h1 = ep.invoke(() => deferred.promise);
            const h2 = ep.invoke(() => Promise.resolve());

            deferred.reject(new Error("crash"));
            await Promise.all([
                h1.result.catch(() => {}),
                h2.result.catch(() => {}),
            ]);

            const h3 = ep.invoke(() => Promise.resolve("new-run"));
            expect(h3.isInitiator).toBe(true);
            await expect(h3.result).resolves.toBe("new-run");
        });
    });

    describe("isExclusiveProcess type guard", () => {
        it("returns true for an ExclusiveProcess", () => {
            expect(isExclusiveProcess(makeExclusiveProcess())).toBe(true);
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
            const ep = makeExclusiveProcess();
            const deferred = makeDeferred();
            const handle = ep.invoke(() => deferred.promise);
            expect(isExclusiveProcessHandle(handle)).toBe(true);
            deferred.resolve();
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
            const ep = makeExclusiveProcess();
            expect(ep.isRunning()).toBe(false);
        });

        it("returns true while a computation is active", () => {
            const ep = makeExclusiveProcess();
            const deferred = makeDeferred();
            ep.invoke(() => deferred.promise);
            expect(ep.isRunning()).toBe(true);
            deferred.resolve();
        });

        it("returns false after a successful run completes", async () => {
            const ep = makeExclusiveProcess();
            await ep.invoke(() => Promise.resolve("done")).result;
            expect(ep.isRunning()).toBe(false);
        });

        it("returns false after a failed run completes", async () => {
            const ep = makeExclusiveProcess();
            await ep.invoke(() => Promise.reject(new Error("fail"))).result.catch(() => {});
            expect(ep.isRunning()).toBe(false);
        });
    });

    describe("sequential runs", () => {
        it("allows a second run after the first completes", async () => {
            const ep = makeExclusiveProcess();
            const calls = [];

            const h1 = ep.invoke(async () => {
                calls.push(1);
                return "first";
            });
            await h1.result;

            const h2 = ep.invoke(async () => {
                calls.push(2);
                return "second";
            });
            await h2.result;

            expect(calls).toEqual([1, 2]);
            expect(h1.isInitiator).toBe(true);
            expect(h2.isInitiator).toBe(true);
        });

        it("processes a run of 3 sequential invocations correctly", async () => {
            const ep = makeExclusiveProcess();
            const results = [];

            for (let i = 0; i < 3; i++) {
                const n = i;
                // Each invoke waits for the previous to finish before starting.
                await ep.invoke(() => Promise.resolve(n)).result.then((v) => results.push(v));
            }

            expect(results).toEqual([0, 1, 2]);
        });
    });
});
