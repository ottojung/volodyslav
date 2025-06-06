const event = require('../src/event/structure');

describe('event.tryDeserialize', () => {
  it('returns null when modifiers is not an object', () => {
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
    expect(event.tryDeserialize(obj)).toBeNull();
  });
});
