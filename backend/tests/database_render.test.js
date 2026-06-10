const {
    keyToRelativePath,
    relativePathToKey,
} = require('../src/generators/incremental_graph/database');

describe('keyToRelativePath()', () => {
    test('namespace global version key', () => {
        expect(keyToRelativePath('!x!!global!version')).toBe('x/global/version');
    });

    test('identifier key is emitted as a single segment', () => {
        expect(keyToRelativePath('!x!!values!all_events')).toBe('x/values/all_events');
    });

    test('identifier keys can include slash-like logical segments', () => {
        expect(keyToRelativePath('!x!!values!event/abc123')).toBe('x/values/event%2Fabc123');
    });

    test('identifier keys percent-encode slash characters', () => {
        expect(keyToRelativePath('!x!!values!transcription//audio/file.mp3')).toBe(
            'x/values/transcription%2F%2Faudio%2Ffile.mp3'
        );
    });

    test('identifier keys escape bang characters', () => {
        expect(keyToRelativePath('!x!!values!a!b')).toBe('x/values/a%21b');
    });

    test('identifier keys keep repeated bang characters', () => {
        expect(keyToRelativePath('!x!!values!a!!b')).toBe('x/values/a%21%21b');
    });

    test('identifier keys encode percent literals', () => {
        expect(keyToRelativePath('!x!!values!50%off')).toBe('x/values/50%25off');
    });

    test('dot segments are escaped so they remain literal path values', () => {
        expect(keyToRelativePath('!x!!values!.')).toBe('x/values/%2E');
        expect(keyToRelativePath('!x!!values!..')).toBe('x/values/%2E%2E');
        expect(keyToRelativePath('!_meta!..')).toBe('_meta/%2E%2E');
    });

    test('identifier keys preserve leading "~" as ordinary content', () => {
        expect(keyToRelativePath('!x!!values!~42')).toBe('x/values/~42');
    });

    test('slash-containing identifier keys are encoded as one path segment', () => {
        expect(keyToRelativePath('!x!!values!event_transcription/evtId//audio/x.mp3')).toBe(
            'x/values/event_transcription%2FevtId%2F%2Faudio%2Fx.mp3'
        );
    });

    test('numeric-looking identifier keys remain plain identifier strings', () => {
        expect(keyToRelativePath('!x!!values!42')).toBe('x/values/42');
    });

    test('freshness sublevel is identifier-native too', () => {
        expect(keyToRelativePath('!x!!freshness!all_events')).toBe('x/freshness/all_events');
    });

    test('JSON-like identifier content is encoded literally', () => {
        expect(keyToRelativePath('!x!!values!~{"nested":["x",1]}')).toBe(
            'x/values/~{"nested":["x",1]}'
        );
    });

    test('identifier sublevels accept non-JSON content as valid identifiers', () => {
        expect(keyToRelativePath('!x!!values!not-json')).toBe('x/values/not-json');
    });

    test('throws for raw keys without the required leading "!"', () => {
        expect(() => keyToRelativePath('x!!values!{"head":"event","args":[]}')).toThrow(
            "expected raw LevelDB keys to start with '!'"
        );
    });

    test('throws for raw keys missing the separator before key content', () => {
        expect(() => keyToRelativePath('!x!!values')).toThrow(
            "expected a '!' separator before key content"
        );
    });

    test('throws for raw keys with empty sublevel names', () => {
        expect(() => keyToRelativePath('!x!!!!values!{"head":"event","args":[]}')).toThrow(
            'sublevel names must not be empty'
        );
    });
});

// ---------------------------------------------------------------------------
// relativePathToKey() — unit tests
// ---------------------------------------------------------------------------

describe('relativePathToKey()', () => {
    test('namespace global version', () => {
        expect(relativePathToKey('x/global/version')).toBe('!x!!global!version');
    });

    test('relative identifier path decodes to identifier key', () => {
        expect(relativePathToKey('x/values/all_events')).toBe('!x!!values!all_events');
    });

    test('decodes slash escapes in identifier keys', () => {
        expect(relativePathToKey('x/values/transcription%2F%2Faudio%2Ffile.mp3')).toBe(
            '!x!!values!transcription//audio/file.mp3'
        );
    });

    test('identifier path decoding restores bang characters', () => {
        expect(relativePathToKey('x/values/a%21b')).toBe('!x!!values!a!b');
    });

    test('decodes repeated bang escapes in identifier keys', () => {
        expect(relativePathToKey('x/values/a%21%21b')).toBe('!x!!values!a!!b');
    });

    test('decodes percent escapes in identifier keys', () => {
        expect(relativePathToKey('x/values/50%25off')).toBe('!x!!values!50%off');
    });

    test('decodes escaped dot segments back to literal "." and ".."', () => {
        expect(relativePathToKey('x/values/%2E')).toBe('!x!!values!.');
        expect(relativePathToKey('x/values/%2E%2E')).toBe('!x!!values!..');
        expect(relativePathToKey('_meta/%2E%2E')).toBe('!_meta!..');
    });

    test('tilde-prefixed identifiers remain strings', () => {
        expect(relativePathToKey('x/values/~42')).toBe('!x!!values!~42');
    });

    test('double-tilde content is preserved literally', () => {
        expect(relativePathToKey('x/values/~~42')).toBe('!x!!values!~~42');
    });

    test('JSON-like identifier segments decode literally', () => {
        expect(relativePathToKey('x/values/~true')).toBe('!x!!values!~true');
        expect(relativePathToKey('x/values/~{"nested":["x",1]}')).toBe(
            '!x!!values!~{"nested":["x",1]}'
        );
    });

    test('throws for fewer than two segments', () => {
        expect(() => relativePathToKey('onlyone')).toThrow();
        expect(() => relativePathToKey('')).toThrow();
    });

    test('throws when paths have extra key segments', () => {
        expect(() => relativePathToKey('_meta/current_replica/extra')).toThrow(
            'expected exactly one key segment'
        );
        expect(() => relativePathToKey('x/global/version/extra')).toThrow(
            'expected exactly one key segment'
        );
        expect(() => relativePathToKey('x/values/a/b')).toThrow(
            'expected exactly one key segment'
        );
    });
});

// ---------------------------------------------------------------------------
// Bijection: keyToRelativePath ∘ relativePathToKey = id
// ---------------------------------------------------------------------------

describe('keyToRelativePath / relativePathToKey bijection', () => {
    const testKeys = [
        '!_meta!current_replica',
        '!x!!global!version',
        '!x!!values!{"head":"all_events","args":[]}',
        '!x!!freshness!{"head":"all_events","args":[]}',
        '!x!!inputs!{"head":"event","args":["abc123"]}',
        '!x!!revdeps!{"head":"event","args":["abc123"]}',
        '!x!!counters!{"head":"all_events","args":[]}',
        '!x!!timestamps!{"head":"all_events","args":[]}',
        '!x!!values!{"head":"transcription","args":["/path/to/audio.mp3"]}',
        '!x!!values!{"head":"event","args":["id/with/slashes"]}',
        '!x!!values!{"head":"event","args":["a!b"]}',
        '!x!!values!{"head":"event","args":["a!!b"]}',
        '!x!!values!{"head":"event","args":["50%off"]}',
        '!x!!values!{"head":"event","args":["~42"]}',
        '!x!!values!{"head":"event","args":[42]}',
        '!x!!values!{"head":"event_transcription","args":["evtId","/audio/x.mp3"]}',
        '!y!!values!{"head":"all_events","args":[]}',
        '!y!!global!version',
    ];

    for (const key of testKeys) {
        test(`round-trips correctly: ${key}`, () => {
            const rel = keyToRelativePath(key);
            const restored = relativePathToKey(rel);
            expect(restored).toBe(key);
        });
    }

    test('distinct keys produce distinct paths', () => {
        const paths = testKeys.map(keyToRelativePath);
        const uniquePaths = new Set(paths);
        expect(uniquePaths.size).toBe(testKeys.length);
    });

    test('string "~42" and number 42 map to distinct paths', () => {
        expect(
            keyToRelativePath('!x!!values!{"head":"event","args":["~42"]}')
        ).not.toBe(
            keyToRelativePath('!x!!values!{"head":"event","args":[42]}')
        );
    });

    test('dot-segment sentinels stay distinct from literal percent-encoded text', () => {
        expect(
            keyToRelativePath('!x!!values!{"head":"event","args":["."]}')
        ).not.toBe(
            keyToRelativePath('!x!!values!{"head":"event","args":["%2E"]}')
        );
        expect(
            keyToRelativePath('!x!!values!{"head":"event","args":[".."]}')
        ).not.toBe(
            keyToRelativePath('!x!!values!{"head":"event","args":["%2E%2E"]}')
        );
    });

    test('empty identifier keys round-trip via a dedicated sentinel', () => {
        const key = '!x!!values!';
        const rel = keyToRelativePath(key);
        expect(rel).toBe('x/values/%00');
        expect(relativePathToKey(rel)).toBe(key);
    });
});

// ---------------------------------------------------------------------------
// renderToFilesystem
// ---------------------------------------------------------------------------

