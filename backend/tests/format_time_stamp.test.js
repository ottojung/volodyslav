const { formatFileTimestamp } = require('../src/format_time_stamp');
const { toNativeDate, toISOString } = require('../src/datetime');

describe('formatFileTimestamp', () => {
  it('returns a Date object for valid filename', () => {
    const filename = '20250503T203813Z.txt';
    const dt = require('../src/datetime').make();
    const date = formatFileTimestamp(filename, dt);
    expect(toNativeDate(date)).toBeInstanceOf(Date);
    expect(toISOString(date)).toBe('2025-05-03T20:38:13.000Z');
  });

  it('handles midnight UTC correctly', () => {
    const filename = '20200101T000000Z.txt';
    const dt = require('../src/datetime').make();
    const date = formatFileTimestamp(filename, dt);
    expect(toISOString(date)).toBe('2020-01-01T00:00:00.000Z');
  });

  it('throws an error for filename without valid prefix', async () => {
    const dt = require('../src/datetime').make();
    await expect(async () => formatFileTimestamp('invalidfile.txt', dt)).rejects.toThrow(
      'Filename "invalidfile.txt" does not start with YYYYMMDDThhmmssZ'
    );
  });

  it('throws an error for invalid calendar date', async () => {
    const dt = require('../src/datetime').make();
    await expect(async () =>
      formatFileTimestamp('20250230T000000Z.txt', dt)
    ).rejects.toThrow('Failed to parse valid Date from timestamp string: 20250230T000000Z');
  });
});
