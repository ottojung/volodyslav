// Mock environment exports to avoid real env dependencies
jest.mock('../src/environment', () => ({
  openaiAPIKey: jest.fn().mockReturnValue('test-key'),
  myRoot: jest.fn().mockReturnValue(__dirname),
  myServerPort: jest.fn().mockReturnValue(0),
}));
const request = require('supertest');
const app = require('../src/index');

describe('GET /api/ping', () => {
  it('responds with pong', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('pong');
  });
});
