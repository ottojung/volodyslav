/**
 * Tests for the membership guard on the sublevel value-encoding table.
 *
 * `sublevel_encoding.js` is the single place that decides how each sublevel's
 * values are encoded. A sublevel declared with a name the table does not list
 * would be encoded by whatever the code happens to do by default rather than by
 * a decision anyone recorded, so every declaration goes through
 * `declaredValueEncodingForSublevelName`, which refuses such a name.
 *
 * Each test in the byte-level block drives the real declaration site it names
 * and then reads the stored bytes back through the root instance as `buffer`.
 * That is what makes the gate able to object: comparing the table against itself
 * cannot fail, whereas comparing the bytes a live sublevel actually stored can.
 * Every sublevel the table lists is covered by such a test, so replacing any
 * declaration with a literal that disagrees with the table turns these red.
 *
 * The raw-key path keeps its lenient lookup, because judging a raw key's shape
 * is the snapshot layer's job and not this layer's.
 */

const {
    JOURNAL_SUBLEVEL_NAME,
    NAMESPACE_PARENT_VALUE_ENCODING,
    ROOT_VALUE_ENCODING,
    SUBLEVEL_VALUE_ENCODINGS,
    TEXT_VALUE_ENCODING,
    UndeclaredSublevelValueEncodingError,
    declaredValueEncodingForSublevelName,
    encodeRawValue,
    isSublevelValueEncodingError,
    isUndeclaredSublevelValueEncodingError,
    valueEncodingForRawKey,
    valueEncodingForSublevelName,
} = require('../src/generators/incremental_graph/database/sublevel_encoding');
const { getRootDatabase } = require('../src/generators/incremental_graph/database');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

/**
 * @typedef {import('../src/generators/incremental_graph/database/root_database').RootDatabase} RootDatabase
 */

/**
 * Open a fresh root database.
 * @returns {Promise<{ capabilities: object, db: RootDatabase }>}
 */
async function openRootDatabase() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    const db = await getRootDatabase(capabilities);
    return { capabilities, db };
}

/**
 * The bytes one value occupies on disk when the sublevel holding it stores
 * values with the given encoding.
 *
 * @param {'json' | 'utf8'} valueEncoding
 * @param {unknown} value
 * @returns {string}
 */
function storedTextFor(valueEncoding, value) {
    return valueEncoding === TEXT_VALUE_ENCODING ? String(value) : JSON.stringify(value);
}

/**
 * Read every stored byte of one raw key through the root instance.
 *
 * The root instance is the only handle that spans the whole key space, so it is
 * the only place a test can see the bytes a declaration actually produced
 * without going through the declaration itself.
 *
 * @param {RootDatabase} db
 * @param {string} rawKey
 * @returns {Promise<string | undefined>}
 */
async function readStoredText(db, rawKey) {
    for await (const [key, value] of db.db.iterator({ valueEncoding: 'buffer' })) {
        if (String(key) === rawKey) {
            return Buffer.from(value).toString('utf8');
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// The accessor refuses a name the table does not list
// ---------------------------------------------------------------------------

describe('declaring a sublevel whose encoding the table does not list', () => {
    test('refuses a name the table does not list', () => {
        expect(() => declaredValueEncodingForSublevelName('log')).toThrow(
            UndeclaredSublevelValueEncodingError
        );
    });

    test('names the offending sublevel so the fix is a one-line table entry', () => {
        let thrown;
        try {
            declaredValueEncodingForSublevelName('log');
        } catch (error) {
            thrown = error;
        }
        if (!isUndeclaredSublevelValueEncodingError(thrown)) {
            throw new Error(`expected an UndeclaredSublevelValueEncodingError, got ${String(thrown)}`);
        }
        expect(thrown.sublevelName).toBe('log');
        expect(thrown.message).toContain("SUBLEVEL_VALUE_ENCODINGS does not list it");
        expect(thrown.message).toContain("Add 'log' to the table");
    });

    test('refuses a replica name the table does not list', () => {
        // `x` and `y` are listed, so this is the shape a third replica name
        // would take: a parent sublevel nobody recorded an encoding for.
        expect(() => declaredValueEncodingForSublevelName('z')).toThrow(
            UndeclaredSublevelValueEncodingError
        );
    });

    test('returns the recorded encoding for every name the table lists', () => {
        for (const name of Object.keys(SUBLEVEL_VALUE_ENCODINGS)) {
            expect(declaredValueEncodingForSublevelName(name)).toBe(SUBLEVEL_VALUE_ENCODINGS[name]);
        }
    });

    test('refuses every own member of Object.prototype, not only unlisted names', () => {
        // `constructor`, `toString` and the rest are properties of every object,
        // so reading the table without an own-property test answers for them.
        // Such an answer is a function, and a function handed to abstract-level as
        // a value encoding fails there with a message about `encoding` rather than
        // with this layer's diagnosis.
        for (const name of Object.getOwnPropertyNames(Object.prototype)) {
            expect(() => declaredValueEncodingForSublevelName(name)).toThrow(
                UndeclaredSublevelValueEncodingError
            );
        }
    });

    test('the staging namespace parent records the same encoding the fixed-name parents do', () => {
        // The staging namespace's name is fixed, so it is a key of the table.
        // Its recorded encoding still has to be the one the table gives the
        // fixed-name replica parents, or the two namespace kinds would disagree
        // about how the same key range is stored.
        for (const parent of ['x', 'y', 'sync_staging']) {
            expect(SUBLEVEL_VALUE_ENCODINGS[parent]).toBe(NAMESPACE_PARENT_VALUE_ENCODING);
        }
    });
});

// ---------------------------------------------------------------------------
// What the live declarations actually stored
// ---------------------------------------------------------------------------

describe('the encoding each live sublevel declaration actually stored', () => {
    /** @type {RootDatabase} */
    let db;

    beforeEach(async () => { ({ db } = await openRootDatabase()); });
    afterEach(async () => { await db.close(); });

    test('the replica pointer is stored with the encoding the table records for _meta', async () => {
        // `makeRootDatabase` wrote this during open, through the `_meta`
        // declaration in `get_root_database`'s caller.
        expect(await readStoredText(db, '!_meta!current_replica')).toBe(
            storedTextFor(SUBLEVEL_VALUE_ENCODINGS._meta, 'x')
        );
    });

    test('a global entry is stored with the encoding the table records for global', async () => {
        const storage = db.getSchemaStorage();
        await storage.global.put('version', '3');
        expect(await readStoredText(db, '!x!!global!version')).toBe(
            storedTextFor(SUBLEVEL_VALUE_ENCODINGS.global, '3')
        );
    });

    test('a computed value is stored with the encoding the table records for values', async () => {
        const storage = db.getSchemaStorage();
        await storage.values.put('all_events', { type: 'all_events', events: [] });
        expect(await readStoredText(db, '!x!!values!all_events')).toBe(
            storedTextFor(SUBLEVEL_VALUE_ENCODINGS.values, { type: 'all_events', events: [] })
        );
    });

    test('a Journal record is stored with the encoding the table records for journal', async () => {
        const storage = db.getSchemaStorage();
        await storage.journal.put('state', '{"localWriter":"qai1"}');
        // A JSON-declared journal would have wrapped this in quotes and escaped
        // it. The bare text is the whole point of the entry.
        expect(await readStoredText(db, `!x!!${JOURNAL_SUBLEVEL_NAME}!state`)).toBe(
            storedTextFor(SUBLEVEL_VALUE_ENCODINGS[JOURNAL_SUBLEVEL_NAME], '{"localWriter":"qai1"}')
        );
    });

    test('a Journal occurrence id is stored as bare text, which is not JSON at all', async () => {
        const storage = db.getSchemaStorage();
        await storage.journal.put('occurrence|{"head":"all_events","args":[]}', 'qai1:1');
        expect(
            await readStoredText(db, `!x!!${JOURNAL_SUBLEVEL_NAME}!occurrence|{"head":"all_events","args":[]}`)
        ).toBe('qai1:1');
    });

    test('a replica freshness entry is stored as JSON text, which the table records for freshness', async () => {
        const storage = db.getSchemaStorage();
        await storage.freshness.put('head', { fresh: true });
        expect(await readStoredText(db, '!x!!freshness!head')).toBe(
            '{"fresh":true}'
        );
    });

    test('a staging freshness entry is stored as JSON text, which the table records for freshness', async () => {
        // Pinned against a literal rather than against `SUBLEVEL_VALUE_ENCODINGS`,
        // so that the declaration and the table entry cannot drift together and
        // leave a text-encoded object stored as `"[object Object]"` with this file
        // green.
        const staging = db.syncStagingStorage();
        await staging.freshness.put('head', { fresh: true });
        expect(await readStoredText(db, '!sync_staging!!freshness!head')).toBe(
            '{"fresh":true}'
        );
    });

    test('a staging valid entry is stored as JSON text, which the table records for valid', async () => {
        const staging = db.syncStagingStorage();
        await staging.valid.put('head', ['node|1']);
        expect(await readStoredText(db, '!sync_staging!!valid!head')).toBe(
            '["node|1"]'
        );
    });

    test('a staging timestamps entry is stored as JSON text, which the table records for timestamps', async () => {
        const staging = db.syncStagingStorage();
        await staging.timestamps.put('head', { inserted: 7 });
        expect(await readStoredText(db, '!sync_staging!!timestamps!head')).toBe(
            '{"inserted":7}'
        );
    });

    test('a staging Journal record is stored as bare text, which the table records for journal', async () => {
        // A JSON-declared journal would have wrapped this in quotes and escaped
        // it, which is the corruption this table exists to prevent.
        const staging = db.syncStagingStorage();
        await staging.journal.put('state', '{"localWriter":"qai1"}');
        expect(await readStoredText(db, '!sync_staging!!journal!state')).toBe(
            '{"localWriter":"qai1"}'
        );
    });

    test('a hostname staging entry is stored with the encoding the table records for its sublevel', async () => {
        const staging = db.syncStagingStorage();
        await staging.global.put('version', '3');
        expect(await readStoredText(db, '!sync_staging!!global!version')).toBe(
            storedTextFor(SUBLEVEL_VALUE_ENCODINGS.global, '3')
        );
    });

    test('the same sublevel name is stored identically in a replica and in a staging namespace', async () => {
        // Both namespaces are built by the same declarations, so a name listed in
        // the table has to mean one encoding in both. If a staging declaration
        // ever stopped consulting the table, these two would disagree.
        await db.getSchemaStorage().values.put('head', { n: 1 });
        await db.syncStagingStorage().values.put('head', { n: 1 });
        expect(await readStoredText(db, '!x!!values!head')).toBe(
            await readStoredText(db, '!sync_staging!!values!head')
        );
    });
});

// ---------------------------------------------------------------------------
// The lenient raw-key lookup
// ---------------------------------------------------------------------------

describe('the lenient raw-key lookup', () => {
    test('falls back to the root encoding for a name the table does not list', () => {
        // A raw key's shape is the snapshot layer's to judge. This key is
        // malformed, and the storage layer has to store it anyway so that
        // `encoding.js` can reject it at render time with its own diagnosis.
        expect(valueEncodingForRawKey('!x!!values')).toBe(ROOT_VALUE_ENCODING);
    });

    test('reads the innermost name of a malformed key rather than judging the key', () => {
        // `!!` escapes the following `!`, so `values` here is key content and the
        // innermost sublevel name is `x`.
        expect(valueEncodingForSublevelName('x')).toBe('json');
        expect(valueEncodingForSublevelName('not_a_sublevel')).toBe(ROOT_VALUE_ENCODING);
    });

    test('still resolves a listed name through the raw key path', () => {
        expect(valueEncodingForRawKey(`!x!!${JOURNAL_SUBLEVEL_NAME}!state`)).toBe(TEXT_VALUE_ENCODING);
        expect(valueEncodingForRawKey('!x!!values!head')).toBe('json');
        expect(valueEncodingForRawKey('!_meta!current_replica')).toBe('json');
    });

    test('refuses a non-text value under a text-valued sublevel', () => {
        let thrown;
        try {
            encodeRawValue(`!x!!${JOURNAL_SUBLEVEL_NAME}!state`, { id: 'qai1:1' });
        } catch (error) {
            thrown = error;
        }
        if (!isSublevelValueEncodingError(thrown)) {
            throw new Error(`expected a SublevelValueEncodingError, got ${String(thrown)}`);
        }
        expect(thrown.valueEncoding).toBe(TEXT_VALUE_ENCODING);
    });

    test('falls back to the root encoding for a name the table inherits from Object.prototype', () => {
        // The lenient path must not resolve an inherited name to a function
        // either. This is the name a snapshot directory can supply: a snapshot
        // holding `constructor/anything` reaches the raw key `!x!!constructor!anything`.
        for (const name of Object.getOwnPropertyNames(Object.prototype)) {
            expect(valueEncodingForRawKey(`!x!!${name}!anything`)).toBe(ROOT_VALUE_ENCODING);
        }
        const encoded = encodeRawValue('!x!!constructor!anything', { n: 1 });
        expect(encoded.valueEncoding).toBe(ROOT_VALUE_ENCODING);
        expect(encoded.value).toEqual({ n: 1 });
    });

    test('accepts a text value under a text-valued sublevel', () => {
        const { valueEncoding, value } = encodeRawValue(`!x!!${JOURNAL_SUBLEVEL_NAME}!state`, 'qai1:1');
        expect(valueEncoding).toBe(TEXT_VALUE_ENCODING);
        expect(value).toBe('qai1:1');
    });
});