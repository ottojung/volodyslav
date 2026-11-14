/** Root capabilities must not grow with Journal 3 transport decisions. */
const { make } = require('../src/capabilities/root');

test('root exposes only the established capability surface', () => {
    const keys = Object.keys(make()).sort();
    expect(keys).toEqual([
        'aiCalories', 'aiDiaryQuestions', 'aiDiarySummary',
        'aiTranscriptRecombination', 'aiTranscription', 'appender',
        'checker', 'copier', 'creator', 'datetime', 'deleter', 'environment',
        'exiter', 'git', 'interface', 'levelDatabase', 'logger', 'mover',
        'notifier', 'reader', 'rsync', 'scanner', 'scheduler', 'seed',
        'sleeper', 'state', 'temporary', 'threading', 'volodyslavDailyTasks',
        'wifiChecker', 'writer',
    ].sort());
});

test('passing a source-looking object cannot extend the capability surface', () => {
    const keys = Object.keys(make({
        cohortBootstrapSource: { queryCanonicalBootstrap() { return null; } },
        installationRecoverySource: { queryInstallationRecovery() { return null; } },
    }));
    expect(keys).toEqual(Object.keys(make()));
});
