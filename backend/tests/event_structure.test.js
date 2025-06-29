const event = require('../src/event/structure');

describe('event.tryDeserialize', () => {
  it('returns error object when modifiers is not an object', () => {
    const obj = {
      id: 'abc',
      date: '2025-01-01T00:00:00.000Z',
      original: 'o',
      input: 'i',
      type: 't',
      description: 'd',
      creator: { name: 'n', uuid: 'u', version: 'v' },
      modifiers: 0
    };
    const result = event.tryDeserialize(obj);
    expect(event.isInvalidTypeError(result)).toBe(true);
    expect(result.message).toContain("Invalid type for field 'modifiers'");
    expect(result.field).toBe('modifiers');
    expect(result.value).toBe(0);
    expect(result.expectedType).toBe('object');
  });
});
