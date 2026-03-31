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

// Helper: make a procedure that ignores the fanOut and runs a simple async fn.
// procedure: (fanOut) => (arg) => Promise<T>
function simpleProcedure(fn) {
    return (_fanOut) => (arg) => fn(arg);
}

describe("ExclusiveProcess", () => {
    describe("makeExclusiveProcess", () => {
        it("returns an ExclusiveProcess instance", () => {
            const ep = makeExclusiveProcess(simpleProcedure(() => Promise.resolve()));
            expect(isExclusiveProcess(ep)).toBe(true);
        });

        it("creates independent instances that do not share state", () => {
            const deferred = makeDeferred();
            const ep1 = makeExclusiveProcess(simpleProcedure(() => deferred.promise));
            const ep2 = makeExclusiveProcess(simpleProcedure(() => deferred.promise));

            const h1 = ep1.invoke(undefined);
            expect(h1.isInitiator).toBe(true);

            // ep2 is idle — also an initiator
            const h2 = ep2.invoke(undefined);
            expect(h2.isInitiator).toBe(true);

            deferred.resolve();
        });

        it("procedure receives the argument", async () => {
            let received;
            const ep = makeExclusiveProcess((_fanOut) => (arg) => {
                received = arg;
                return Promise.resolve();
            });
            await ep.invoke("hello").result;
            expect(received).toBe("hello");
        });

        it("procedure receives the fanOut callback", async () => {
            const events = [];
            const ep = makeExclusiveProcess((fanOut) => (_arg) => {
                fanOut("event-1");
                fanOut("event-2");
                return Promise.resolve();
            });
            await ep.invoke(undefined, (e) => events.push(e)).result;
            expect(events).toEqual(["event-1", "event-2"]);
        });
    });

    describe("invoke — idle process", () => {
        it("starts the procedure and returns an initiator handle", async () => {
            let called = false;
            const ep = makeExclusiveProcess(simpleProcedure(async () => {
                called = true;
                return 42;
            }));

            const handle = ep.invoke(undefined);

            expect(isExclusiveProcessHandle(handle)).toBe(true);
            expect(handle.isInitiator).toBe(true);
            await expect(handle.result).resolves.toBe(42);
            expect(called).toBe(true);
        });

        it("resets to idle after a successful run", async () => {
            let run = 0;
            const ep = makeExclusiveProcess(simpleProcedure(() => Promise.resolve(++run)));

            await ep.invoke(undefined).result;

            const h = ep.invoke(undefined);
            expect(h.isInitiator).toBe(true);
            await expect(h.result).resolves.toBe(2);
        });

        it("resets to idle after a failed run", async () => {
            let fail = true;
            const ep = makeExclusiveProcess(simpleProcedure(() =>
                fail ? Promise.reject(new Error("boom")) : Promise.resolve("recovered")
            ));

            await ep.invoke(undefined).result.catch(() => {});

            fail = false;
            const h = ep.invoke(undefined);
            expect(h.isInitiator).toBe(true);
            await expect(h.result).resolves.toBe("recovered");
        });

        it("handles a synchronously throwing procedure", async () => {
            const ep = makeExclusiveProcess((_fanOut) => (_arg) => {
                throw new Error("sync throw");
            });

            const handle = ep.invoke(undefined);

            expect(handle.isInitiator).toBe(true);
            await expect(handle.result).rejects.toThrow("sync throw");

            // Process should be idle again — a new invoke should be an initiator
            const ep2 = makeExclusiveProcess(simpleProcedure(() => Promise.resolve("ok")));
            const h2 = ep2.invoke(undefined);
            expect(h2.isInitiator).toBe(true);
            await h2.result;
        });
    });

    describe("invoke — running process (attaching)", () => {
        it("returns an attacher handle when a run is already in progress", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess(simpleProcedure(() => deferred.promise));

            const h1 = ep.invoke(undefined);
            const h2 = ep.invoke(undefined);

            expect(h1.isInitiator).toBe(true);
            expect(h2.isInitiator).toBe(false);

            deferred.resolve("result");
            await Promise.all([h1.result, h2.result]);
        });

        it("attacher shares the same result promise as the initiator", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess(simpleProcedure(() => deferred.promise));

            const h1 = ep.invoke(undefined);
            const h2 = ep.invoke(undefined);

            deferred.resolve("shared-value");

            const [r1, r2] = await Promise.all([h1.result, h2.result]);
            expect(r1).toBe("shared-value");
            expect(r2).toBe("shared-value");
        });

        it("procedure only runs once even with multiple concurrent invocations", async () => {
            const deferred = makeDeferred();
            let procedureCallCount = 0;
            const ep = makeExclusiveProcess((_fanOut) => (_arg) => {
                procedureCallCount++;
                return deferred.promise;
            });

            ep.invoke(undefined);
            ep.invoke(undefined);
            ep.invoke(undefined);

            deferred.resolve();
            await deferred.promise;
            await new Promise((r) => setTimeout(r, 0));

            expect(procedureCallCount).toBe(1);
        });

        it("multiple attachers all receive the same result", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess(simpleProcedure(() => deferred.promise));

            const handles = [
                ep.invoke(undefined),
                ep.invoke(undefined),
                ep.invoke(undefined),
                ep.invoke(undefined),
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

    describe("native callback fan-out", () => {
        it("fanOut distributes events to all callers (initiator + attachers)", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess((fanOut) => (_arg) => {
                deferred.promise.then(() => {
                    fanOut("event-A");
                    fanOut("event-B");
                });
                return deferred.promise.then(() => "done");
            });

            const cb1 = [];
            const cb2 = [];
            const cb3 = [];

            const h1 = ep.invoke(undefined, (e) => cb1.push(e));
            const h2 = ep.invoke(undefined, (e) => cb2.push(e));
            const h3 = ep.invoke(undefined, (e) => cb3.push(e));

            deferred.resolve();
            await Promise.all([h1.result, h2.result, h3.result]);

            expect(cb1).toEqual(["event-A", "event-B"]);
            expect(cb2).toEqual(["event-A", "event-B"]);
            expect(cb3).toEqual(["event-A", "event-B"]);
        });

        it("fanOut does not call callbacks of callers that haven't registered one", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess((fanOut) => (_arg) => {
                deferred.promise.then(() => fanOut("event"));
                return deferred.promise.then(() => "done");
            });

            const cb1 = [];
            ep.invoke(undefined, (e) => cb1.push(e));
            ep.invoke(undefined); // no callback
            ep.invoke(undefined, null); // explicit null

            deferred.resolve();
            await deferred.promise;
            await new Promise((r) => setImmediate(r));

            // Only cb1 should receive events
            expect(cb1).toEqual(["event"]);
        });

        it("callbacks registered by attachers receive events emitted after attachment", async () => {
            let emitEvent;
            const ep = makeExclusiveProcess((fanOut) => (_arg) => {
                return new Promise((resolve) => {
                    emitEvent = (e) => {
                        fanOut(e);
                        resolve("done");
                    };
                });
            });

            const cb1 = [];
            const cb2 = [];

            ep.invoke(undefined, (e) => cb1.push(e));
            // Attach after run starts
            ep.invoke(undefined, (e) => cb2.push(e));

            emitEvent("late-event");

            await new Promise((r) => setImmediate(r));

            expect(cb1).toEqual(["late-event"]);
            expect(cb2).toEqual(["late-event"]);
        });

        it("callbacks are cleared between runs of the same EP", async () => {
            const firstRunEvents = [];
            const secondRunEvents = [];
            let runCount = 0;
            const deferreds = [makeDeferred(), makeDeferred()];

            const ep = makeExclusiveProcess((fanOut) => (_arg) => {
                const d = deferreds[runCount++];
                d.promise.then(() => fanOut(`event-${runCount}`));
                return d.promise.then(() => "done");
            });

            // First run with callback
            const h1 = ep.invoke(undefined, (e) => firstRunEvents.push(e));
            deferreds[0].resolve();
            await h1.result;

            // Second run with a DIFFERENT callback
            const h2 = ep.invoke(undefined, (e) => secondRunEvents.push(e));
            deferreds[1].resolve();
            await h2.result;

            // Each run only received events from its own run
            expect(firstRunEvents).toEqual(["event-1"]);
            expect(secondRunEvents).toEqual(["event-2"]);
        });
    });

    describe("shouldQueue", () => {
        it("queues a conflicting call instead of attaching", async () => {
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();
            let callIndex = 0;
            const deferreds = [deferred1, deferred2];
            const ep = makeExclusiveProcess(
                simpleProcedure((type) => deferreds[callIndex++].promise),
                (currentArg, newArg) => currentArg !== newArg
            );

            const h1 = ep.invoke("A");
            const h2 = ep.invoke("B"); // conflicts → queue

            expect(h1.isInitiator).toBe(true);
            expect(h2.isInitiator).toBe(false);
            expect(h1.result).not.toBe(h2.result);

            deferred1.resolve("result-A");
            await h1.result;
            await new Promise((r) => setImmediate(r));

            // B should now be running
            expect(callIndex).toBe(2);
            deferred2.resolve("result-B");
            await expect(h2.result).resolves.toBe("result-B");
        });

        it("last-write-wins when multiple conflicting calls queue up", async () => {
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();
            let callIndex = 0;
            const capturedArgs = [];
            const ep = makeExclusiveProcess(
                (_fanOut) => (type) => {
                    capturedArgs.push(type);
                    return [deferred1, deferred2][callIndex++].promise;
                },
                (cur, nw) => cur !== nw
            );

            ep.invoke("A");
            const h2a = ep.invoke("B");
            const h2b = ep.invoke("C"); // overwrites B

            // Both h2a and h2b share the same pending promise
            expect(h2a.result).toBe(h2b.result);

            deferred1.resolve();
            await new Promise((r) => setImmediate(r));

            // The queued run used last-write "C"
            expect(capturedArgs[1]).toBe("C");
            deferred2.resolve("done");
            await Promise.all([h2a.result, h2b.result]);
        });

        it("compatible call attaches even when shouldQueue is defined", async () => {
            const deferred = makeDeferred();
            let calls = 0;
            const ep = makeExclusiveProcess(
                (_fanOut) => (_arg) => { calls++; return deferred.promise; },
                (cur, nw) => cur !== nw
            );

            const h1 = ep.invoke("same");
            const h2 = ep.invoke("same"); // same → attach

            expect(h1.result).toBe(h2.result);
            expect(calls).toBe(1);
            deferred.resolve("ok");
            await Promise.all([h1.result, h2.result]);
        });

        it("queued run starts after initiator crashes", async () => {
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();
            let callIndex = 0;
            const ep = makeExclusiveProcess(
                simpleProcedure((_v) => [deferred1, deferred2][callIndex++].promise),
                (c, n) => c !== n
            );

            const h1 = ep.invoke("A");
            const h2 = ep.invoke("B");

            deferred1.reject(new Error("A-crashed"));
            await h1.result.catch(() => {});
            await new Promise((r) => setImmediate(r));

            // Queued run B should have started
            expect(callIndex).toBe(2);
            deferred2.resolve("B-ok");
            await expect(h2.result).resolves.toBe("B-ok");
        });

        it("queued callbacks are forwarded to the next run's fanOut", async () => {
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();
            let callIndex = 0;

            const events1 = [];
            const events2 = [];

            const ep = makeExclusiveProcess(
                (fanOut) => (arg) => {
                    const d = [deferred1, deferred2][callIndex++];
                    d.promise.then(() => fanOut(`event-from-${arg}`));
                    return d.promise.then(() => `done-${arg}`);
                },
                (cur, nw) => cur !== nw
            );

            const h1 = ep.invoke("A", (e) => events1.push(e));
            const h2 = ep.invoke("B", (e) => events2.push(e)); // queued

            deferred1.resolve();
            await h1.result;
            await new Promise((r) => setImmediate(r));

            // B's run is now active
            deferred2.resolve();
            await h2.result;

            // A's callback only received events from A's run
            expect(events1).toEqual(["event-from-A"]);
            // B's callback only received events from B's run
            expect(events2).toEqual(["event-from-B"]);
        });
    });

    describe("error propagation", () => {
        it("propagates errors to the initiator", async () => {
            const ep = makeExclusiveProcess(simpleProcedure(() => Promise.reject(new Error("failure"))));

            const handle = ep.invoke(undefined);

            await expect(handle.result).rejects.toThrow("failure");
        });

        it("propagates errors to all attachers", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess(simpleProcedure(() => deferred.promise));

            const h1 = ep.invoke(undefined);
            const h2 = ep.invoke(undefined);
            const h3 = ep.invoke(undefined);

            deferred.reject(new Error("pipeline crashed"));

            await Promise.all([
                expect(h1.result).rejects.toThrow("pipeline crashed"),
                expect(h2.result).rejects.toThrow("pipeline crashed"),
                expect(h3.result).rejects.toThrow("pipeline crashed"),
            ]);
        });

        it("allows a fresh run after a crash", async () => {
            let fail = true;
            const ep = makeExclusiveProcess(simpleProcedure(() =>
                fail ? Promise.reject(new Error("crash")) : Promise.resolve("fresh")
            ));

            const h1 = ep.invoke(undefined);
            await h1.result.catch(() => {});

            fail = false;
            const h2 = ep.invoke(undefined);
            expect(h2.isInitiator).toBe(true);
            await expect(h2.result).resolves.toBe("fresh");
        });

        it("allows a fresh run after a crash that propagated to attachers", async () => {
            const deferred = makeDeferred();
            let fail = true;
            const ep = makeExclusiveProcess(simpleProcedure(() =>
                fail ? deferred.promise : Promise.resolve("new-run")
            ));

            const h1 = ep.invoke(undefined);
            const h2 = ep.invoke(undefined);

            deferred.reject(new Error("crash"));
            await Promise.all([
                h1.result.catch(() => {}),
                h2.result.catch(() => {}),
            ]);

            fail = false;
            const h3 = ep.invoke(undefined);
            expect(h3.isInitiator).toBe(true);
            await expect(h3.result).resolves.toBe("new-run");
        });
    });

    describe("isExclusiveProcess type guard", () => {
        it("returns true for an ExclusiveProcess", () => {
            expect(isExclusiveProcess(makeExclusiveProcess(simpleProcedure(() => Promise.resolve())))).toBe(true);
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
            const ep = makeExclusiveProcess(simpleProcedure(() => deferred.promise));
            const handle = ep.invoke(undefined);
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
            const ep = makeExclusiveProcess(simpleProcedure(() => Promise.resolve()));
            expect(ep.isRunning()).toBe(false);
        });

        it("returns true while a computation is active", () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess(simpleProcedure(() => deferred.promise));
            ep.invoke(undefined);
            expect(ep.isRunning()).toBe(true);
            deferred.resolve();
        });

        it("returns false after a successful run completes", async () => {
            const ep = makeExclusiveProcess(simpleProcedure(() => Promise.resolve("done")));
            await ep.invoke(undefined).result;
            expect(ep.isRunning()).toBe(false);
        });

        it("returns false after a failed run completes", async () => {
            const ep = makeExclusiveProcess(simpleProcedure(() => Promise.reject(new Error("fail"))));
            await ep.invoke(undefined).result.catch(() => {});
            expect(ep.isRunning()).toBe(false);
        });
    });

    describe("sequential runs", () => {
        it("allows a second run after the first completes", async () => {
            let runCount = 0;
            const ep = makeExclusiveProcess(simpleProcedure(async () => ++runCount));

            const h1 = ep.invoke(undefined);
            await h1.result;

            const h2 = ep.invoke(undefined);
            await h2.result;

            expect(runCount).toBe(2);
            expect(h1.isInitiator).toBe(true);
            expect(h2.isInitiator).toBe(true);
        });

        it("processes sequential invocations correctly", async () => {
            let runCount = 0;
            const ep = makeExclusiveProcess(simpleProcedure(async () => ++runCount));
            const results = [];

            for (let i = 0; i < 3; i++) {
                await ep.invoke(undefined).result.then((v) => results.push(v));
            }

            expect(results).toEqual([1, 2, 3]);
        });
    });
});
