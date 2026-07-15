/**
 * Unit tests for compareIsoTimestamps.
 *
 * Covers:
 *   - undefined semantics
 *   - plain UTC timestamps
 *   - mixed-offset timestamps (the regression: lexicographic vs chronological)
 *   - equal instants with different textual offsets
 *   - invalid timestamp rejection
 */

const {
    compareIsoTimestamps,
    InvalidIsoTimestampError,
    isInvalidIsoTimestampError,
} = require('../src/generators/incremental_graph/database/sync_merge_timestamps');

describe('compareIsoTimestamps', () => {
    describe('undefined handling', () => {
        test('both undefined returns 0', () => {
            expect(compareIsoTimestamps(undefined, undefined)).toBe(0);
        });

        test('left undefined returns -1', () => {
            expect(compareIsoTimestamps(undefined, '2026-01-01T00:00:00.000Z')).toBe(-1);
        });

        test('right undefined returns 1', () => {
            expect(compareIsoTimestamps('2026-01-01T00:00:00.000Z', undefined)).toBe(1);
        });
    });

    describe('plain UTC timestamps', () => {
        test('equal timestamps return 0', () => {
            expect(compareIsoTimestamps(
                '2026-01-01T00:00:00.000Z',
                '2026-01-01T00:00:00.000Z'
            )).toBe(0);
        });

        test('earlier first returns -1', () => {
            expect(compareIsoTimestamps(
                '2026-01-01T00:00:00.000Z',
                '2026-01-02T00:00:00.000Z'
            )).toBe(-1);
        });

        test('later first returns 1', () => {
            expect(compareIsoTimestamps(
                '2026-01-02T00:00:00.000Z',
                '2026-01-01T00:00:00.000Z'
            )).toBe(1);
        });
    });

    describe('mixed-offset timestamps (the regression)', () => {
        test('chronologically newer but lexicographically smaller returns 1', () => {
            // A = 2026-07-05T22:17:49.554-07:00 → 2026-07-06T05:17:49.554Z
            // B = 2026-07-06T02:00:11.707Z
            // Chronologically A > B, but lexicographically A < B
            const result = compareIsoTimestamps(
                '2026-07-05T22:17:49.554-07:00',
                '2026-07-06T02:00:11.707Z'
            );
            expect(result).toBeGreaterThan(0);
        });

        test('reverse ordering returns -1', () => {
            const result = compareIsoTimestamps(
                '2026-07-06T02:00:11.707Z',
                '2026-07-05T22:17:49.554-07:00'
            );
            expect(result).toBeLessThan(0);
        });

        test('equal instants with different textual offsets return 0', () => {
            const result = compareIsoTimestamps(
                '2026-07-06T05:17:49.554Z',
                '2026-07-05T22:17:49.554-07:00'
            );
            expect(result).toBe(0);
        });

        test('positive offset vs UTC', () => {
            // +03:00 means 3 hours ahead of UTC
            // 2026-07-06T05:00:00.000+03:00 = 2026-07-06T02:00:00.000Z
            expect(compareIsoTimestamps(
                '2026-07-06T05:00:00.000+03:00',
                '2026-07-06T03:00:00.000Z'
            )).toBeLessThan(0);
        });
    });

    describe('invalid timestamps', () => {
        test('throws InvalidIsoTimestampError for unparseable string', () => {
            expect(() => compareIsoTimestamps('not-a-timestamp', '2026-01-01T00:00:00.000Z'))
                .toThrow(InvalidIsoTimestampError);
        });

        test('throws InvalidIsoTimestampError for string that Date.parse cannot handle', () => {
            expect(() => compareIsoTimestamps('2026-01-01T00:00:00.000Z', ''))
                .toThrow(InvalidIsoTimestampError);
        });

        test('isInvalidIsoTimestampError correctly identifies the error', () => {
            const err = new InvalidIsoTimestampError('test', 'value');
            expect(isInvalidIsoTimestampError(err)).toBe(true);
            expect(isInvalidIsoTimestampError(new Error('other'))).toBe(false);
            expect(isInvalidIsoTimestampError(null)).toBe(false);
        });
    });
});
