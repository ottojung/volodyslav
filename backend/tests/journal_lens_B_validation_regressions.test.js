
const { isNodeIdentifier } = require('../src/generators/incremental_graph/journal/record_fields');
const { isJournalSourceReadError, makeJournalAuthor } = require('../src/generators/incremental_graph/journal');
const { stringToJournalText } = require('../src/generators/incremental_graph/database');
const {
    deserializeWriterState,
    makeInitialCommittedWriterState,
    readCommittedWriterState,
    serializeWriterState,
} = require('../src/generators/incremental_graph/journal_store');

const FINGERPRINT = 'testfingerprnt';

test('journal codec rejects noncanonical leading-zero allocator identifiers', () => {
    expect(isNodeIdentifier('0-' + FINGERPRINT)).toBe(true);
    expect(isNodeIdentifier('1-' + FINGERPRINT)).toBe(true);
    expect(isNodeIdentifier('01-' + FINGERPRINT)).toBe(false);
    expect(isNodeIdentifier('00-' + FINGERPRINT)).toBe(false);
});

test('negative committed allocator watermark is rejected as a JournalSourceReadError', () => {
    const state = makeInitialCommittedWriterState(makeJournalAuthor(FINGERPRINT));
    if (state instanceof Error) throw state;
    const persisted = serializeWriterState(state);
    persisted.allocatorWatermark = -1;
    const result = deserializeWriterState(persisted, FINGERPRINT);
    expect(isJournalSourceReadError(result)).toBe(true);
});

test('malformed stored Journal writer state returns typed read failure, not raw SyntaxError', async () => {
    const journalSublevel = {
        async get() {
            return stringToJournalText('{not valid JSON');
        },
    };
    const result = await readCommittedWriterState(journalSublevel, FINGERPRINT);
    expect(isJournalSourceReadError(result)).toBe(true);
});
