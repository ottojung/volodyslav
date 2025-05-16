const { formatFileTimestamp } = require('../src/format_time_stamp');

describe('formatFileTimestamp', () => {
  it('returns a Date object for valid filename', () => {
    const filename = '20250503T203813Z.txt';
    const date = formatFileTimestamp(filename);
    expect(date).toBeInstanceOf(Date);
    expect(date.toISOString()).toBe('2025-05-03T20:38:13.000Z');
  });

  it('handles midnight UTC correctly', () => {
    const filename = '20200101T000000Z.txt';
    const date = formatFileTimestamp(filename);
    expect(date.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('throws an error for filename without valid prefix', async () => {
    await expect(async () => formatFileTimestamp('invalidfile.txt')).rejects.toThrow(
      'Filename "invalidfile.txt" does not start with YYYYMMDDThhmmssZ'
    );
  });
});
