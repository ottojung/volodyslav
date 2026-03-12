const { make } = require('../src/sleeper');
const { makeUniqueFunctor } = require('../src/unique_functor');

let uniqueCounter = 0;

function makeKey() {
    uniqueCounter += 1;
    const functor = makeUniqueFunctor(`sleeper-mutex-test-${uniqueCounter}-${Math.random()}`);
    return functor.instantiate(['resource']);
}

describe('sleeper.withMutex', () => {
    it('runs concurrent calls with the same key sequentially', async () => {
        const sleeper = make();
        const key = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        const first = sleeper.withMutex(key, async () => {
            trace.push('first-start');
            await new Promise((resolve) => setTimeout(resolve, 30));
            trace.push('first-end');
        });

        const second = sleeper.withMutex(key, async () => {
            trace.push('second-start');
            trace.push('second-end');
        });

        await Promise.all([first, second]);

        expect(trace).toEqual([
            'first-start',
            'first-end',
            'second-start',
            'second-end',
        ]);
    });

    it('allows concurrent calls with different keys', async () => {
        const sleeper = make();
        const key1 = makeKey();
        const key2 = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        const first = sleeper.withMutex(key1, async () => {
            trace.push('first-start');
            await new Promise((resolve) => setTimeout(resolve, 30));
            trace.push('first-end');
        });

        const second = sleeper.withMutex(key2, async () => {
            trace.push('second-start');
            trace.push('second-end');
        });

        await Promise.all([first, second]);

        // second finishes before first because key2 is uncontested
        expect(trace).toEqual([
            'first-start',
            'second-start',
            'second-end',
            'first-end',
        ]);
    });

    it('propagates the return value', async () => {
        const sleeper = make();
        const key = makeKey();
        const result = await sleeper.withMutex(key, async () => 42);
        expect(result).toBe(42);
    });

    it('propagates thrown errors and releases the mutex', async () => {
        const sleeper = make();
        const key = makeKey();

        await expect(
            sleeper.withMutex(key, async () => {
                throw new Error('inner error');
            })
        ).rejects.toThrow('inner error');

        // The mutex must have been released — a subsequent call succeeds.
        const result = await sleeper.withMutex(key, async () => 'ok');
        expect(result).toBe('ok');
    });

    it('queues multiple waiters and runs them in FIFO order', async () => {
        const sleeper = make();
        const key = makeKey();

        /** @type {Array<number>} */
        const order = [];

        const tasks = [1, 2, 3, 4].map((n) =>
            sleeper.withMutex(key, async () => {
                order.push(n);
            })
        );

        await Promise.all(tasks);
        expect(order).toEqual([1, 2, 3, 4]);
    });
});

describe('sleeper.withoutMutex', () => {
    it('throws when called outside a withMutex callback', async () => {
        const sleeper = make();
        const key = makeKey();

        await expect(
            sleeper.withoutMutex(key, async () => 'nope')
        ).rejects.toThrow('withoutMutex');
    });

    it('allows another withMutex caller to run while the procedure executes', async () => {
        const sleeper = make();
        const key = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        // Start a waiter before the outer withMutex acquires, so it is queued.
        // We need a way to synchronise: start the outer first, let it release,
        // then the waiter should run concurrently with the procedure.
        let resolveBarrier = () => undefined;
        const barrier = new Promise((resolve) => { resolveBarrier = resolve; });

        const outer = sleeper.withMutex(key, async () => {
            trace.push('outer-start');
            // Let the second caller queue itself now that we hold the mutex.
            resolveBarrier();
            await sleeper.withoutMutex(key, async () => {
                trace.push('procedure-start');
                // Give the second caller a tick to run.
                await new Promise((resolve) => setTimeout(resolve, 20));
                trace.push('procedure-end');
            });
            trace.push('outer-end');
        });

        // Wait until the outer has the mutex, then queue the second caller.
        await barrier;
        const inner = sleeper.withMutex(key, async () => {
            trace.push('inner-start');
            trace.push('inner-end');
        });

        await Promise.all([outer, inner]);

        // The inner caller runs while the procedure is executing (mutex released).
        expect(trace).toEqual([
            'outer-start',
            'procedure-start',
            'inner-start',
            'inner-end',
            'procedure-end',
            'outer-end',
        ]);
    });

    it('re-acquires the mutex before returning, blocking further callers', async () => {
        const sleeper = make();
        const key = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        await sleeper.withMutex(key, async () => {
            trace.push('before-withoutMutex');
            await sleeper.withoutMutex(key, async () => {
                trace.push('inside-procedure');
            });
            // Back inside withMutex — the following code has the mutex.
            trace.push('after-withoutMutex');
        });

        expect(trace).toEqual([
            'before-withoutMutex',
            'inside-procedure',
            'after-withoutMutex',
        ]);
    });

    it('propagates the return value from the procedure', async () => {
        const sleeper = make();
        const key = makeKey();

        const result = await sleeper.withMutex(key, async () => {
            return sleeper.withoutMutex(key, async () => 99);
        });

        expect(result).toBe(99);
    });

    it('re-acquires the mutex even when the procedure throws', async () => {
        const sleeper = make();
        const key = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        await expect(
            sleeper.withMutex(key, async () => {
                trace.push('before');
                await sleeper.withoutMutex(key, async () => {
                    throw new Error('procedure error');
                });
                trace.push('after'); // should not reach
            })
        ).rejects.toThrow('procedure error');

        // The mutex must have been released.
        const result = await sleeper.withMutex(key, async () => 'unlocked');
        expect(result).toBe('unlocked');

        // 'after' was never pushed
        expect(trace).toEqual(['before']);
    });

    it('releases the outer mutex when withMutex finishes after withoutMutex', async () => {
        const sleeper = make();
        const key = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        let resolveBarrier = () => undefined;
        const barrier = new Promise((resolve) => { resolveBarrier = resolve; });
        let resolveWaitersQueued = () => undefined;
        const waitersQueued = new Promise((resolve) => { resolveWaitersQueued = resolve; });

        const outer = sleeper.withMutex(key, async () => {
            // Signal that we hold the mutex.
            resolveBarrier();
            // Wait for `after` to be queued before we release via withoutMutex.
            await waitersQueued;
            await sleeper.withoutMutex(key, async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
            });
            trace.push('outer-done');
        });

        // Queue `after` while outer holds the mutex.
        await barrier;
        const after = sleeper.withMutex(key, async () => {
            trace.push('after-done');
        });
        resolveWaitersQueued();

        await Promise.all([outer, after]);

        // `after` runs while the 10 ms procedure executes (mutex temporarily released).
        // withoutMutex then re-acquires; outer-done is pushed.
        // The outer finally block releases the mutex — outer-done comes last.
        expect(trace).toEqual(['after-done', 'outer-done']);
    });

    it('multiple concurrent withMutex waiters are queued while procedure runs', async () => {
        const sleeper = make();
        const key = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        let resolveBarrier = () => undefined;
        const barrier = new Promise((resolve) => { resolveBarrier = resolve; });
        let resolveWaitersQueued = () => undefined;
        const waitersQueued = new Promise((resolve) => { resolveWaitersQueued = resolve; });

        const outer = sleeper.withMutex(key, async () => {
            resolveBarrier();
            // Wait for all waiters to be queued before we release via withoutMutex.
            await waitersQueued;
            await sleeper.withoutMutex(key, async () => {
                // long enough for all three waiters to run during this period
                await new Promise((resolve) => setTimeout(resolve, 40));
                trace.push('procedure');
            });
            trace.push('outer-end');
        });

        await barrier;

        const waiter1 = sleeper.withMutex(key, async () => { trace.push('w1'); });
        const waiter2 = sleeper.withMutex(key, async () => { trace.push('w2'); });
        const waiter3 = sleeper.withMutex(key, async () => { trace.push('w3'); });

        resolveWaitersQueued();

        await Promise.all([outer, waiter1, waiter2, waiter3]);

        // w1, w2, w3 run while the 40 ms procedure executes (mutex released).
        // Then procedure fires, withoutMutex re-acquires, outer-end is pushed.
        const waiters = new Set(trace.slice(0, 3));
        expect(waiters).toEqual(new Set(['w1', 'w2', 'w3']));
        expect(trace[3]).toBe('procedure');
        expect(trace[4]).toBe('outer-end');
    });

    it('does not interfere with a different key', async () => {
        const sleeper = make();
        const key1 = makeKey();
        const key2 = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        let resolveBarrier = () => undefined;
        const barrier = new Promise((resolve) => { resolveBarrier = resolve; });

        const outer = sleeper.withMutex(key1, async () => {
            resolveBarrier();
            await sleeper.withoutMutex(key1, async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                trace.push('outer-procedure');
            });
        });

        await barrier;
        // key2 should run independently of key1's withoutMutex
        const unrelated = sleeper.withMutex(key2, async () => {
            trace.push('unrelated');
        });

        await Promise.all([outer, unrelated]);

        // Both run — unrelated finishes first because key2 is uncontested
        expect(trace).toContain('outer-procedure');
        expect(trace).toContain('unrelated');
        expect(trace[0]).toBe('unrelated');
    });

    it('withoutMutex called after the mutex is not held throws', async () => {
        const sleeper = make();
        const key = makeKey();

        // Acquire and release, then try withoutMutex outside
        await sleeper.withMutex(key, async () => { /* done */ });

        await expect(
            sleeper.withoutMutex(key, async () => 'bad')
        ).rejects.toThrow('withoutMutex');
    });

    it('withMutex on a different key from withoutMutex is independent', async () => {
        const sleeper = make();
        const key1 = makeKey();
        const key2 = makeKey();

        // withoutMutex on key2 while holding key1 should throw
        await expect(
            sleeper.withMutex(key1, async () => {
                await sleeper.withoutMutex(key2, async () => 'nope');
            })
        ).rejects.toThrow('withoutMutex');
    });
});
