/**
 * Tests for the deployment configuration point of the canonical-bootstrap source.
 *
 * `incremental-graph-journal-migrations.md` §4 owns the decision and names the
 * transport-neutral `CohortBootstrapSource`; `database-lifecycle.md` Part II §23
 * owns the gate that consumes it. The source is deployment configuration rather
 * than persisted database state, so the root capabilities are where a deployment
 * supplies one, and the cases here are every shape that configuration can take:
 * absent, present and valid, and present but not a source.
 */

const capabilitiesRoot = require('../src/capabilities/root');
const {
    isCohortBootstrapSource,
    makeCohortBootstrapSource,
    makeJournalPublicationError,
    isJournalPublicationError,
} = require('../src/generators/incremental_graph/journal');

/**
 * A source whose slot is empty, which is the shape a deployment builds first.
 * @returns {import('../src/generators/incremental_graph/journal').CohortBootstrapSource}
 */
function makeAbsentSource() {
    const source = makeCohortBootstrapSource({
        queryCanonicalBootstrap: () => null,
        publishCanonicalBootstrapIfAbsent: () => undefined,
    });
    if (!isCohortBootstrapSource(source)) {
        throw new Error('the fixture source is not a cohort bootstrap source');
    }
    return source;
}

describe('configuring the cohort bootstrap source on the root capabilities', () => {
    test('no configuration means no source, which is the fail-closed default', () => {
        const capabilities = capabilitiesRoot.make();
        expect(capabilities.cohortBootstrapSource).toBeUndefined();
    });

    test('an explicit absent source is the same as no configuration', () => {
        const capabilities = capabilitiesRoot.make({ cohortBootstrapSource: undefined });
        expect(capabilities.cohortBootstrapSource).toBeUndefined();
    });

    test('a configured source is carried on the capabilities by identity', () => {
        const source = makeAbsentSource();
        const capabilities = capabilitiesRoot.make({ cohortBootstrapSource: source });
        expect(capabilities.cohortBootstrapSource).toBe(source);
        expect(isCohortBootstrapSource(capabilities.cohortBootstrapSource)).toBe(true);
    });

    test('two configured capability sets carry their own sources', () => {
        const first = capabilitiesRoot.make({ cohortBootstrapSource: makeAbsentSource() });
        const second = capabilitiesRoot.make({ cohortBootstrapSource: makeAbsentSource() });
        expect(first.cohortBootstrapSource).not.toBe(second.cohortBootstrapSource);
        expect(first.interface).not.toBe(second.interface);
    });

    test('a plain object with the two operations is refused, because the source is nominal', () => {
        expect(() =>
            capabilitiesRoot.make({
                cohortBootstrapSource: {
                    queryCanonicalBootstrap: () => null,
                    publishCanonicalBootstrapIfAbsent: () => undefined,
                },
            })
        ).toThrow(/not a CohortBootstrapSource/);
    });

    test('each refused shape fails with a JournalPublicationError by name', () => {
        /** @type {unknown[]} */
        const refused = [{}, 0, 'source', [], () => undefined, { queryCanonicalBootstrap: () => null }];
        for (const value of refused) {
            let thrown;
            try {
                capabilitiesRoot.make({ cohortBootstrapSource: value });
            } catch (error) {
                thrown = error;
            }
            if (!isJournalPublicationError(thrown)) {
                throw new Error(`configuring ${JSON.stringify(value)} did not fail with a JournalPublicationError`);
            }
        }
    });

    test('the refusal is the same error the canonical-bootstrap gate itself raises', () => {
        const expected = makeJournalPublicationError('the deployment configured a cohort bootstrap source which is not a CohortBootstrapSource, so the canonical-bootstrap slot could not be arbitrated');
        let thrown;
        try {
            capabilitiesRoot.make({ cohortBootstrapSource: {} });
        } catch (error) {
            thrown = error;
        }
        expect(isJournalPublicationError(thrown) && thrown.message).toBe(expected.message);
    });
});