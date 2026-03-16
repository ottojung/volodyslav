const event = require('../src/event/structure');

const validObj = {
  id: 'abc',
  date: '2025-01-01T00:00:00.000Z',
  original: 'o',
  input: 'i',
  creator: { name: 'n', uuid: 'u', version: 'v', hostname: 'test-host' },
};

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

  it('succeeds for a valid object', () => {
    const result = event.tryDeserialize(validObj);
    expect(event.isTryDeserializeError(result)).toBe(false);
  });

  it('returns error for unrecognized top-level field', () => {
    const obj = { ...validObj, extraField: 'unexpected' };
    const result = event.tryDeserialize(obj);
    expect(event.isUnrecognizedFieldError(result)).toBe(true);
    expect(result.field).toBe('extraField');
  });

  it('returns error for unrecognized creator field', () => {
    const obj = {
      ...validObj,
      creator: { ...validObj.creator, extraCreatorField: 'unexpected' },
    };
    const result = event.tryDeserialize(obj);
    expect(event.isUnrecognizedFieldError(result)).toBe(true);
    expect(result.field).toBe('creator.extraCreatorField');
  });

  it('returns error for non-object input', () => {
    const result = event.tryDeserialize(null);
    expect(event.isInvalidStructureError(result)).toBe(true);
  });

  it('returns error for array input', () => {
    const result = event.tryDeserialize([]);
    expect(event.isInvalidStructureError(result)).toBe(true);
  });

  it('returns error when id is not a string', () => {
    const obj = { ...validObj, id: 123 };
    const result = event.tryDeserialize(obj);
    expect(event.isInvalidTypeError(result)).toBe(true);
    expect(result.field).toBe('id');
  });

  it('returns error when date is invalid', () => {
    const obj = { ...validObj, date: 'not-a-date' };
    const result = event.tryDeserialize(obj);
    expect(event.isInvalidValueError(result)).toBe(true);
    expect(result.field).toBe('date');
  });

  it('returns error when creator is missing required field', () => {
    const creatorWithoutName = {
      uuid: validObj.creator.uuid,
      version: validObj.creator.version,
      hostname: validObj.creator.hostname,
    };
    const obj = { ...validObj, creator: creatorWithoutName };
    const result = event.tryDeserialize(obj);
    expect(event.isNestedFieldError(result)).toBe(true);
    expect(result.field).toBe('creator.name');
  });

  it('returns error when creator field has wrong type', () => {
    const obj = { ...validObj, creator: { ...validObj.creator, name: 42 } };
    const result = event.tryDeserialize(obj);
    expect(event.isNestedFieldError(result)).toBe(true);
    expect(result.field).toBe('creator.name');
  });
});
