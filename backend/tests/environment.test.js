const { make } = require('../src/environment');

describe('myServerPort', () => {
  const original = process.env.VOLODYSLAV_SERVER_PORT;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.VOLODYSLAV_SERVER_PORT;
    } else {
      process.env.VOLODYSLAV_SERVER_PORT = original;
    }
  });

  it('throws on non-numeric characters', () => {
    process.env.VOLODYSLAV_SERVER_PORT = '123abc';
    const env = make();
    expect(() => env.myServerPort()).toThrow('VOLODYSLAV_SERVER_PORT');
  });

  it('allows "0" as a valid port', () => {
    process.env.VOLODYSLAV_SERVER_PORT = '0';
    const env = make();
    expect(env.myServerPort()).toBe(0);
  });

  it('throws on empty string', () => {
    process.env.VOLODYSLAV_SERVER_PORT = '';
    const env = make();
    expect(() => env.myServerPort()).toThrow('VOLODYSLAV_SERVER_PORT');
  });
});

describe('logFile', () => {
  const original = process.env.VOLODYSLAV_LOG_FILE;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.VOLODYSLAV_LOG_FILE;
    } else {
      process.env.VOLODYSLAV_LOG_FILE = original;
    }
  });

  it('returns empty string without throwing', () => {
    process.env.VOLODYSLAV_LOG_FILE = '';
    const env = make();
    expect(env.logFile()).toBe('');
  });
});
