
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
});
