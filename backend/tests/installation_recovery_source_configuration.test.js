/**
 * Tests for the deployment configuration point of the installation recovery source.
 *
 * `database-lifecycle.md` §4 owns the absent-state decision and names the
 * transport-neutral `InstallationRecoverySource`; `database-boot-sequence.md` §7.1
 * owns the startup step which consumes it. The source is deployment configuration
 * rather than persisted database state, so the root capabilities are where a
 * deployment supplies one, and the cases here are every shape that configuration
 * can take: absent, present and valid, and present but not a source.
 */

const capabilitiesRoot = require('../src/capabilities/root');
const {
    makeInstallationRecoverySource,
    isInstallationRecoverySource,
} = require('../src/generators/incremental_graph/journal_recovery_source');
const {
    makeJournalPublicationError,
    isJournalPublicationError,
} = require('../src/generators/incremental_graph/journal');

/**
 * A source whose slot is empty, which is the shape a deployment builds first.
 * @returns {import('../src/generators/incremental_graph/journal_recovery_source').InstallationRecoverySource}
 */
function makeAbsentSource() {
    const source = makeInstallationRecoverySource({
        async queryInstallationRecovery() {
            return null;
        },
    });
    if (!isInstallationRecoverySource(source)) {
        throw new Error('the fixture source is not an installation recovery source');
    }
    return source;
}

describe('configuring the installation recovery source on the root capabilities', () => {
    test('no configuration means no source, which is the fail-closed default', () => {
        const capabilities = capabilitiesRoot.make();
        expect(capabilities.installationRecoverySource).toBeUndefined();
    });

    test('an explicitly absent source is the same as no configuration', () => {
        const capabilities = capabilitiesRoot.make({ installationRecoverySource: undefined });
        expect(capabilities.installationRecoverySource).toBeUndefined();
    });

    test('a configured source is carried on the capabilities by identity', () => {
        const source = makeAbsentSource();
        const capabilities = capabilitiesRoot.make({ installationRecoverySource: source });
        expect(capabilities.installationRecoverySource).toBe(source);
        expect(isInstallationRecoverySource(capabilities.installationRecoverySource)).toBe(true);
    });

    test('two configured capability sets carry their own sources', () => {
        const first = capabilitiesRoot.make({ installationRecoverySource: makeAbsentSource() });
        const second = capabilitiesRoot.make({ installationRecoverySource: makeAbsentSource() });
        expect(first.installationRecoverySource).not.toBe(second.installationRecoverySource);
        expect(first.interface).not.toBe(second.interface);
    });

    test('a plain object with the one operation is refused, because the source is nominal', () => {
        expect(() =>
            capabilitiesRoot.make({
                installationRecoverySource: { queryInstallationRecovery: () => null },
            })
        ).toThrow(/not an InstallationRecoverySource/);
    });

    test('each refused shape fails with a JournalPublicationError by name', () => {
        /** @type {unknown[]} */
        const refused = [{}, 0, 'source', [], () => undefined, { queryInstallationRecovery: null }];
        const thrown = refused.map((value) => {
            try {
                capabilitiesRoot.make({ installationRecoverySource: value });
            } catch (error) {
                return error;
            }
            return undefined;
        });
        expect(thrown).toHaveLength(refused.length);
        expect(thrown.every((error) => isJournalPublicationError(error))).toBe(true);
    });

    test('the refusal names the decision which could not be made', () => {
        const expected = makeJournalPublicationError(
            'the deployment configured an installation recovery source which is not an InstallationRecoverySource, ' +
                'so the absent-state decision could not be made'
        );
        let thrown;
        try {
            capabilitiesRoot.make({ installationRecoverySource: {} });
        } catch (error) {
            thrown = error;
        }
        expect(isJournalPublicationError(thrown) && thrown.message).toBe(expected.message);
    });
});
