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

describe('GET /api/ping', () => {
  it('responds with pong', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('pong');
  });

  it('returns text/html content type', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('handles HEAD request', async () => {
    const res = await request(app).head('/api/ping');
    expect(res.statusCode).toBe(200);
  });

  it('rejects POST requests', async () => {
    const res = await request(app).post('/api/ping');
    expect(res.statusCode).toBe(404);
  });

  it('rejects PUT requests', async () => {
    const res = await request(app).put('/api/ping');
    expect(res.statusCode).toBe(404);
  });

  it('rejects DELETE requests', async () => {
    const res = await request(app).delete('/api/ping');
    expect(res.statusCode).toBe(404);
  });
});
