// Mock environment exports to avoid real env dependencies
jest.mock('../src/environment', () => {
    const path = require('path');
    return {
        openaiAPIKey: jest.fn().mockReturnValue('test-key'),
        resultsDirectory: jest.fn().mockReturnValue(path.join(__dirname, 'tmp')),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("silent"),
    };
});

const request = require('supertest');
const app = require('../src/index');

describe('GET /api', () => {
  it('responds with Hello World!', async () => {
    const res = await request(app).get('/api');
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('Hello World!');
  });

  it('returns text/html content type', async () => {
    const res = await request(app).get('/api');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('handles HEAD request', async () => {
    const res = await request(app).head('/api');
    expect(res.statusCode).toBe(200);
  });

  it('handles invalid HTTP method', async () => {
    const res = await request(app).put('/api');
    expect(res.statusCode).toBe(404);
  });
});
