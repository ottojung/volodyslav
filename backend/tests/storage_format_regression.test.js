const {
    getRootDatabase,
    nodeIdentifierFromString,
} = require('../src/generators/incremental_graph/database');
const { getMockedRootCapabilities } = require('./spies');
const { stubEnvironment, stubLogger } = require('./stubs');
const eventId = require('../src/event/id');
const { persistedEvent } = require('../src/generators/individual');
const { computeEntryDescription } = require('../src/generators/individual/entry_description/compute');

function capabilities() {
    const result = getMockedRootCapabilities();
    stubEnvironment(result);
    stubLogger(result);
    return result;
}

function event() {
    return {
        id: eventId.fromString('event-1'),
        date: '2024-01-02',
        original: 'test example',
        input: 'test example',
        creator: { name: 'test' },
    };
}

describe('journal-1 storage format', () => {
    test('raw and hostname imports physically store ComputedValues without an envelope', async () => {
        const db = await getRootDatabase(capabilities());
        const first = { type: 'example', x: 1 };
        const second = { type: 'example', x: 2 };
        const third = { type: 'example', x: 3 };
        const fourth = { type: 'example', x: 4 };
        const typedIdentifier = nodeIdentifierFromString('1-abcdefghijklmnop');
        await db._rawPut('!x!!values!first', first);
        await db._rawPutAll([{ key: '!x!!values!second', value: second }]);
        await db._rawPutAllToHostname('host', [
            { sublevelName: 'values', subkey: 'third', value: third },
        ]);
        await db.schemaStorageForReplica('x').values.put(typedIdentifier, fourth);

        const physical = new Map();
        for await (const [key, value] of db.db.iterator()) physical.set(String(key), value);
        expect(physical.get('!x!!values!first')).toEqual(first);
        expect(physical.get('!x!!values!second')).toEqual(second);
        expect(physical.get('!_h_host!!values!third')).toEqual(third);
        expect(physical.get(`!x!!values!${typedIdentifier}`)).toEqual(fourth);
        await db.close();
    });

    test('event-bearing values retain the Event JSON shape', () => {
        const richEvent = event();
        const persisted = persistedEvent.eventToPersistedEvent(richEvent);
        const expectedMeta = { type: 'meta_events', meta_events: [{ action: 'add', event: richEvent }] };
        const actualMeta = { type: 'meta_events', meta_events: [{ action: 'add', event: persisted }] };
        const expectedContext = { type: 'event_context', contexts: [{ eventId: 'event-1', context: [richEvent] }] };
        const actualContext = { type: 'event_context', contexts: [{ eventId: 'event-1', context: [persisted] }] };
        const transcription = { text: 'hello' };
        const expectedTranscription = { type: 'event_transcription', event: richEvent, transcription };
        const actualTranscription = { type: 'event_transcription', event: persisted, transcription };

        expect(JSON.stringify(actualMeta)).toBe(JSON.stringify(expectedMeta));
        expect(JSON.stringify(actualContext)).toBe(JSON.stringify(expectedContext));
        expect(JSON.stringify(actualTranscription)).toBe(JSON.stringify(expectedTranscription));
        expect(persisted.id).toEqual({ identifier: 'event-1' });
    });

    test('missing entry descriptions retain the omitted-property JSON shape', () => {
        const result = computeEntryDescription({ ...event(), input: 'meal lunch' });
        expect(result).toEqual({ type: 'entry_description' });
        expect(JSON.stringify(result)).toBe('{"type":"entry_description"}');
    });
});
