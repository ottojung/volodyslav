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

describe('sleeper.withModeMutex', () => {
    it('allows concurrent calls with the same key and mode', async () => {
        const sleeper = make();
        const key = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        const first = sleeper.withModeMutex(key, 'pull', async () => {
            trace.push('first-start');
            await new Promise((resolve) => setTimeout(resolve, 30));
            trace.push('first-end');
        });

        const second = sleeper.withModeMutex(key, 'pull', async () => {
            trace.push('second-start');
            trace.push('second-end');
        });

        await Promise.all([first, second]);

        expect(trace).toEqual([
            'first-start',
            'second-start',
            'second-end',
            'first-end',
        ]);
    });

    it('serializes calls with the same key and different modes', async () => {
        const sleeper = make();
        const key = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        const first = sleeper.withModeMutex(key, 'pull', async () => {
            trace.push('pull-start');
            await new Promise((resolve) => setTimeout(resolve, 30));
            trace.push('pull-end');
        });

        const second = sleeper.withModeMutex(key, 'inspect', async () => {
            trace.push('inspect-start');
            trace.push('inspect-end');
        });

        await Promise.all([first, second]);

        expect(trace).toEqual([
            'pull-start',
            'pull-end',
            'inspect-start',
            'inspect-end',
        ]);
    });

    it('does not let same-mode callers bypass an earlier queued different mode', async () => {
        const sleeper = make();
        const key = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        let resolveBarrier = () => undefined;
        const barrier = new Promise((resolve) => { resolveBarrier = resolve; });

        const firstPull = sleeper.withModeMutex(key, 'pull', async () => {
            trace.push('pull-1-start');
            resolveBarrier();
            await new Promise((resolve) => setTimeout(resolve, 20));
            trace.push('pull-1-end');
        });

        await barrier;

        const inspect = sleeper.withModeMutex(key, 'inspect', async () => {
            trace.push('inspect-start');
            await new Promise((resolve) => setTimeout(resolve, 10));
            trace.push('inspect-end');
        });
        const secondPull = sleeper.withModeMutex(key, 'pull', async () => {
            trace.push('pull-2-start');
            trace.push('pull-2-end');
        });

        await Promise.all([firstPull, inspect, secondPull]);

        expect(trace).toEqual([
            'pull-1-start',
            'pull-1-end',
            'inspect-start',
            'inspect-end',
            'pull-2-start',
            'pull-2-end',
        ]);
    });

    it('releases queued callers even when the procedure throws', async () => {
        const sleeper = make();
        const key = makeKey();

        await expect(
            sleeper.withModeMutex(key, 'pull', async () => {
                throw new Error('mode failure');
            })
        ).rejects.toThrow('mode failure');

        const result = await sleeper.withModeMutex(key, 'inspect', async () => 'ok');
        expect(result).toBe('ok');
    });

    it('allows different keys to proceed independently even with different modes', async () => {
        const sleeper = make();
        const key1 = makeKey();
        const key2 = makeKey();

        /** @type {Array<string>} */
        const trace = [];

        const first = sleeper.withModeMutex(key1, 'pull', async () => {
            trace.push('key1-start');
            await new Promise((resolve) => setTimeout(resolve, 20));
            trace.push('key1-end');
        });

        const second = sleeper.withModeMutex(key2, 'inspect', async () => {
            trace.push('key2-start');
            trace.push('key2-end');
        });

        await Promise.all([first, second]);

        expect(trace).toEqual([
            'key1-start',
            'key2-start',
            'key2-end',
            'key1-end',
        ]);
    });
});
