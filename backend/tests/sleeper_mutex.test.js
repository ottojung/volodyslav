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
});
