const event = require('../src/event/structure');

describe('event.tryDeserialize', () => {
  it('returns error object when required field is missing', () => {
    const obj = {
      id: 'abc',
      date: '2025-01-01T00:00:00.000Z',
      original: 'o',
      creator: { name: 'n', uuid: 'u', version: 'v', hostname: 'test-host' },
    };
    const result = event.tryDeserialize(obj);
    expect(event.isMissingFieldError(result)).toBe(true);
    expect(result.field).toBe('input');
  });
});
